import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import { createNodeKickWebSocketFactory } from "../src/transport/cycle";

describe("Kick WebSocket transport", () => {
  it("opens a viewer socket with the Kick session and browser origin", () => {
    const socket = { readyState: 0, send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() } satisfies WebSocketLike;
    const createSocket = vi.fn(() => socket);
    const factory = createNodeKickWebSocketFactory({ kick: { sessionToken: "encoded%2Dsession" } }, createSocket);

    expect(factory("wss://websockets.kick.com/viewer/v1/connect?token=viewer")).toBe(socket);
    expect(createSocket).toHaveBeenCalledWith(
      "wss://websockets.kick.com/viewer/v1/connect?token=viewer",
      expect.objectContaining({
        handshakeTimeout: 10_000,
        headers: expect.objectContaining({
          Origin: "https://kick.com",
          Referer: "https://kick.com/",
          authorization: "Bearer encoded-session",
          "User-Agent": expect.stringContaining("Chrome/124"),
        }),
      }),
    );
  });
});
