import type { PageFetcher } from "@lurkloot/core/adapter";
import {
  KICK_CENTRIFUGO_SOCKET_URL,
  KICK_PUSHER_SOCKET_URL,
  KickRealtimeConnection,
  kickRealtimePost,
} from "@lurkloot/core/kick/realtime";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import WebSocket, { type ClientOptions } from "ws";

export function createNodeKickRealtime(
  fetcher: PageFetcher,
  createSocket: (url: string, options: ClientOptions) => WebSocketLike = (url, options) =>
    new WebSocket(url, options) as unknown as WebSocketLike,
): KickRealtimeConnection {
  return new KickRealtimeConnection({
    createWebSocket: (url) => {
      if (!KICK_CENTRIFUGO_SOCKET_URL.test(url) && !KICK_PUSHER_SOCKET_URL.test(url)) {
        throw new Error("Kick realtime returned an unsupported WebSocket endpoint");
      }
      // Realtime authenticates inside the socket. Keep the viewer socket's
      // bearer and fingerprint headers out of this handshake.
      return createSocket(url, {
        headers: { Origin: "https://kick.com" },
        handshakeTimeout: 10_000,
      });
    },
    postJson: kickRealtimePost((url, init) => fetcher.fetchJson<unknown>(url, init)),
  });
}
