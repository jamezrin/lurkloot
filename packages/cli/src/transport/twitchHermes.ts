import WebSocket, { type ClientOptions } from "ws";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/webSocket";

// The Origin Twitch's own web client presents, as the extension's socket host
// does for its Hermes socket. It is the only header the CLI sets on this
// socket: no User-Agent, Referer, cookie or client hint (CLAUDE.md, Security).
export const TWITCH_WEB_ORIGIN = "https://www.twitch.tv";

const HERMES_HOST = "hermes.twitch.tv";

// How long a closing socket waits for Hermes to answer the close frame before
// it is dropped. ws waits 30 s by default, which would keep `run --once` or a
// SIGTERM exit alive that long when Hermes does not answer.
export const HERMES_CLOSE_TIMEOUT_MS = 2_000;

// `closeTimeout` is a ws 8.x client option that @types/ws does not declare.
export type HermesSocketOptions = ClientOptions & { closeTimeout: number };

function isHermesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wss:" && parsed.hostname === HERMES_HOST;
  } catch {
    return false;
  }
}

// Twitch's push socket (Hermes) for the CLI. Twitch's web client opens it with
// the twitch.tv Origin, so this socket presents that Origin, and only to
// Hermes: any other URL is refused before a socket exists, so the Origin is
// never sent anywhere else. The push controller owns the socket from here,
// including its reconnects and its close on shutdown.
export function createNodeTwitchHermesWebSocketFactory(
  createSocket: (url: string, options: HermesSocketOptions) => WebSocketLike = (url, options) =>
    new WebSocket(url, options) as unknown as WebSocketLike,
): WebSocketFactory {
  return (url) => {
    if (!isHermesUrl(url))
      throw new Error("Refusing to open a non-Hermes URL on the Hermes socket");
    const socket = createSocket(url, {
      headers: { Origin: TWITCH_WEB_ORIGIN },
      handshakeTimeout: 10_000,
      closeTimeout: HERMES_CLOSE_TIMEOUT_MS,
    });
    // A Node socket reports a failed or refused handshake, and a close while
    // it is still connecting, as an `error` event, and an `error` nothing
    // listens to is thrown and ends the process. The push controller listens
    // only for messages and closes. A close always follows the error, and the
    // controller reconnects from that.
    socket.addEventListener("error", () => {});
    return socket;
  };
}
