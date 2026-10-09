import type { DiagnosticEvent } from "@lurkloot/shared/events";
import { PendingDiscoverySignalDiagnostics } from "../../core/discoverySignals";
import { SafeFetchError } from "../../core/fetchError";
import type { WebSocketFactory, WebSocketLike } from "../../core/webSocket";

// Kick's negotiated realtime connection (#754), as its web client opens it:
// negotiate a provider, mint a token for Centrifugo, then keep the channel
// subscriptions its owners ask for. Owners name channels and never see
// provider frames; publications are dropped on a prefix check, unparsed.

export const KICK_REALTIME_CONNECTION_URL = "https://web.kick.com/api/v1/realtime/connection";
export const KICK_REALTIME_AUTH_URL = "https://web.kick.com/api/v1/realtime/auth/connection";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
// A connection that stays up this long resets the backoff.
const STABLE_CONNECTION_MS = 60_000;
// Centrifugo pings every `ping` seconds; its own clients allow 10 s of delay.
const CENTRIFUGO_DEFAULT_PING_SEC = 25;
const CENTRIFUGO_PING_GRACE_MS = 10_000;
// Refresh this long before the token's ttl lapses, never sooner than 5 s.
const TOKEN_REFRESH_LEAD_MS = 15_000;
const TOKEN_REFRESH_MIN_MS = 5_000;
const PUSHER_PING_INTERVAL_MS = 20_000;
const PUSHER_PONG_TIMEOUT_MS = 10_000;
const PUSHER_VERSION = "protocol=7&client=js&version=8.4.0&flash=false";
const WEBSOCKET_OPEN = 1;
// Centrifugo disconnect codes in this range are final; reconnecting repeats them.
const CENTRIFUGO_TERMINAL_CLOSE = { min: 3_500, max: 3_999 };
const PUSHER_TERMINAL_CLOSE = { min: 4_000, max: 4_099 };

export type KickRealtimeProvider = "centrifugo" | "pusher";
export type KickRealtimeState = "idle" | "connecting" | "connected" | "error" | "blocked";
export type KickRealtimeBlockReason = "auth" | "unsupported-provider";

export interface KickRealtimeStatus {
  state: KickRealtimeState;
  provider?: KickRealtimeProvider;
  reason?: KickRealtimeBlockReason;
}

// An endpoint a negotiation returned: the provider and where to connect.
export interface KickRealtimeEndpoint {
  provider: KickRealtimeProvider;
  url: string;
}

export interface KickRealtimeDeps {
  createWebSocket: WebSocketFactory;
  // POSTs JSON through the Kick fetcher (session bearer, page-context rules)
  // and returns the parsed body. Throws SafeFetchError on HTTP failures.
  postJson: (url: string, body: unknown) => Promise<unknown>;
  // Called whenever status() changes, so owners need not poll.
  onStatusChange?: () => void;
  randomId?: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

// The negotiation body Kick's web client sends, for this connection and for
// a channel's chat/connection call.
export function kickRealtimeNegotiation(clientId: string): Record<string, unknown> {
  return {
    client: { id: clientId, type: "web" },
    capabilities: { accepted_providers: [{ provider: "pusher" }, { provider: "centrifugo" }] },
  };
}

// The first endpoint in a negotiation response whose provider is implemented.
export function parseKickRealtimeEndpoint(body: unknown): KickRealtimeEndpoint | undefined {
  const connections = record(record(body)?.data)?.connections;
  if (!Array.isArray(connections)) return undefined;
  for (const connection of connections) {
    const entry = record(connection);
    const credentials = record(entry?.credentials);
    if (entry?.provider === "centrifugo" && typeof credentials?.url === "string" && credentials.url.startsWith("wss://")) {
      return { provider: "centrifugo", url: credentials.url };
    }
    if (entry?.provider === "pusher" && typeof credentials?.app_key === "string" && /^[a-z0-9]+$/i.test(credentials.app_key)) {
      const cluster = typeof credentials.cluster === "string" && /^[a-z0-9-]+$/i.test(credentials.cluster) ? credentials.cluster : "us2";
      return { provider: "pusher", url: `wss://ws-${cluster}.pusher.com/app/${credentials.app_key}?${PUSHER_VERSION}` };
    }
  }
  return undefined;
}

export class KickRealtimeConnection {
  private readonly subscriptions = new Set<string>();
  // Channels the current socket has confirmed.
  private readonly confirmed = new Set<string>();
  private ws?: WebSocketLike;
  private endpoint?: KickRealtimeEndpoint;
  private clientId?: string;
  private token?: string;
  private socketReady = false;
  private nextId = 1;
  // Centrifugo command ids awaiting a reply: what each one was for.
  private readonly pending = new Map<number, { kind: "connect" | "refresh" | "subscribe"; channel?: string }>();
  private currentStatus: KickRealtimeStatus = { state: "idle" };
  private started = false;
  private attempt = 0;
  // Bumped by every connect and stop, so late async work knows it is stale.
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private centrifugoPingMs = CENTRIFUGO_DEFAULT_PING_SEC * 1_000;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly closedByUs = new WeakSet<WebSocketLike>();
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<KickRealtimeDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<KickRealtimeDeps["clearTimer"]>;

  constructor(private readonly deps: KickRealtimeDeps) {
    this.randomId = deps.randomId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  status(): KickRealtimeStatus {
    return { ...this.currentStatus };
  }

  // Whether the current socket confirmed `channel`.
  isSubscribed(channel: string): boolean {
    return this.confirmed.has(channel);
  }

  // The endpoint in use, so a caller can tell whether a chat/connection
  // response names a different one.
  currentEndpoint(): KickRealtimeEndpoint | undefined {
    return this.endpoint ? { ...this.endpoint } : undefined;
  }

  drainEvents(): DiagnosticEvent[] {
    return this.diagnostics.drain();
  }

  // Opens the connection if it is not open. `endpoint` skips negotiation, or
  // moves an open connection to it when it differs.
  start(endpoint?: KickRealtimeEndpoint): void {
    const moving = endpoint && this.started
      && (endpoint.provider !== this.endpoint?.provider || endpoint.url !== this.endpoint?.url);
    if (this.started && !moving) return;
    if (this.currentStatus.state === "blocked" && !endpoint) return;
    this.started = true;
    if (endpoint) this.endpoint = endpoint;
    this.attempt = 0;
    this.restart();
  }

  subscribe(channel: string): void {
    if (this.subscriptions.has(channel)) return;
    this.subscriptions.add(channel);
    if (this.socketReady) this.sendSubscribe(channel);
  }

  unsubscribe(channel: string): void {
    if (!this.subscriptions.delete(channel)) return;
    this.confirmed.delete(channel);
    if (!this.socketReady) return;
    if (this.endpoint?.provider === "centrifugo") this.sendFrame({ unsubscribe: { channel }, id: this.nextId++ });
    else this.sendFrame({ event: "pusher:unsubscribe", data: { channel } });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.generation += 1;
    this.closeSocket();
    this.clearTimers();
    this.subscriptions.clear();
    this.token = undefined;
    this.clientId = undefined;
    this.endpoint = undefined;
    this.attempt = 0;
    this.setStatus({ state: "idle" });
  }

  private restart(): void {
    this.closeSocket();
    this.clearTimers();
    void this.connect(++this.generation);
  }

  private async connect(generation: number): Promise<void> {
    this.setStatus({ state: "connecting", ...(this.endpoint ? { provider: this.endpoint.provider } : {}) });
    try {
      if (!this.endpoint) {
        this.clientId = this.randomId();
        const endpoint = parseKickRealtimeEndpoint(await this.deps.postJson(KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation(this.clientId)));
        if (generation !== this.generation) return;
        if (!endpoint) {
          this.block("unsupported-provider", "Kick realtime negotiation named no supported provider");
          return;
        }
        this.endpoint = endpoint;
        this.setStatus({ state: "connecting", provider: endpoint.provider });
      }
      if (this.endpoint.provider === "centrifugo") {
        this.token = await this.mintToken();
        if (generation !== this.generation) return;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (isAuthRejection(error)) {
        this.block("auth", "Kick rejected the realtime session");
        return;
      }
      this.log("warn", `Kick realtime setup failed: ${errorMessage(error)}`);
      this.retry();
      return;
    }
    this.open(generation);
  }

  private async mintToken(): Promise<string> {
    this.clientId ??= this.randomId();
    const body = record(await this.deps.postJson(KICK_REALTIME_AUTH_URL, { client_id: this.clientId }));
    const token = record(body?.data)?.token ?? body?.token;
    if (typeof token !== "string" || token.length === 0) throw new Error("Kick realtime token missing from the response");
    return token;
  }

  private open(generation: number): void {
    const endpoint = this.endpoint!;
    let ws: WebSocketLike;
    try {
      ws = this.deps.createWebSocket(endpoint.url);
    } catch (error) {
      this.log("warn", `Failed to open the Kick realtime WebSocket: ${errorMessage(error)}`);
      this.retry();
      return;
    }
    this.ws = ws;
    this.log("debug", `Opening Kick realtime connection (${endpoint.provider})`);
    ws.addEventListener("open", () => {
      if (!this.isCurrent(ws, generation)) return;
      if (endpoint.provider === "centrifugo") {
        const id = this.nextId++;
        this.pending.set(id, { kind: "connect" });
        this.sendFrame({ connect: { token: this.token, name: "js" }, id });
        this.armSilence(this.centrifugoPingMs + CENTRIFUGO_PING_GRACE_MS);
      }
    });
    ws.addEventListener("message", (event) => {
      if (!this.isCurrent(ws, generation)) return;
      if (typeof event.data !== "string") return;
      if (endpoint.provider === "centrifugo") this.handleCentrifugo(event.data);
      else this.handlePusher(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (this.closedByUs.delete(ws) || !this.isCurrent(ws, generation)) return;
      this.ws = undefined;
      this.socketReady = false;
      this.confirmed.clear();
      this.pending.clear();
      this.clearTimers();
      const range = endpoint.provider === "centrifugo" ? CENTRIFUGO_TERMINAL_CLOSE : PUSHER_TERMINAL_CLOSE;
      if (event.code !== undefined && event.code >= range.min && event.code <= range.max) {
        this.log("warn", `Kick realtime connection closed with final code ${event.code}`);
        this.setStatus({ state: "error", provider: endpoint.provider });
        return;
      }
      this.log("debug", `Kick realtime connection closed${event.code === undefined ? "" : ` (${event.code})`}`);
      this.retry();
    });
  }

  private handleCentrifugo(data: string): void {
    this.armSilence(this.centrifugoPingMs + CENTRIFUGO_PING_GRACE_MS);
    for (const line of data.split("\n")) {
      if (line.length === 0) continue;
      // Publications carry chat; they are never parsed.
      if (line.startsWith("{\"push\"")) continue;
      if (line === "{}") {
        this.sendRaw("{}");
        continue;
      }
      const frame = parseJson(line);
      if (!frame) continue;
      const id = typeof frame.id === "number" ? frame.id : undefined;
      const request = id === undefined ? undefined : this.pending.get(id);
      if (!request) continue;
      this.pending.delete(id!);
      const error = record(frame.error);
      if (error) {
        this.handleCentrifugoError(request, error);
        continue;
      }
      if (request.kind === "connect") this.onCentrifugoConnected(record(frame.connect));
      else if (request.kind === "refresh") this.scheduleRefresh(record(frame.refresh));
      else if (request.kind === "subscribe" && request.channel && this.subscriptions.has(request.channel)) {
        this.confirmed.add(request.channel);
        this.setStatus({ state: "connected", provider: "centrifugo" });
      }
    }
  }

  private onCentrifugoConnected(reply: Record<string, unknown> | undefined): void {
    const ping = typeof reply?.ping === "number" && reply.ping > 0 ? reply.ping : CENTRIFUGO_DEFAULT_PING_SEC;
    this.centrifugoPingMs = ping * 1_000;
    this.armSilence(this.centrifugoPingMs + CENTRIFUGO_PING_GRACE_MS);
    this.scheduleRefresh(reply);
    this.ready("centrifugo");
  }

  private handleCentrifugoError(request: { kind: string; channel?: string }, error: Record<string, unknown>): void {
    const code = typeof error.code === "number" ? error.code : undefined;
    if (request.kind === "subscribe") {
      // One refused channel does not end the others.
      this.log("warn", `Kick realtime refused a subscription${code === undefined ? "" : ` (code ${code})`}`);
      return;
    }
    // 109 is Centrifugo's "token expired": mint a new one and reconnect.
    if (code === 109) this.token = undefined;
    this.log("warn", `Kick realtime ${request.kind} failed${code === undefined ? "" : ` (code ${code})`}`);
    this.restartWithBackoff();
  }

  private scheduleRefresh(reply: Record<string, unknown> | undefined): void {
    if (this.refreshTimer !== undefined) this.clearTimer(this.refreshTimer);
    this.refreshTimer = undefined;
    if (reply?.expires !== true || typeof reply.ttl !== "number" || reply.ttl <= 0) return;
    const delay = Math.max(reply.ttl * 1_000 - TOKEN_REFRESH_LEAD_MS, TOKEN_REFRESH_MIN_MS);
    const generation = this.generation;
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = undefined;
      void this.refreshToken(generation);
    }, delay);
  }

  private async refreshToken(generation: number): Promise<void> {
    try {
      const token = await this.mintToken();
      if (generation !== this.generation || !this.socketReady) return;
      this.token = token;
      const id = this.nextId++;
      this.pending.set(id, { kind: "refresh" });
      this.sendFrame({ refresh: { token }, id });
    } catch (error) {
      if (generation !== this.generation) return;
      if (isAuthRejection(error)) {
        this.block("auth", "Kick rejected the realtime session");
        return;
      }
      this.log("warn", `Kick realtime token refresh failed: ${errorMessage(error)}`);
      this.restartWithBackoff();
    }
  }

  private handlePusher(data: string): void {
    this.armPusherPing();
    // Channel events carry chat; only Pusher's own frames (pusher: and
    // pusher_internal:) are parsed.
    if (!data.startsWith("{\"event\":\"pusher")) return;
    const frame = parseJson(data);
    if (!frame || typeof frame.event !== "string") return;
    switch (frame.event) {
      case "pusher:connection_established":
        this.ready("pusher");
        return;
      case "pusher:ping":
        this.sendFrame({ event: "pusher:pong", data: {} });
        return;
      case "pusher:pong":
        if (this.pongTimer !== undefined) this.clearTimer(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case "pusher_internal:subscription_succeeded":
        if (typeof frame.channel === "string" && this.subscriptions.has(frame.channel)) {
          this.confirmed.add(frame.channel);
          this.setStatus({ state: "connected", provider: "pusher" });
        }
        return;
      case "pusher:error":
        this.log("warn", "Kick realtime received a Pusher error");
        return;
    }
  }

  private ready(provider: KickRealtimeProvider): void {
    this.socketReady = true;
    this.setStatus({ state: "connected", provider });
    this.log("debug", `Kick realtime connected (${provider})`);
    for (const channel of this.subscriptions) this.sendSubscribe(channel);
    if (this.stableTimer !== undefined) this.clearTimer(this.stableTimer);
    this.stableTimer = this.setTimer(() => {
      this.stableTimer = undefined;
      this.attempt = 0;
    }, STABLE_CONNECTION_MS);
    if (provider === "pusher") this.armPusherPing();
  }

  private sendSubscribe(channel: string): void {
    if (this.endpoint?.provider === "centrifugo") {
      const id = this.nextId++;
      this.pending.set(id, { kind: "subscribe", channel });
      this.sendFrame({ subscribe: { channel, flag: 1 }, id });
    } else {
      this.sendFrame({ event: "pusher:subscribe", data: { auth: "", channel } });
    }
  }

  // Centrifugo: no frame for a ping interval plus grace means a dead socket.
  private armSilence(delayMs: number): void {
    if (this.silenceTimer !== undefined) this.clearTimer(this.silenceTimer);
    this.silenceTimer = this.setTimer(() => {
      this.silenceTimer = undefined;
      this.log("debug", "Kick realtime connection went silent");
      this.restartWithBackoff();
    }, delayMs);
  }

  // Pusher: ping the server after 20 s without a frame; no pong in 10 s means
  // a dead socket.
  private armPusherPing(): void {
    if (this.silenceTimer !== undefined) this.clearTimer(this.silenceTimer);
    this.silenceTimer = this.setTimer(() => {
      this.silenceTimer = undefined;
      this.sendFrame({ event: "pusher:ping", data: {} });
      this.pongTimer = this.setTimer(() => {
        this.pongTimer = undefined;
        this.log("debug", "Kick realtime connection did not answer a ping");
        this.restartWithBackoff();
      }, PUSHER_PONG_TIMEOUT_MS);
    }, PUSHER_PING_INTERVAL_MS);
  }

  private restartWithBackoff(): void {
    this.closeSocket();
    this.clearTimers();
    this.retry();
  }

  private retry(): void {
    if (!this.started) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    this.setStatus({ state: "error", ...(this.endpoint ? { provider: this.endpoint.provider } : {}) });
    if (this.reconnectTimer !== undefined) this.clearTimer(this.reconnectTimer);
    const generation = ++this.generation;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      if (generation !== this.generation) return;
      void this.connect(generation);
    }, delay);
  }

  private block(reason: KickRealtimeBlockReason, message: string): void {
    this.closeSocket();
    this.clearTimers();
    this.started = false;
    this.token = undefined;
    this.log("warn", message);
    this.setStatus({ state: "blocked", reason });
  }

  private isCurrent(ws: WebSocketLike, generation: number): boolean {
    return this.started && ws === this.ws && generation === this.generation;
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(frame));
  }

  private sendRaw(data: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      ws.send(data);
    } catch (error) {
      this.log("warn", `Failed to send a Kick realtime frame: ${errorMessage(error)}`);
    }
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.socketReady = false;
    this.confirmed.clear();
    this.pending.clear();
    if (!ws) return;
    this.closedByUs.add(ws);
    try {
      ws.close();
    } catch {
      // Closing is best effort; the socket is no longer current.
    }
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.stableTimer, this.silenceTimer, this.refreshTimer, this.pongTimer]) {
      if (timer !== undefined) this.clearTimer(timer);
    }
    this.reconnectTimer = undefined;
    this.stableTimer = undefined;
    this.silenceTimer = undefined;
    this.refreshTimer = undefined;
    this.pongTimer = undefined;
  }

  private setStatus(next: KickRealtimeStatus): void {
    const previous = this.currentStatus;
    this.currentStatus = next;
    if (previous.state !== next.state || previous.provider !== next.provider || previous.reason !== next.reason) {
      this.deps.onStatusChange?.();
    }
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }
}

function isAuthRejection(error: unknown): boolean {
  return error instanceof SafeFetchError && error.failure.kind === "authentication_rejected";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
