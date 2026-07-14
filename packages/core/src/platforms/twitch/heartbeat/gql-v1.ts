import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { HeartbeatResult } from "../../../core/tablessWatch";
import type { TwitchGqlTransport } from "../index";
import type { TwitchHeartbeatContext, TwitchHeartbeatStrategy } from "./types";

export interface MinuteWatchedContext {
  broadcastId: string;
  channelId: string;
  channelLogin: string;
  userId: string;
  gameId?: string;
  gameName?: string;
  clientTime?: string;
}

export const SEND_SPADE_EVENTS_MUTATION =
  "mutation SendEvents($input: SendSpadeEventsInput!) { sendSpadeEvents(input: $input) { statusCode } }";

export function buildMinuteWatchedEvent(ctx: MinuteWatchedContext): Array<Record<string, unknown>> {
  return [
    {
      event: "minute-watched",
      properties: {
        broadcast_id: String(ctx.broadcastId),
        channel_id: String(ctx.channelId),
        channel: ctx.channelLogin,
        client_time: ctx.clientTime ?? new Date().toISOString(),
        game: ctx.gameName ?? "",
        game_id: ctx.gameId ? String(ctx.gameId) : "",
        hidden: false,
        is_live: true,
        live: true,
        logged_in: true,
        minutes_logged: 1,
        muted: false,
        user_id: String(ctx.userId),
      },
    },
  ];
}

export async function buildSpadeInput(ctx: MinuteWatchedContext): Promise<{ data: string; repository: string; encoding: string }> {
  return {
    data: await gzipBase64(JSON.stringify(buildMinuteWatchedEvent(ctx))),
    repository: "twilight",
    encoding: "GZIP_B64",
  };
}

export async function gzipBase64(input: string): Promise<string> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export function createTwitchGqlV1HeartbeatStrategy(
  gql: TwitchGqlTransport,
  emit: EventEmitter,
  log: (level: LogLevel, message: string) => void,
): TwitchHeartbeatStrategy {
  return {
    id: "twitch-heartbeat-gql-v1",
    async tick(context: TwitchHeartbeatContext): Promise<HeartbeatResult> {
      const input = await buildSpadeInput({
        broadcastId: context.broadcastId,
        channelId: context.channelId,
        channelLogin: context.channel.username,
        userId: context.userId,
        gameId: context.gameId,
        gameName: context.gameName,
      });
      const result = await gql<{ sendSpadeEvents?: { statusCode?: number } }>(
        "SendEvents",
        "",
        { input },
        SEND_SPADE_EVENTS_MUTATION,
        undefined,
        emit,
      );
      const status = result.data?.sendSpadeEvents?.statusCode;
      const ok = status === 204;
      log("debug", `Spade event for ${context.channel.username} returned status ${status ?? "unknown"}`);
      return { ok, live: true, message: ok ? undefined : `Twitch watch event returned status ${status ?? "unknown"}` };
    },
  };
}
