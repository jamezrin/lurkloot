import type { HeartbeatResult } from "../../../core/tablessWatch";
import { minuteWatchedFormBody } from "./gql-v1";
import { isAllowedTwitchUrl } from "./hosts";
import type {
  TwitchHeartbeatContext,
  TwitchHeartbeatFetchText,
  TwitchHeartbeatPost,
  TwitchHeartbeatStrategy,
} from "./types";

export interface SpadeHeartbeatOptions {
  fetchText: TwitchHeartbeatFetchText;
  post: TwitchHeartbeatPost;
}

const AUTHENTICATED_GET: RequestInit = { credentials: "include", redirect: "error" };

function extractStringValue(source: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const match = source.match(new RegExp(`["']${key}["']\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "i"));
    if (!match) continue;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      // Ignore malformed values and continue looking for a usable destination.
    }
  }
  return undefined;
}

function extractSettingsBundle(source: string): string | undefined {
  const scripts = source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi);
  for (const match of scripts) {
    const candidate = match[1];
    if (/settings[^/]*\.js(?:[?#]|$)/i.test(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveSpadeDestination(
  fetchText: TwitchHeartbeatFetchText,
  channelUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!isAllowedTwitchUrl(channelUrl)) return undefined;
  const init: RequestInit = signal ? { ...AUTHENTICATED_GET, signal } : AUTHENTICATED_GET;
  const page = await fetchText(channelUrl, init);
  const inline = extractStringValue(page, ["spade_url", "beacon_url"]);
  if (inline !== undefined && isAllowedTwitchUrl(inline)) return inline;

  const bundleUrl = extractSettingsBundle(page);
  if (!bundleUrl || !isAllowedTwitchUrl(bundleUrl)) return undefined;
  const bundle = await fetchText(bundleUrl, init);
  const bundled = extractStringValue(bundle, ["spade_url", "beacon_url"]);
  return bundled && isAllowedTwitchUrl(bundled) ? bundled : undefined;
}

function failed(message: string): HeartbeatResult {
  return { ok: false, live: true, message };
}

type SpadeSendResult = { ok: true } | { ok: false; message: string };

export function createSpadeHeartbeat(options: SpadeHeartbeatOptions): TwitchHeartbeatStrategy {
  const destinations = new Map<string, string>();

  const resolveDestination = (context: TwitchHeartbeatContext): Promise<string | undefined> =>
    resolveSpadeDestination(options.fetchText, context.channel.url);

  const send = async (destination: string, context: TwitchHeartbeatContext): Promise<SpadeSendResult> => {
    if (!isAllowedTwitchUrl(destination)) return { ok: false, message: "Unsafe Twitch Spade destination" };
    try {
      const response = await options.post(destination, {
        method: "POST",
        credentials: "include",
        redirect: "error",
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
      return response.status === 204
        ? { ok: true }
        : { ok: false, message: `Twitch Spade heartbeat returned HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Twitch Spade heartbeat POST failed",
      };
    }
  };

  return {
    id: "twitch-heartbeat-spade-v1",
    async tick(context: TwitchHeartbeatContext): Promise<HeartbeatResult> {
      const channel = context.channel.username.trim().toLowerCase();
      try {
        const destination = destinations.get(channel) ?? await resolveDestination(context);
        if (!destination) return failed("Unable to resolve a secure Twitch Spade destination");
        destinations.set(channel, destination);
        const first = await send(destination, context);
        if (first.ok) return { ok: true, live: true };

        destinations.delete(channel);
        const refreshed = await resolveDestination(context);
        if (!refreshed) return failed("Unable to refresh the Twitch Spade destination");
        destinations.set(channel, refreshed);
        const second = await send(refreshed, context);
        if (second.ok) return { ok: true, live: true };
        destinations.delete(channel);
        return failed(second.message);
      } catch (error) {
        destinations.delete(channel);
        return failed(error instanceof Error ? error.message : "Twitch Spade heartbeat failed");
      }
    },
  };
}
