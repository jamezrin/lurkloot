import { TWITCH_HLS_HEARTBEAT_ID } from "@lurkloot/shared/compatibility";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { HeartbeatResult } from "../../../core/tablessWatch";
import { minuteWatchedFormBody } from "./gql-v1";
import { isAllowedHlsUrl } from "./hosts";
import { playlistUrls } from "./playlist";
import { resolveSpadeDestination } from "./spade";
import type {
  TwitchHeartbeatContext,
  TwitchHeartbeatExchange,
  TwitchHeartbeatFetchText,
  TwitchHeartbeatPost,
  TwitchHeartbeatStrategy,
} from "./types";

export { TWITCH_HLS_HEARTBEAT_ID };
// Inside Twitch's rolling media playlist. The watch alarm is coarser because
// Chrome clamps short alarms; this interval is what requests each new segment.
export const HLS_POLL_INTERVAL_MS = 10_000;
// Successful segment URLs only. Failed ones stay out so the next poll retries
// them, and a long broadcast cannot grow the set without bound.
export const HLS_SEGMENT_CACHE_LIMIT = 256;
// A live playlist lists every segment still in the window. Only the newest
// ones prove the client is at the live edge, and the poll budget cannot cover
// a long window of slow requests.
export const HLS_SEGMENTS_PER_POLL = 6;
// Auxiliary minute-watched telemetry. A 204 does not credit progress, and a
// failure must not be retried on the playlist cadence.
export const HLS_TELEMETRY_INTERVAL_MS = 59_000;
// A failed playback-token request waits this long before the next one, and
// twice as long after each further failure. Without it every 10-second poll
// would ask again, and an integrity rejection would mint a token each time.
export const HLS_TOKEN_RETRY_MS = 60_000;
export const HLS_TOKEN_RETRY_MAX_MS = 10 * 60_000;

const PLAYBACK_ACCESS_TOKEN_QUERY = `query PlaybackAccessToken($login: String!, $playerType: String!) {
  streamPlaybackAccessToken(
    channelName: $login
    params: { platform: "web", playerBackend: "mediaplayer", playerType: $playerType }
  ) {
    value
    signature
  }
}`;

// Playlist and segment work only. Auxiliary telemetry runs after a successful
// watch is decided, so a slow beacon cannot fail progress that was requested.
export const HLS_POLL_BUDGET_MS = 8_000;
const REQUEST_BUDGET_MS = 3_000;
const HLS_REDIRECT_LIMIT = 3;

export interface HlsHeartbeatGql {
  <T>(
    operationName: string,
    sha256Hash: string,
    variables: Record<string, unknown>,
    query?: string,
    credentials?: RequestCredentials,
    emit?: EventEmitter,
    signal?: AbortSignal,
  ): Promise<{ data?: T }>;
}

export interface HlsHeartbeatOptions {
  gql: HlsHeartbeatGql;
  exchange: TwitchHeartbeatExchange;
  fetchText: TwitchHeartbeatFetchText;
  post: TwitchHeartbeatPost;
  log: (level: LogLevel, message: string) => void;
  now?: () => number;
}

interface PlaybackToken {
  value?: string;
  signature?: string;
}

function failed(message: string): HeartbeatResult {
  return { ok: false, live: true, message };
}

// Keep a short English cause. Signed URLs, tokens, and response bodies stay
// out of the diagnostic log.
export function safeHlsFailure(error: unknown, fallback = "Twitch HLS watch failed"): string {
  const message = error instanceof Error ? error.message : "";
  if (message && message.length <= 240 && !/[?#]/.test(message) && !/https?:\/\//i.test(message)) {
    return message;
  }
  return fallback;
}

function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  return AbortSignal.any([left, right]);
}

export function createHlsHeartbeat(options: HlsHeartbeatOptions): TwitchHeartbeatStrategy {
  const now = options.now ?? Date.now;
  let abort = new AbortController();
  let broadcastId: string | undefined;
  let playlistUrl: string | undefined;
  let spadeUrl: string | undefined;
  let spadeChannel: string | undefined;
  let lastTelemetryAt: number | undefined;
  // Consecutive failed attempts to obtain a playable playlist, and when the
  // next attempt may run. Reset by a successful watch or a new broadcast.
  let tokenFailures = 0;
  let tokenRetryAt: number | undefined;
  const seen: string[] = [];

  const remember = (url: string): void => {
    seen.push(url);
    if (seen.length > HLS_SEGMENT_CACHE_LIMIT) seen.splice(0, seen.length - HLS_SEGMENT_CACHE_LIMIT);
  };

  const rejectHost = (): never => {
    playlistUrl = undefined;
    throw new Error("Twitch HLS response came from an unexpected host");
  };

  // Follow hops here so a signed URL is not requested from a host outside the
  // video CDN. Transports must not follow: Chrome hides Location on an opaque
  // redirect, and a missing final URL must not be treated as the request URL.
  const exchange = async (url: string, method: "GET" | "HEAD", signal: AbortSignal) => {
    let current = url;
    if (!isAllowedHlsUrl(current)) rejectHost();
    for (let hop = 0; hop <= HLS_REDIRECT_LIMIT; hop += 1) {
      const response = await options.exchange(current, {
        method,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: combineSignals(signal, AbortSignal.timeout(REQUEST_BUDGET_MS)),
      });
      if (response.status === 301 || response.status === 302 || response.status === 303
        || response.status === 307 || response.status === 308) {
        if (hop === HLS_REDIRECT_LIMIT) throw new Error("Twitch HLS redirect was not followed");
        const location = response.location?.trim();
        let next: string;
        try {
          next = location ? new URL(location, current).href : "";
        } catch {
          next = "";
        }
        if (!isAllowedHlsUrl(next)) {
          // An empty or unparseable Location is not a host we can name.
          if (next) rejectHost();
          throw new Error("Twitch HLS redirect could not be verified");
        }
        current = next;
        continue;
      }
      // Status 0 is the browser's opaque redirect. Location is unreadable, so
      // following it would send the signed URL somewhere unchecked.
      if (response.status === 0) throw new Error("Twitch HLS redirect could not be verified");
      if (!response.url || !isAllowedHlsUrl(response.url)) rejectHost();
      return response;
    }
    throw new Error("Twitch HLS redirect was not followed");
  };

  const acquirePlaylist = async (login: string, signal: AbortSignal): Promise<string | undefined> => {
    const token = await options.gql<{ streamPlaybackAccessToken?: PlaybackToken }>(
      "PlaybackAccessToken",
      "",
      { login, playerType: "site" },
      PLAYBACK_ACCESS_TOKEN_QUERY,
      "include",
      undefined,
      signal,
    );
    const value = token.data?.streamPlaybackAccessToken?.value;
    const signature = token.data?.streamPlaybackAccessToken?.signature;
    if (!value || !signature) return undefined;
    const master = new URL(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`);
    master.searchParams.set("allow_audio_only", "true");
    master.searchParams.set("allow_source", "true");
    master.searchParams.set("sig", signature);
    master.searchParams.set("token", value);
    const response = await exchange(master.href, "GET", signal);
    if (response.status !== 200 || !response.url) return undefined;
    // Resolve relative variants against the URL we actually received, which
    // can be a redirect hop away from the usher request.
    const variants = playlistUrls(response.body, response.url, "master");
    return variants.at(-1);
  };

  const sendTelemetry = async (context: TwitchHeartbeatContext, signal: AbortSignal): Promise<void> => {
    const channel = context.channel.username.trim().toLowerCase();
    const sentAt = lastTelemetryAt;
    if (sentAt !== undefined && now() - sentAt < HLS_TELEMETRY_INTERVAL_MS) return;
    if (signal.aborted) return;
    // Claim the slot before the request so a blocked beacon is not retried
    // on the next 10-second poll.
    lastTelemetryAt = now();
    try {
      if (spadeChannel !== channel) {
        spadeUrl = undefined;
        spadeChannel = channel;
      }
      if (!spadeUrl) {
        const resolved = await resolveSpadeDestination(options.fetchText, context.channel.url, signal);
        if (signal.aborted) return;
        spadeUrl = resolved;
      }
      if (signal.aborted) return;
      if (!spadeUrl) {
        options.log("debug", "Twitch minute-watched beacon has no destination");
        return;
      }
      const response = await options.post(spadeUrl, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal: combineSignals(signal, AbortSignal.timeout(REQUEST_BUDGET_MS)),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: minuteWatchedFormBody({
          broadcastId: context.broadcastId,
          channelId: context.channelId,
          channelLogin: context.channel.username,
          userId: context.userId,
          gameId: context.gameId,
          gameName: context.gameName,
        }),
      });
      if (response.status !== 204) options.log("debug", `Twitch minute-watched beacon returned HTTP ${response.status}`);
    } catch (error) {
      // Playlist success is the watch result. The beacon is auxiliary, so a
      // failure is only noted.
      if (!signal.aborted) {
        options.log("debug", `Twitch minute-watched beacon failed: ${safeHlsFailure(error, "network request failed")}`);
      }
    }
  };

  const tokenRetryPending = (): boolean => tokenRetryAt !== undefined && now() < tokenRetryAt;

  const poll = async (context: TwitchHeartbeatContext): Promise<HeartbeatResult> => {
    const login = context.channel.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(login)) return failed("Twitch HLS watch has no channel login");
    if (broadcastId !== context.broadcastId) {
      broadcastId = context.broadcastId;
      playlistUrl = undefined;
      seen.length = 0;
      lastTelemetryAt = undefined;
      tokenFailures = 0;
      tokenRetryAt = undefined;
    }
    if (!playlistUrl && tokenRetryPending()) {
      return failed("Twitch HLS watch is waiting to request a new playback token");
    }
    // Read once: reset() replaces the controller, and a poll it stopped must
    // keep seeing its own aborted signal.
    const stop = abort.signal;
    const acquiring = !playlistUrl;
    const result = await watch(context, login, stop);
    if (result.ok) {
      tokenFailures = 0;
      tokenRetryAt = undefined;
    } else if (acquiring && !playlistUrl && !stop.aborted) {
      tokenFailures += 1;
      tokenRetryAt = now() + Math.min(HLS_TOKEN_RETRY_MS * 2 ** (tokenFailures - 1), HLS_TOKEN_RETRY_MAX_MS);
    }
    return result;
  };

  const watch = async (context: TwitchHeartbeatContext, login: string, stop: AbortSignal): Promise<HeartbeatResult> => {
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), HLS_POLL_BUDGET_MS);
    const signal = combineSignals(stop, budget.signal);
    // Stopping and running out of budget both abort the requests, but only a
    // stop means the watch is over; a timeout is a failed poll.
    const interrupted = (): HeartbeatResult => failed(stop.aborted ? "Twitch HLS watch stopped" : "Twitch HLS watch timed out");
    let watched = false;
    try {
      if (!playlistUrl) {
        const acquired = await acquirePlaylist(login, signal);
        if (signal.aborted) return interrupted();
        if (!acquired || !isAllowedHlsUrl(acquired)) {
          playlistUrl = undefined;
          return failed("Twitch did not return a playback playlist");
        }
        playlistUrl = acquired;
      }

      const media = await exchange(playlistUrl, "GET", signal);
      if (signal.aborted) return interrupted();
      const mediaBase = media.url;
      if (!mediaBase) return failed("Twitch HLS response came from an unexpected host");
      if (media.status !== 200) {
        if (media.status === 401 || media.status === 403 || media.status === 404) playlistUrl = undefined;
        return failed(`Twitch HLS playlist returned HTTP ${media.status}`);
      }
      const segments = playlistUrls(media.body, mediaBase, "media");
      if (segments.length === 0) {
        playlistUrl = undefined;
        return failed("Twitch HLS playlist was not usable");
      }

      let headed = 0;
      let failure: string | undefined;
      const pending = segments.filter((segment) => !seen.includes(segment));
      const batch = pending.slice(-HLS_SEGMENTS_PER_POLL);
      for (const segment of batch) {
        if (signal.aborted) return interrupted();
        try {
          const response = await exchange(segment, "HEAD", signal);
          if (signal.aborted) return interrupted();
          if (response.status !== 200) {
            if (response.status === 401 || response.status === 403 || response.status === 404) playlistUrl = undefined;
            failure ??= `Twitch HLS segment returned HTTP ${response.status}`;
            continue;
          }
          remember(segment);
          headed += 1;
        } catch (error) {
          if (signal.aborted) return interrupted();
          failure ??= safeHlsFailure(error);
        }
      }
      // One live-edge segment is enough to credit the minute. A sibling that
      // failed stays out of the cache and is retried on the next poll.
      if (batch.length > 0 && headed === 0) return failed(failure ?? "Twitch HLS watch failed");
      if (headed > 0) {
        options.log("debug", `Twitch HLS watch requested ${headed} new segments for ${login}`);
      }
      watched = true;
    } catch (error) {
      if (signal.aborted) return interrupted();
      return failed(safeHlsFailure(error));
    } finally {
      clearTimeout(budgetTimer);
    }
    if (!watched) return failed("Twitch HLS watch failed");
    // The playlist budget is already cleared. A slow beacon cannot fail this
    // minute. Stopping still can: the watch is no longer in progress.
    await sendTelemetry(context, stop);
    if (stop.aborted) return failed("Twitch HLS watch stopped");
    return { ok: true, live: true };
  };

  return {
    id: TWITCH_HLS_HEARTBEAT_ID,
    tick: poll,
    // The same poll between health commits. It waits out a failed token
    // request instead of reporting it again every 10 seconds.
    async sustain(context) {
      if (!playlistUrl && tokenRetryPending()) return undefined;
      return poll(context);
    },
    reset() {
      abort.abort();
      abort = new AbortController();
      broadcastId = undefined;
      playlistUrl = undefined;
      spadeUrl = undefined;
      spadeChannel = undefined;
      lastTelemetryAt = undefined;
      tokenFailures = 0;
      tokenRetryAt = undefined;
      seen.length = 0;
    },
  };
}
