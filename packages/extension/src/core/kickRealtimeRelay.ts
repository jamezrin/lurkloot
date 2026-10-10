import type { WebSocketFactory, WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";

// Kick's realtime server refuses a chrome-extension:// origin (#754). The
// offscreen document kickRealtime.html frames this kick.com page, and a
// content script in that frame opens the sockets for the worker, so their
// handshake carries kick.com's origin. The page is plain text: no Kick script
// runs there. The relay reads no cookies or credentials and forwards frames
// only; the worker mints every token.
export const KICK_REALTIME_RELAY_URL = "https://kick.com/robots.txt";
export const KICK_REALTIME_RELAY_PORT = "kick-realtime-relay";
export const KICK_REALTIME_OFFSCREEN_PATH = "kickRealtime.html";
// The relay opens sockets to Kick's realtime hosts and nothing else.
const RELAY_SOCKET_URL = /^wss:\/\/(?:realtime\.[a-z0-9-]+\.platform\.kick\.com\/connection\/websocket|ws-[a-z0-9-]+\.pusher\.com\/app\/[a-z0-9]+\?[^#]*)$/i;
// How long the relay waits for its frame to connect after creating it.
const RELAY_CONNECT_TIMEOUT_MS = 15_000;
// The offscreen document closes once no socket has needed it this long.
const RELAY_IDLE_CLOSE_MS = 10_000;
const CLOSE_ABNORMAL = 1006;

export type RelayRequest =
  | { type: "open"; id: number; url: string }
  | { type: "send"; id: number; data: string }
  | { type: "close"; id: number };

export type RelayEvent =
  | { type: "open"; id: number }
  | { type: "message"; id: number; data: string }
  | { type: "close"; id: number; code?: number };

export function isRelaySocketUrl(url: string): boolean {
  return RELAY_SOCKET_URL.test(url);
}

// What the relay forwards of a socket frame. Chat publications are dropped
// here, by prefix and unparsed, so busy chats do not wake the worker: for
// Pusher every frame but its own protocol frames, for Centrifugo every
// "push" line.
export function relayForwardedData(url: string, data: string): string | undefined {
  if (/\.pusher\.com\//i.test(url)) return data.startsWith("{\"event\":\"pusher") ? data : undefined;
  const kept = data.split("\n").filter((line) => line.length > 0 && !line.startsWith("{\"push\""));
  return kept.length > 0 ? kept.join("\n") : undefined;
}

interface RelayPort {
  readonly name: string;
  readonly sender?: { tab?: unknown; url?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

// The frame end, run by the kickRealtimeRelay content script.
export function startKickRealtimeRelay(deps: {
  connect: (name: string) => RelayPort;
  createWebSocket: (url: string) => WebSocket;
  isRelayFrame: boolean;
}): boolean {
  if (!deps.isRelayFrame) return false;
  const port = deps.connect(KICK_REALTIME_RELAY_PORT);
  const sockets = new Map<number, { ws: WebSocket; url: string }>();
  const post = (event: RelayEvent) => {
    try {
      port.postMessage(event);
    } catch {
      // The worker went away; onDisconnect closes the sockets.
    }
  };
  port.onMessage.addListener((message) => {
    const request = message as RelayRequest;
    if (request.type === "open") {
      if (sockets.has(request.id)) return;
      if (!isRelaySocketUrl(request.url)) {
        post({ type: "close", id: request.id, code: CLOSE_ABNORMAL });
        return;
      }
      const ws = deps.createWebSocket(request.url);
      sockets.set(request.id, { ws, url: request.url });
      ws.addEventListener("open", () => post({ type: "open", id: request.id }));
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const data = relayForwardedData(request.url, event.data);
        if (data !== undefined) post({ type: "message", id: request.id, data });
      });
      ws.addEventListener("close", (event) => {
        sockets.delete(request.id);
        post({ type: "close", id: request.id, code: event.code });
      });
    } else if (request.type === "send") {
      const socket = sockets.get(request.id);
      if (socket?.ws.readyState === 1) socket.ws.send(request.data);
    } else if (request.type === "close") {
      sockets.get(request.id)?.ws.close(1000);
      sockets.delete(request.id);
    }
  });
  // A stopped or restarted worker leaves no socket behind.
  port.onDisconnect.addListener(() => {
    for (const { ws } of sockets.values()) ws.close(1000);
    sockets.clear();
  });
  return true;
}

export interface KickRealtimeRelayHost {
  onConnect: { addListener(listener: (port: RelayPort) => void): void };
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

// The worker end: a WebSocketFactory whose sockets live in the relay frame.
// Create it once, at the worker's top level, so onConnect is registered
// before the frame connects.
export function createKickRealtimeRelay(host: KickRealtimeRelayHost): WebSocketFactory {
  const setTimer = host.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = host.clearTimer ?? ((timer) => clearTimeout(timer));
  const sockets = new Map<number, RelaySocket>();
  let nextId = 1;
  let port: RelayPort | undefined;
  let connecting: Promise<RelayPort> | undefined;
  let waiting: ((port: RelayPort) => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  host.onConnect.addListener((candidate) => {
    // Only the relay frame in our offscreen document: never a tab.
    if (candidate.name !== KICK_REALTIME_RELAY_PORT || candidate.sender?.tab || candidate.sender?.url !== KICK_REALTIME_RELAY_URL) return;
    port?.disconnect();
    port = candidate;
    candidate.onMessage.addListener((message) => {
      if (port !== candidate) return;
      const event = message as RelayEvent;
      sockets.get(event.id)?.receive(event);
    });
    candidate.onDisconnect.addListener(() => {
      if (port !== candidate) return;
      port = undefined;
      for (const socket of [...sockets.values()]) socket.receive({ type: "close", id: socket.id, code: CLOSE_ABNORMAL });
    });
    waiting?.(candidate);
    waiting = undefined;
  });

  async function relayPort(): Promise<RelayPort> {
    if (port) return port;
    connecting ??= (async () => {
      try {
        // A document from an earlier worker has no live port; start afresh.
        if (await host.hasDocument()) await host.closeDocument();
        const connected = new Promise<RelayPort>((resolve, reject) => {
          waiting = resolve;
          setTimer(() => reject(new Error("The Kick realtime relay did not connect")), RELAY_CONNECT_TIMEOUT_MS);
        });
        await host.createDocument();
        return await connected;
      } finally {
        connecting = undefined;
        waiting = undefined;
      }
    })();
    return await connecting;
  }

  function released(id: number): void {
    sockets.delete(id);
    if (sockets.size > 0 || idleTimer !== undefined) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      if (sockets.size > 0) return;
      port?.disconnect();
      port = undefined;
      void host.hasDocument().then((open) => open ? host.closeDocument() : undefined).catch(() => undefined);
    }, RELAY_IDLE_CLOSE_MS);
  }

  class RelaySocket implements WebSocketLike {
    readyState = 0;
    private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};
    private relay?: RelayPort;

    constructor(readonly id: number, url: string) {
      relayPort().then((connected) => {
        if (this.readyState !== 0) return;
        this.relay = connected;
        connected.postMessage({ type: "open", id, url } satisfies RelayRequest);
      }).catch(() => this.receive({ type: "close", id, code: CLOSE_ABNORMAL }));
    }

    send(data: string): void {
      if (this.readyState !== 1) return;
      this.relay?.postMessage({ type: "send", id: this.id, data } satisfies RelayRequest);
    }

    close(): void {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      try {
        this.relay?.postMessage({ type: "close", id: this.id } satisfies RelayRequest);
      } catch {
        // The relay is gone; its socket closed with it.
      }
      released(this.id);
      queueMicrotask(() => this.emit("close", { code: 1000 }));
    }

    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
      (this.listeners[type] ??= []).push(listener);
    }

    receive(event: RelayEvent): void {
      if (this.readyState === 3) return;
      if (event.type === "open") {
        this.readyState = 1;
        this.emit("open", {});
      } else if (event.type === "message") {
        this.emit("message", { data: event.data });
      } else {
        this.readyState = 3;
        released(this.id);
        this.emit("close", { code: event.code });
      }
    }

    private emit(type: string, event: WebSocketMessageEventLike): void {
      for (const listener of this.listeners[type] ?? []) listener(event);
    }
  }

  return (url) => {
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
    const socket = new RelaySocket(nextId++, url);
    sockets.set(socket.id, socket);
    return socket;
  };
}
