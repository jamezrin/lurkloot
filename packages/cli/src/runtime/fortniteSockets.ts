import {
  twitchExtensionFrameOrigin,
  twitchExtensionProvider,
} from "@lurkloot/core/extensions/registry";
import {
  FORTNITE_SOCKET_URL,
  type FortniteSocketFactory,
} from "@lurkloot/core/extensions/fortnite/socket";
import WebSocket from "ws";

const CLOSE_TIMEOUT_MS = 2_000;

export function createFortniteSockets() {
  const provider = twitchExtensionProvider("fortnite")!;
  const backend = new URL(provider.backendSocketOrigin!);
  const endpoint = new URL(FORTNITE_SOCKET_URL);
  const sockets = new Map<WebSocket, Promise<void>>();
  let stopped = false;

  const createSocket: FortniteSocketFactory = (url) => {
    const target = new URL(url);
    if (
      stopped
      || target.protocol !== "wss:"
      || target.origin !== backend.origin
      || target.pathname !== endpoint.pathname
      || target.username
      || target.password
      || target.search
      || target.hash
    )
      throw new Error("Fortnite socket endpoint is not allowed.");
    const options = {
      origin: twitchExtensionFrameOrigin(provider),
      handshakeTimeout: 10_000,
      closeTimeout: CLOSE_TIMEOUT_MS,
    };
    const socket = new WebSocket(target, options);
    // ws may emit an error after a driver has detached its DOM listener (for
    // example, when shutdown interrupts an HTTP upgrade).
    socket.on("error", () => undefined);
    sockets.set(
      socket,
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
    return socket as unknown as ReturnType<FortniteSocketFactory>;
  };
  return {
    createSocket,
    async close(): Promise<void> {
      stopped = true;
      const pending = [...sockets.values()];
      for (const socket of sockets.keys()) socket.close();
      await Promise.all(pending);
    },
  };
}
