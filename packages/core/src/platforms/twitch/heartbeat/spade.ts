import type { HeartbeatResult } from "../../../core/tablessWatch";
import { buildMinuteWatchedEvent } from "./gql-v1";
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

function standardBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function failed(message: string): HeartbeatResult {
  return { ok: false, live: true, message };
}

export function createSpadeHeartbeat(options: SpadeHeartbeatOptions): TwitchHeartbeatStrategy {
  const destinations = new Map<string, string>();

  const resolveDestination = async (context: TwitchHeartbeatContext): Promise<string | undefined> => {
    if (!isAllowedTwitchUrl(context.channel.url)) return undefined;
    const page = await options.fetchText(context.channel.url, AUTHENTICATED_GET);
    const inline = extractStringValue(page, ["spade_url", "beacon_url"]);
    if (inline !== undefined && isAllowedTwitchUrl(inline)) return inline;

    const bundleUrl = extractSettingsBundle(page);
    if (!bundleUrl || !isAllowedTwitchUrl(bundleUrl)) return undefined;
    const bundle = await options.fetchText(bundleUrl, AUTHENTICATED_GET);
    const bundled = extractStringValue(bundle, ["spade_url", "beacon_url"]);
    return bundled && isAllowedTwitchUrl(bundled) ? bundled : undefined;
  };

  const send = async (destination: string, context: TwitchHeartbeatContext): Promise<boolean> => {
    if (!isAllowedTwitchUrl(destination)) return false;
    const event = buildMinuteWatchedEvent({
      broadcastId: context.broadcastId,
      channelId: context.channelId,
      channelLogin: context.channel.username,
      userId: context.userId,
      gameId: context.gameId,
      gameName: context.gameName,
    });
    const encoded = standardBase64(JSON.stringify(event));
    try {
      const response = await options.post(destination, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(encoded)}`,
      });
      return response.status === 204;
    } catch {
      return false;
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
        if (await send(destination, context)) return { ok: true, live: true };

        destinations.delete(channel);
        const refreshed = await resolveDestination(context);
        if (!refreshed) return failed("Unable to refresh the Twitch Spade destination");
        destinations.set(channel, refreshed);
        if (await send(refreshed, context)) return { ok: true, live: true };
        destinations.delete(channel);
        return failed("Twitch Spade heartbeat returned an unexpected status");
      } catch (error) {
        destinations.delete(channel);
        return failed(error instanceof Error ? error.message : "Twitch Spade heartbeat failed");
      }
    },
  };
}
