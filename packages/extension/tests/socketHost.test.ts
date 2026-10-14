import { describe, expect, it, vi } from "vitest";
import {
  bridgeSocketHost,
  SOCKET_HOST_KEEPALIVE_MS,
  SOCKET_HOST_PORT,
  startSocketWorker,
  type SocketHostEvent,
  type SocketHostPort,
  type SocketWorkerControl,
} from "../src/core/socketHost";

const CENTRIFUGO_URL = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const IRC_URL = "wss://irc-ws.chat.twitch.tv/";

class BrowserSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closedWith?: number;
  constructor(readonly url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  remoteClose(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

describe("socket host worker", () => {
  function worker() {
    const sockets: BrowserSocket[] = [];
    const events: SocketHostEvent[] = [];
    const intervals: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
    const handle = startSocketWorker({
      post: (event) => events.push(event),
      createWebSocket: (url) => {
        const socket = new BrowserSocket(url);
        sockets.push(socket);
        return socket as never;
      },
      setInterval: (callback, delayMs) => {
        intervals.push({ callback, delayMs, cleared: false });
        return intervals.length as never;
      },
      clearInterval: (timer) => {
        intervals[(timer as unknown as number) - 1]!.cleared = true;
      },
    });
    const send = (message: SocketWorkerControl) => handle(message);
    return { sockets, events, intervals, send };
  }

  it("opens allowlisted platform sockets only", () => {
    const w = worker();
    w.send({ type: "open", id: 1, url: "wss://evil.example/socket" });
    expect(w.sockets).toEqual([]);
    expect(w.events).toEqual([{ type: "close", id: 1, code: 1006 }]);
  });

  it("relays open, frames and close, and sends only while open", () => {
    const w = worker();
    w.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    const socket = w.sockets[0]!;
    w.send({ type: "send", id: 1, data: "early" });
    socket.open();
    w.send({ type: "send", id: 1, data: '{"connect":{}}' });
    socket.receive('{"id":1,"connect":{}}');
    socket.receive('{"push":{"channel":"chatrooms.1.v2"}}');
    socket.remoteClose(3501);
    expect(socket.sent).toEqual(['{"connect":{}}']);
    expect(w.events).toEqual([
      { type: "open", id: 1 },
      { type: "message", id: 1, data: '{"id":1,"connect":{}}' },
      { type: "close", id: 1, code: 3501 },
    ]);
  });

  it("filters each socket by its own profile", () => {
    const w = worker();
    w.send({ type: "open", id: 1, url: IRC_URL });
    w.sockets[0]!.open();
    w.sockets[0]!.receive(":a!a@a PRIVMSG #c :chat\r\nPING :tmi.twitch.tv\r\n");
    expect(w.events.at(-1)).toEqual({ type: "message", id: 1, data: "PING :tmi.twitch.tv\r\n" });
  });

  it("keeps the service worker alive only while a socket is open", () => {
    const w = worker();
    expect(w.intervals).toEqual([]);
    w.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    w.send({ type: "open", id: 2, url: IRC_URL });
    expect(w.intervals).toHaveLength(1);
    expect(w.intervals[0]!.delayMs).toBe(SOCKET_HOST_KEEPALIVE_MS);
    w.intervals[0]!.callback();
    expect(w.events.at(-1)).toEqual({ type: "keepalive" });
    w.send({ type: "close", id: 1 });
    expect(w.intervals[0]!.cleared).toBe(false);
    w.sockets[1]!.remoteClose(1000);
    expect(w.intervals[0]!.cleared).toBe(true);
  });

  it("closes every socket on reset", () => {
    const w = worker();
    w.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    w.send({ type: "open", id: 2, url: IRC_URL });
    w.send({ type: "reset" });
    expect(w.sockets.map((socket) => socket.closedWith)).toEqual([1000, 1000]);
    expect(w.intervals[0]!.cleared).toBe(true);
    // Their close events no longer reach the (gone) service worker.
    w.sockets[0]!.remoteClose(1000);
    expect(w.events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("closes a socket the service worker closes, without reporting it back", () => {
    const w = worker();
    w.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    w.send({ type: "close", id: 1 });
    w.sockets[0]!.remoteClose(1000);
    expect(w.sockets[0]!.closedWith).toBe(1000);
    expect(w.events).toEqual([]);
  });
});

describe("socket host document", () => {
  it("relays between the port and the worker, and resets the worker when the port goes", () => {
    const portMessages: Array<(message: unknown) => void> = [];
    const portDisconnects: Array<() => void> = [];
    const posted: unknown[] = [];
    const port: SocketHostPort = {
      name: SOCKET_HOST_PORT,
      postMessage: (message) => posted.push(message),
      disconnect: () => undefined,
      onMessage: {
        addListener: (listener) => {
          portMessages.push(listener);
        },
      },
      onDisconnect: {
        addListener: (listener) => {
          portDisconnects.push(listener);
        },
      },
    };
    let workerListener!: (event: { data: unknown }) => void;
    const toWorker = vi.fn();
    const connect = vi.fn(() => port);
    bridgeSocketHost({
      connect,
      worker: {
        postMessage: toWorker,
        addEventListener: (_type, listener) => {
          workerListener = listener;
        },
      },
    });

    expect(connect).toHaveBeenCalledWith(SOCKET_HOST_PORT);
    portMessages[0]!({ type: "open", id: 1, url: CENTRIFUGO_URL });
    expect(toWorker).toHaveBeenLastCalledWith({ type: "open", id: 1, url: CENTRIFUGO_URL });
    workerListener({ data: { type: "keepalive" } });
    expect(posted).toEqual([{ type: "keepalive" }]);
    portDisconnects[0]!();
    expect(toWorker).toHaveBeenLastCalledWith({ type: "reset" });
    workerListener({ data: { type: "keepalive" } });
    expect(posted).toHaveLength(1);
  });
});
