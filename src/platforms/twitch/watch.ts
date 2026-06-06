// Builds and encodes the Twitch "minute-watched" telemetry event that earns
// drop progress without a video tab. Twitch credits a full minute of watch time
// per accepted event, so the watcher sends one roughly every minute.
//
// This mirrors TwitchDropsMiner's Stream._gql_payload / send_watch
// (references/TwitchDropsMiner/channel.py:67-95,508-515): a single
// "minute-watched" event, JSON-minified, gzip-compressed, base64-encoded, and
// posted through the GraphQL `sendSpadeEvents` mutation. The gzip+base64 input
// shape (data/repository/encoding) is from constants.py:268-279.

export interface MinuteWatchedContext {
  broadcastId: string;
  channelId: string;
  channelLogin: string;
  userId: string;
  gameId?: string;
  gameName?: string;
  clientTime?: string;
}

// The inline mutation. Sent as an inline query (no persisted-query hash) so it
// is immune to Twitch's periodic hash rotation. Success is statusCode 204.
export const SEND_SPADE_EVENTS_MUTATION =
  "mutation SendEvents($input: SendSpadeEventsInput!) { sendSpadeEvents(input: $input) { statusCode } }";

// The single minute-watched event, matching the property set the Twitch web
// player reports. Pure and synchronous so it is easy to unit test.
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

// Builds the GraphQL `variables.input` for sendSpadeEvents: the gzip+base64
// payload tagged as GZIP_B64 from the "twilight" repository.
export async function buildSpadeInput(ctx: MinuteWatchedContext): Promise<{ data: string; repository: string; encoding: string }> {
  const payload = buildMinuteWatchedEvent(ctx);
  return {
    data: await gzipBase64(JSON.stringify(payload)),
    repository: "twilight",
    encoding: "GZIP_B64",
  };
}

// gzip-compress a UTF-8 string and base64-encode it. Uses the platform
// CompressionStream, available in the MV3 service worker, the Firefox
// background page, and Node's test runtime.
export async function gzipBase64(input: string): Promise<string> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
