import { describe, expect, it, vi } from "vitest";
import {
  createKickRealtimeRelay,
  isRelaySocketUrl,
  KICK_REALTIME_RELAY_PORT,
  KICK_REALTIME_RELAY_URL,
  relayForwardedData,
  startKickRealtimeRelay,
  type RelayEvent,
  type RelayRequest,
} from "../src/core/kickRealtimeRelay";

const CENTRIFUGO_URL = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const PUSHER_URL = "wss://ws-us2.pusher.com/app/abc123?protocol=7&client=js&version=8.4.0&flash=false";

// Two Port ends wired to each other, as runtime.connect gives a frame and the
// worker's onConnect.
interface TestPort {
  name: string;
  sender?: { tab?: unknown; url?: string };
  peer: TestPort;
  disconnected: boolean;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  messages: Array<(message: unknown) => void>;
  disconnects: Array<() => void>;
}

function portPair(sender: { tab?: unknown; url?: string } = { url: KICK_REALTIME_RELAY_URL }) {
  const make = (name: string, portSender?: typeof sender): TestPort => {
    const messages: Array<(message: unknown) => void> = [];
    const disconnects: Array<() => void> = [];
    return {
      name,
      sender: portSender,
      peer: undefined as unknown as TestPort,
      disconnected: false,
      postMessage(message: unknown) { if (!this.disconnected) for (const listener of this.peer.messages) listener(structuredClone(message)); },
      disconnect() { if (this.disconnected) return; this.disconnected = true; this.peer.disconnected = true; for (const listener of this.peer.disconnects) listener(); },
      onMessage: { addListener: (listener: (message: unknown) => void) => { messages.push(listener); } },
      onDisconnect: { addListener: (listener: () => void) => { disconnects.push(listener); } },
      messages,
      disconnects,
    };
  };
  const frame = make(KICK_REALTIME_RELAY_PORT);
  const worker = make(KICK_REALTIME_RELAY_PORT, sender);
  frame.peer = worker;
  worker.peer = frame;
  return { frame, worker };
}

class BrowserSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closedWith?: number;
  constructor(readonly url: string) { super(); }
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: string) { this.dispatchEvent(new MessageEvent("message", { data })); }
  remoteClose(code: number) { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code })); }
}

describe("Kick realtime relay frame", () => {
  function frame(isRelayFrame = true) {
    const { frame: port, worker } = portPair();
    const sockets: BrowserSocket[] = [];
    const events: RelayEvent[] = [];
    worker.onMessage.addListener((message) => events.push(message as RelayEvent));
    const started = startKickRealtimeRelay({
      connect: () => port as never,
      createWebSocket: (url) => { const socket = new BrowserSocket(url); sockets.push(socket); return socket as unknown as WebSocket; },
      isRelayFrame,
    });
    const send = (request: RelayRequest) => worker.postMessage(request);
    return { started, sockets, events, send, worker };
  }

  it("does nothing outside the extension's own offscreen frame", () => {
    expect(frame(false).started).toBe(false);
  });

  it("opens Kick realtime sockets only", () => {
    const f = frame();
    f.send({ type: "open", id: 1, url: "wss://evil.example/socket" });
    expect(f.sockets).toEqual([]);
    expect(f.events).toEqual([{ type: "close", id: 1, code: 1006 }]);
    expect(isRelaySocketUrl(CENTRIFUGO_URL)).toBe(true);
    expect(isRelaySocketUrl(PUSHER_URL)).toBe(true);
    expect(isRelaySocketUrl("wss://realtime.us-west-2.platform.kick.com.evil.example/connection/websocket")).toBe(false);
  });

  it("relays open, frames and close, and sends only while open", () => {
    const f = frame();
    f.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    const socket = f.sockets[0]!;
    f.send({ type: "send", id: 1, data: "early" });
    socket.open();
    f.send({ type: "send", id: 1, data: "{\"connect\":{}}" });
    socket.receive("{\"id\":1,\"connect\":{}}");
    socket.remoteClose(3501);
    expect(socket.sent).toEqual(["{\"connect\":{}}"]);
    expect(f.events).toEqual([
      { type: "open", id: 1 },
      { type: "message", id: 1, data: "{\"id\":1,\"connect\":{}}" },
      { type: "close", id: 1, code: 3501 },
    ]);
  });

  // #755: discovery's drop channels cross; chat never does.
  it("forwards drop-channel events", () => {
    const drop = "{\"push\":{\"channel\":\"drops_category_15\",\"pub\":{\"data\":{\"event\":\"drops_campaign_started\",\"data\":\"7\"}}}}";
    expect(relayForwardedData(CENTRIFUGO_URL, drop)).toBe(drop);
    expect(relayForwardedData(CENTRIFUGO_URL, `{"push":{"channel":"chatrooms.1.v2"}}\n${drop}`)).toBe(drop);
    const pusherDrop = "{\"event\":\"drops_campaign_started\",\"data\":\"\\\"7\\\"\",\"channel\":\"drops_category_15\"}";
    expect(relayForwardedData(PUSHER_URL, pusherDrop)).toBe(pusherDrop);
    expect(relayForwardedData(PUSHER_URL, "{\"event\":\"pusher_internal:subscription_succeeded\",\"channel\":\"x\"}")).toBeDefined();
  });

  it("drops chat publications before they cross to the worker", () => {
    expect(relayForwardedData(CENTRIFUGO_URL, "{\"push\":{\"channel\":\"chatrooms.1.v2\"}}")).toBeUndefined();
    expect(relayForwardedData(CENTRIFUGO_URL, "{\"push\":{}}\n{}\n{\"id\":2,\"subscribe\":{}}")).toBe("{}\n{\"id\":2,\"subscribe\":{}}");
    expect(relayForwardedData(PUSHER_URL, "{\"event\":\"App\\\\Events\\\\ChatMessageEvent\"}")).toBeUndefined();
    expect(relayForwardedData(PUSHER_URL, "{\"event\":\"pusher:ping\",\"data\":{}}")).toBe("{\"event\":\"pusher:ping\",\"data\":{}}");
  });

  it("closes its sockets when the worker goes away", () => {
    const f = frame();
    f.send({ type: "open", id: 1, url: CENTRIFUGO_URL });
    f.sockets[0]!.open();
    f.worker.disconnect();
    expect(f.sockets[0]!.closedWith).toBe(1000);
  });
});

describe("Kick realtime relay worker end", () => {
  function host() {
    let onConnect!: (port: unknown) => void;
    const documents = { open: false, created: 0, closed: 0 };
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const factory = createKickRealtimeRelay({
      onConnect: { addListener: (listener) => { onConnect = listener as never; } },
      hasDocument: async () => documents.open,
      createDocument: async () => { documents.open = true; documents.created += 1; },
      closeDocument: async () => { documents.open = false; documents.closed += 1; },
      setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length as never; },
      clearTimer: () => undefined,
    });
    // Connects a relay frame, returning the requests it receives.
    const connectFrame = (sender?: { tab?: unknown; url?: string }) => {
      const { frame, worker } = portPair(sender);
      const requests: RelayRequest[] = [];
      frame.onMessage.addListener((message) => requests.push(message as RelayRequest));
      onConnect(worker);
      return { frame, requests };
    };
    return { factory, documents, timers, connectFrame };
  }
  const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

  it("creates the offscreen document and opens the socket through its frame", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const listener = vi.fn();
    socket.addEventListener("open", listener);
    await settle();
    expect(h.documents.created).toBe(1);
    const relay = h.connectFrame();
    await settle();
    expect(relay.requests).toEqual([{ type: "open", id: 1, url: CENTRIFUGO_URL }]);
    relay.frame.postMessage({ type: "open", id: 1 } satisfies RelayEvent);
    expect(socket.readyState).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    socket.send("{}");
    expect(relay.requests.at(-1)).toEqual({ type: "send", id: 1, data: "{}" });
  });

  it("ignores a port from a tab or another page", async () => {
    const h = host();
    h.factory(CENTRIFUGO_URL);
    await settle();
    const fromTab = h.connectFrame({ tab: { id: 3 }, url: KICK_REALTIME_RELAY_URL });
    const fromPage = h.connectFrame({ url: "https://kick.com/xqc" });
    await settle();
    expect(fromTab.requests).toEqual([]);
    expect(fromPage.requests).toEqual([]);
  });

  it("replaces a document an earlier worker left behind", async () => {
    const h = host();
    h.documents.open = true;
    h.factory(CENTRIFUGO_URL);
    await settle();
    expect(h.documents.closed).toBe(1);
    expect(h.documents.created).toBe(1);
  });

  it("closes every socket when the relay frame goes away", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    const relay = h.connectFrame();
    await settle();
    relay.frame.postMessage({ type: "open", id: 1 } satisfies RelayEvent);
    relay.frame.disconnect();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
    expect(socket.readyState).toBe(3);
  });

  it("tells the frame to close a socket the worker closes, and closes the document once idle", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    await settle();
    const relay = h.connectFrame();
    await settle();
    relay.frame.postMessage({ type: "open", id: 1 } satisfies RelayEvent);
    socket.close();
    expect(relay.requests.at(-1)).toEqual({ type: "close", id: 1 });
    h.timers.find((timer) => timer.delayMs === 10_000)!.callback();
    await settle();
    expect(h.documents.closed).toBe(1);
  });

  it("fails the socket when the frame never connects", async () => {
    const h = host();
    const socket = h.factory(CENTRIFUGO_URL);
    const closed = vi.fn();
    socket.addEventListener("close", closed);
    await settle();
    h.timers.find((timer) => timer.delayMs === 15_000)!.callback();
    await settle();
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
  });
});
