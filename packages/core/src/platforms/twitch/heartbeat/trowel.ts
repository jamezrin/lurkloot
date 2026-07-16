import type { TwitchIdentity } from "../../../compatibility/types";
import type { HeartbeatResult } from "../../../core/tablessWatch";
import { buildMinuteWatchedEvent } from "./gql-v1";
import type { TwitchHeartbeatPost, TwitchHeartbeatStrategy } from "./types";

const TROWEL_ENDPOINT = "https://trowel.twitch.tv/track";

export interface TrowelHeartbeatOptions {
  identity: TwitchIdentity;
  post: TwitchHeartbeatPost;
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

export function createTrowelHeartbeat(options: TrowelHeartbeatOptions): TwitchHeartbeatStrategy {
  if (options.identity !== "android") {
    throw new Error("Twitch Trowel heartbeats require an Android identity");
  }

  return {
    id: "twitch-heartbeat-trowel-v1",
    async tick(context): Promise<HeartbeatResult> {
      const events = buildMinuteWatchedEvent({
        broadcastId: context.broadcastId,
        channelId: context.channelId,
        channelLogin: context.channel.username,
        userId: context.userId,
        gameId: context.gameId,
        gameName: context.gameName,
      });
      try {
        const response = await options.post(TROWEL_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: standardBase64(JSON.stringify(events)),
        });
        return response.status >= 200 && response.status < 300
          ? { ok: true, live: true }
          : failed(`Twitch Trowel heartbeat returned HTTP ${response.status}`);
      } catch (error) {
        return failed(error instanceof Error ? error.message : "Twitch Trowel heartbeat failed");
      }
    },
  };
}
