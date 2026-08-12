import { describe, expect, it, vi } from "vitest";
import { Blob } from "node:buffer";
import type { CycleTLSClient, CycleTLSWebSocketResponse } from "cycletls";
import type { WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { createCycleKickWebSocketFactory } from "../src/transport/cycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function cycleClient(handshake: Promise<CycleTLSWebSocketResponse>): CycleTLSClient {
  return { ws: vi.fn(() => handshake) } as unknown as CycleTLSClient;
}

function underlyingSocket(): CycleTLSWebSocketResponse {
  return {
    status: 101,
    headers: {},
    data: "",
    finalUrl: "wss://ws.example.test/socket",
    json: vi.fn(async () => ({})),
    text: vi.fn(async () => ""),
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    blob: vi.fn(async () => new Blob([])),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  };
}

describe("CycleTLS WebSocket adapter", () => {
  it("emits close after an initial handshake error", async () => {
    const handshake = deferred<CycleTLSWebSocketResponse>();
    const socket = createCycleKickWebSocketFactory(cycleClient(handshake.promise), {})
      ("wss://ws.example.test/socket");
    const events: Array<{ type: string; event: WebSocketMessageEventLike }> = [];
    socket.addEventListener("error", (event) => events.push({ type: "error", event }));
    socket.addEventListener("close", (event) => events.push({ type: "close", event }));

    handshake.reject(new Error("handshake rejected"));
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.readyState).toBe(3);
    expect(events.map(({ type }) => type)).toEqual(["error", "close"]);
    expect(events[1]?.event).toMatchObject({ code: 1006, reason: "" });
  });

  it("closes a late handshake socket without opening or flushing queued sends", async () => {
    const handshake = deferred<CycleTLSWebSocketResponse>();
    const connected = underlyingSocket();
    const socket = createCycleKickWebSocketFactory(cycleClient(handshake.promise), {})
      ("wss://ws.example.test/socket");
    const opened = vi.fn();
    socket.addEventListener("open", opened);
    socket.send("queued-before-close");

    socket.close();
    handshake.resolve(connected);
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.readyState).toBe(3);
    expect(opened).not.toHaveBeenCalled();
    expect(connected.send).not.toHaveBeenCalled();
    expect(connected.close).toHaveBeenCalledOnce();
  });
});
