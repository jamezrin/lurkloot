import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";

type Socket = WebSocketLike & { removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void };
export class FortniteSocketFailure extends Error {
  constructor(readonly reason: "transport-error" | "provider-error" | "compatibility-error", message: string) { super(message); }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export interface FortnitePush { type: "states.change" | "state.change"; payload: unknown }

// All results/properties here remain inside the privileged driver. Never
// persist properties or return them through runtime messages: the server can
// include Epic session/device material. A fresh client uses ordinary hello {}.
export async function connectFortniteSocket(options: {
  createSocket(url: string): Socket;
  signal: AbortSignal;
  onPush(push: FortnitePush): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  if (options.signal.aborted) throw new FortniteSocketFailure("transport-error", "Fortnite connection closed.");
  let socket: Socket;
  try { socket = options.createSocket("wss://backend.p-n6412w7dsu.exmggames.com/handler"); }
  catch { throw new FortniteSocketFailure("transport-error", "Fortnite connection failed."); }
  let ended = false;
  let sequence = 0;
  let connectionId: string | number | undefined;
  let properties: Record<string, unknown> = {};
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  let serverStamp: number | undefined;
  let syncedAt = 0;
  let bestRtt = Infinity;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let resolveOpen!: () => void;
  let rejectOpen!: (error: FortniteSocketFailure) => void;
  const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: FortniteSocketFailure): void; timer: ReturnType<typeof setTimeout>; sentAt: number }>();
  const listeners: ["open" | "message" | "close" | "error", (event: WebSocketMessageEventLike) => void][] = [];
  function close(reason = new FortniteSocketFailure("transport-error", "Fortnite connection closed.")) {
    if (ended) return;
    ended = true;
    if (openingTimer !== undefined) clearTimeout(openingTimer);
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    options.signal.removeEventListener("abort", abort);
    for (const [type, listener] of listeners) socket.removeEventListener?.(type, listener);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
    pending.clear();
    properties = {};
    connectionId = undefined;
    rejectOpen(reason);
    resolveClosed();
    try { socket.close(); } catch { /* Fixed failure classes only. */ }
  }
  const abort = () => close();
  function listen(type: typeof listeners[number][0], listener: typeof listeners[number][1]) {
    listeners.push([type, listener]); socket.addEventListener(type, listener);
  }
  listen("open", () => { if (!ended) { if (openingTimer !== undefined) clearTimeout(openingTimer); resolveOpen(); } });
  listen("close", () => close());
  listen("error", () => close(new FortniteSocketFailure("transport-error", "Fortnite connection failed.")));
  listen("message", (event) => {
    if (ended) return;
    let envelope: Record<string, unknown> | undefined;
    try {
      if (typeof event.data !== "string" || event.data.length > 1_048_576) throw new Error();
      envelope = object(JSON.parse(event.data));
      if (!envelope) throw new Error();
    } catch { close(new FortniteSocketFailure("compatibility-error", "Fortnite response is incompatible.")); return; }
    if (typeof envelope.connectionId === "string" && envelope.connectionId.length <= 4096
      || typeof envelope.connectionId === "number" && Number.isSafeInteger(envelope.connectionId)) connectionId = envelope.connectionId as string | number;
    const incomingProperties = object(envelope.properties);
    if (incomingProperties) properties = incomingProperties;
    if (envelope.commandId === undefined) {
      if (envelope.type === "states.change" || envelope.type === "state.change") {
        try { options.onPush({ type: envelope.type, payload: envelope.payload }); }
        catch { close(new FortniteSocketFailure("compatibility-error", "Fortnite state is incompatible.")); }
      }
      return;
    }
    if (typeof envelope.commandId !== "string") return;
    const request = pending.get(envelope.commandId);
    if (!request) return;
    pending.delete(envelope.commandId); clearTimeout(request.timer);
    const rtt = Math.max(0, now() - request.sentAt);
    if (typeof envelope.serverTime === "number" && Number.isFinite(envelope.serverTime)
      && envelope.serverTime >= 0 && envelope.serverTime <= 8_640_000_000_000_000 && rtt <= bestRtt) {
      bestRtt = rtt; serverStamp = envelope.serverTime; syncedAt = now();
    }
    if (envelope.error === true) request.reject(new FortniteSocketFailure("provider-error", "Fortnite provider rejected command."));
    else request.resolve(envelope.payload);
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) close();
  else if (socket.readyState === 1) resolveOpen();
  else if (socket.readyState !== 0) close();
  else openingTimer = setTimeout(() => close(new FortniteSocketFailure("transport-error", "Fortnite connection timed out.")), 10_000);
  await opened;

  function command(type: string, payload?: Record<string, unknown>): Promise<unknown> {
    if (ended || socket.readyState !== 1) return Promise.reject(new FortniteSocketFailure("transport-error", "Fortnite connection closed."));
    if (pending.size >= 100 || type.length > 96 || !/^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+$/.test(type)) return Promise.reject(new FortniteSocketFailure("provider-error", "Invalid Fortnite command."));
    const counter = ++sequence;
    const commandId = `${Math.floor(now() / 1000)}.${counter}`;
    let data: string;
    try {
      data = JSON.stringify({ commandId, connectionId, type, time: counter, ...(type === "service.hello" ? { payload: { properties } } : payload ? { payload } : {}) });
      if (data.length > 1_048_576) throw new Error();
    } catch { return Promise.reject(new FortniteSocketFailure("provider-error", "Invalid Fortnite command.")); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(new FortniteSocketFailure("transport-error", "Fortnite command timed out.")), 30_000);
      // Register before send: server pushes can precede responses, and a fake
      // socket may deliver its response synchronously.
      pending.set(commandId, { resolve, reject, timer, sentAt: now() });
      try { socket.send(data); }
      catch { close(new FortniteSocketFailure("transport-error", "Fortnite send failed.")); }
    });
  }
  function startPing() {
    if (ended || pingTimer !== undefined) return;
    pingTimer = setTimeout(async () => {
      pingTimer = undefined;
      try { await command("service.ping"); }
      catch { close(); }
      if (!ended) startPing();
    }, 10_000);
  }
  return { command, startPing, close: () => close(), closed, serverNow: () => serverStamp === undefined ? now() : serverStamp + now() - syncedAt };
}
export type FortniteConnection = Awaited<ReturnType<typeof connectFortniteSocket>>;
