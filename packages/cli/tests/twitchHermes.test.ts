import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import {
  createNodeTwitchHermesWebSocketFactory,
  HERMES_CLOSE_TIMEOUT_MS,
  TWITCH_WEB_ORIGIN,
} from "../src/transport/twitchHermes";

const HERMES_URL = "wss://hermes.twitch.tv/v1?clientId=kimne78kx3ncx6brgo4mv6wki5h1ko";

// The headers a WebSocket upgrade carries by protocol. Anything else would be
// an identity header the CLI chose to send.
const PROTOCOL_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-version",
  "sec-websocket-key",
  "sec-websocket-extensions",
]);

function fakeSocket(): WebSocketLike & { listeners: string[] } {
  const listeners: string[] = [];
  return {
    listeners,
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type) => {
      listeners.push(type);
    },
  };
}

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${port}/v1?clientId=kimne78kx3ncx6brgo4mv6wki5h1ko` };
}

// Points the factory's real `ws` socket at a local server, so the upgrade the
// server sees is the one the factory's options produce.
function redirectedTo(url: string) {
  return (_requested: string, options: ConstructorParameters<typeof WebSocket>[2]) =>
    new WebSocket(url, options) as unknown as WebSocketLike;
}

function closed(socket: WebSocketLike): Promise<void> {
  return new Promise((resolve) => socket.addEventListener("close", () => resolve()));
}

describe("Twitch Hermes WebSocket factory", () => {
  it("presents Twitch's web Origin and no other header", () => {
    const socket = fakeSocket();
    const createSocket = vi.fn(() => socket);
    const factory = createNodeTwitchHermesWebSocketFactory(createSocket);

    factory(HERMES_URL);
    expect(createSocket).toHaveBeenCalledOnce();
    const [url, options] = createSocket.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe(HERMES_URL);
    expect(options).toEqual({
      headers: { Origin: "https://www.twitch.tv" },
      handshakeTimeout: 10_000,
      closeTimeout: HERMES_CLOSE_TIMEOUT_MS,
    });
    expect(TWITCH_WEB_ORIGIN).toBe("https://www.twitch.tv");
  });

  it("listens for errors, which a Node socket throws when nothing listens", () => {
    const socket = fakeSocket();
    createNodeTwitchHermesWebSocketFactory(() => socket)(HERMES_URL);
    expect(socket.listeners).toContain("error");
  });

  it.each([
    "wss://irc-ws.chat.twitch.tv/",
    "wss://hermes.twitch.tv.example.com/v1",
    "ws://hermes.twitch.tv/v1",
    "wss://viewer@hermes.twitch.tv/v1",
    "wss://:secret@hermes.twitch.tv/v1",
    "wss://pubsub-edge.twitch.tv/v1",
    "not a url",
  ])("opens no socket for %s", (url) => {
    const createSocket = vi.fn(() => fakeSocket());
    const factory = createNodeTwitchHermesWebSocketFactory(createSocket);
    expect(() => factory(url)).toThrow(/Hermes/);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("sends only Origin besides the WebSocket protocol headers", async () => {
    const { server, url } = await listen();
    const upgrade = new Promise<IncomingHttpHeaders>((resolve) =>
      server.once("connection", (_socket, request) => resolve(request.headers)),
    );
    const socket = createNodeTwitchHermesWebSocketFactory(redirectedTo(url))(HERMES_URL);

    const headers = await upgrade;
    expect(headers.origin).toBe("https://www.twitch.tv");
    const extra = Object.keys(headers).filter(
      (name) => name !== "origin" && !PROTOCOL_HEADERS.has(name),
    );
    expect(extra).toEqual([]);
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers.authorization).toBeUndefined();

    const done = closed(socket);
    socket.close();
    await done;
  });

  it("closes a socket that is still connecting without throwing", async () => {
    const { url } = await listen();
    const socket = createNodeTwitchHermesWebSocketFactory(redirectedTo(url))(HERMES_URL);
    expect(socket.readyState).toBe(0);
    const done = closed(socket);
    socket.close();
    await done;
    expect(socket.readyState).toBe(3);
  });

  it("reports a refused connection as a close without throwing", async () => {
    const { server, url } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const socket = createNodeTwitchHermesWebSocketFactory(redirectedTo(url))(HERMES_URL);
    await closed(socket);
    expect(socket.readyState).toBe(3);
  });

  // ws waits 30 s for the server's close frame by default. A server that never
  // answers must not hold the process open that long after shutdown.
  it("drops a connected socket whose server never answers the close", async () => {
    const server = createServer();
    const sockets: Socket[] = [];
    server.on("connection", (socket) => sockets.push(socket));
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      // Completes the upgrade, then ignores every frame, the close included.
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const socket = createNodeTwitchHermesWebSocketFactory(
        redirectedTo(`ws://127.0.0.1:${port}/v1`),
      )(HERMES_URL);
      await vi.waitFor(() => expect(socket.readyState).toBe(1));
      const done = closed(socket);
      const started = Date.now();
      socket.close();
      await done;
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(HERMES_CLOSE_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(HERMES_CLOSE_TIMEOUT_MS + 2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
