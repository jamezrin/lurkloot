import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import { expect, it, vi } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import { createNodeKickRealtime } from "../src/transport/kickRealtime";

it.each(["403", "pending"])("stops cleanly after a %s Kick realtime upgrade", async (upgrade) => {
  const server = createServer();
  let upgradeSocket: Duplex | undefined;
  server.on("upgrade", (_request, socket) => {
    upgradeSocket = socket;
    if (upgrade === "403") socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  let closed: Promise<void> | undefined;
  const createSocket = vi.fn((_url: string, options: ClientOptions) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    // A close-only listener leaves unhandled ws errors visible to Vitest.
    closed = new Promise<void>((resolve) => socket.once("close", resolve));
    return socket as unknown as WebSocketLike;
  });
  const realtime = createNodeKickRealtime(
    {
      fetchJson: async () => {
        throw new Error("Unexpected HTTP request");
      },
    },
    createSocket,
  );
  try {
    const requested = once(server, "upgrade");
    realtime.start({
      provider: "pusher",
      url: "wss://ws-us2.pusher.com/app/test?protocol=7",
    });
    await requested;
    expect(closed).toBeDefined();
    if (upgrade === "403") {
      await closed;
      expect(realtime.status().state).toBe("error");
    } else {
      expect(realtime.status().state).toBe("connecting");
    }
    await realtime.stop();
    await closed;
    expect(realtime.status()).toEqual({ state: "idle" });
    expect(createSocket).toHaveBeenCalledOnce();
  } finally {
    await realtime.stop();
    upgradeSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
