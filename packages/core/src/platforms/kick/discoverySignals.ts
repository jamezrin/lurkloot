import type { DiagnosticEvent } from "@lurkloot/shared/events";
import {
  PendingDiscoverySignalDiagnostics,
  type DiscoverySignalController,
  type DiscoverySignalTarget,
} from "../../core/discoverySignals";
import type { WebSocketFactory, WebSocketLike } from "../../core/webSocket";

const PUSHER_URL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";
const CHANNEL_PREFIX = "drops_category_";
const CAMPAIGN_STARTED_EVENT = "drops_campaign_started";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CLIENT_PING_INTERVAL_MS = 20_000;
const CLIENT_PONG_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN = 1;

export interface KickDiscoverySignalDeps {
  createWebSocket: WebSocketFactory;
  scheduleReconnect?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelReconnect?: (timer: ReturnType<typeof setTimeout>) => void;
  scheduleKeepAlive?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelKeepAlive?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class KickDiscoverySignalController implements DiscoverySignalController {
  readonly platform = "kick" as const;

  private categoryId?: string;
  private ws?: WebSocketLike;
  private onSignal?: () => void;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private clientPingTimer?: ReturnType<typeof setTimeout>;
  private clientPongTimer?: ReturnType<typeof setTimeout>;
  private subscribedSocket?: WebSocketLike;
  private stopped = true;
  private readonly createWebSocket: WebSocketFactory;
  private readonly scheduleReconnect: NonNullable<KickDiscoverySignalDeps["scheduleReconnect"]>;
  private readonly cancelReconnect: NonNullable<KickDiscoverySignalDeps["cancelReconnect"]>;
  private readonly scheduleKeepAlive: NonNullable<KickDiscoverySignalDeps["scheduleKeepAlive"]>;
  private readonly cancelKeepAlive: NonNullable<KickDiscoverySignalDeps["cancelKeepAlive"]>;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly intentionallyClosedSockets = new WeakSet<WebSocketLike>();

  constructor(deps: KickDiscoverySignalDeps) {
    this.createWebSocket = deps.createWebSocket;
    this.scheduleReconnect = deps.scheduleReconnect ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelReconnect = deps.cancelReconnect ?? ((timer) => clearTimeout(timer));
    this.scheduleKeepAlive = deps.scheduleKeepAlive ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelKeepAlive = deps.cancelKeepAlive ?? ((timer) => clearTimeout(timer));
  }

  get targetKey(): string | undefined {
    return this.categoryId;
  }

  async start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void> {
    const categoryId = target.channel.categoryId?.trim();
    if (target.platform !== "kick") {
      await this.stop();
      this.log("debug", `Ignoring ${target.platform} discovery target in Kick observer`);
      return;
    }
    if (!categoryId) {
      await this.stop();
      this.log("debug", "Kick discovery target is missing a category id");
      return;
    }
    this.onSignal = onSignal;
    if (this.categoryId === categoryId) return;

    this.stopped = false;
    this.clearReconnect();
    this.closeCurrentSocket();
    this.reconnectAttempt = 0;
    this.categoryId = categoryId;
    this.connect();
  }

  drainEvents(): DiagnosticEvent[] {
    return this.diagnostics.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.closeCurrentSocket();
    this.reconnectAttempt = 0;
    this.categoryId = undefined;
    this.onSignal = undefined;
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }

  private connect(): void {
    const categoryId = this.categoryId;
    if (this.stopped || !categoryId) return;

    let ws: WebSocketLike;
    try {
      ws = this.createWebSocket(PUSHER_URL);
    } catch (error) {
      this.log("warn", `Failed to open Kick discovery WebSocket: ${errorMessage(error)}`);
      this.scheduleNextReconnect();
      return;
    }
    this.ws = ws;
    this.log("debug", `Opening Kick discovery connection for category ${categoryId}`);

    ws.addEventListener("message", (event) => {
      if (!this.isCurrent(ws)) return;
      this.handleMessage(ws, event);
    });
    ws.addEventListener("error", () => {
      if (!this.isCurrent(ws)) return;
      this.log("warn", `Kick discovery WebSocket error for category ${this.categoryId}`);
    });
    ws.addEventListener("close", (event) => {
      if (!this.isCurrent(ws)) {
        this.intentionallyClosedSockets.delete(ws);
        return;
      }
      if (this.intentionallyClosedSockets.delete(ws)) return;
      this.ws = undefined;
      this.clearKeepAlive();
      this.subscribedSocket = undefined;
      if (isTerminalPusherClose(event.code)) {
        this.log(
          "warn",
          `Kick discovery connection received terminal Pusher close code ${event.code}; reconnect disabled for category ${this.categoryId}`,
        );
        return;
      }
      this.log("debug", `Kick discovery connection closed for category ${this.categoryId}`);
      this.scheduleNextReconnect();
    });
  }

  private isCurrent(ws: WebSocketLike): boolean {
    return !this.stopped && ws === this.ws;
  }

  private handleMessage(ws: WebSocketLike, event: { data?: unknown }): void {
    const frame = parseFrame(event.data);
    if (!frame) {
      this.log("debug", "Ignored malformed Kick discovery frame");
      return;
    }

    if (frame.event === "pusher:connection_established") {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) {
        this.log("debug", "Ignored malformed Kick discovery frame");
        return;
      }
      this.reconnectAttempt = 0;
      this.clearKeepAlive();
      this.subscribedSocket = undefined;
      this.safeSend(ws, {
        event: "pusher:subscribe",
        data: { auth: "", channel: this.currentChannelName() },
      });
      return;
    }

    if (
      frame.event === "pusher_internal:subscription_succeeded"
      && frame.channel === this.currentChannelName()
    ) {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) {
        this.log("debug", "Ignored malformed Kick discovery frame");
        return;
      }
      this.clearKeepAlive();
      this.subscribedSocket = ws;
      this.log("debug", `Kick discovery subscribed to category ${this.categoryId}`);
      this.scheduleClientPing(ws);
      return;
    }

    if (frame.event === "pusher:ping") {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) {
        this.log("debug", "Ignored malformed Kick discovery frame");
        return;
      }
      this.safeSend(ws, { event: "pusher:pong", data: {} });
      return;
    }

    if (frame.event === "pusher:pong") {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) {
        this.log("debug", "Ignored malformed Kick discovery frame");
        return;
      }
      if (this.subscribedSocket !== ws || this.clientPongTimer === undefined) return;
      this.cancelKeepAlive(this.clientPongTimer);
      this.clientPongTimer = undefined;
      this.scheduleClientPing(ws);
      return;
    }

    if (
      this.subscribedSocket !== ws
      || frame.event !== CAMPAIGN_STARTED_EVENT
      || frame.channel !== this.currentChannelName()
    ) return;
    const data = decodePusherData(frame.data);
    if (!data.ok || !isCampaignId(data.value)) {
      this.log("debug", "Ignored malformed Kick discovery frame");
      return;
    }
    this.log("debug", `Accepted Kick campaign-start discovery signal for category ${this.categoryId}`);
    try {
      this.onSignal?.();
    } catch (error) {
      this.log("warn", `Kick discovery signal callback failed: ${errorMessage(error)}`);
    }
  }

  private currentChannelName(): string {
    return `${CHANNEL_PREFIX}${this.categoryId ?? ""}`;
  }

  private safeSend(ws: WebSocketLike, frame: Record<string, unknown>): void {
    if (!this.isCurrent(ws) || ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      this.log("warn", `Failed to send Kick discovery frame: ${errorMessage(error)}`);
    }
  }

  private scheduleClientPing(ws: WebSocketLike): void {
    if (!this.isCurrent(ws) || this.subscribedSocket !== ws || this.clientPingTimer !== undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    timer = this.scheduleKeepAlive(() => {
      if (this.clientPingTimer !== timer) return;
      this.clientPingTimer = undefined;
      if (!this.isCurrent(ws) || this.subscribedSocket !== ws) return;
      this.safeSend(ws, { event: "pusher:ping", data: {} });
      this.schedulePongTimeout(ws);
    }, CLIENT_PING_INTERVAL_MS);
    this.clientPingTimer = timer;
  }

  private schedulePongTimeout(ws: WebSocketLike): void {
    if (!this.isCurrent(ws) || this.subscribedSocket !== ws || this.clientPongTimer !== undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    timer = this.scheduleKeepAlive(() => {
      if (this.clientPongTimer !== timer) return;
      this.clientPongTimer = undefined;
      if (!this.isCurrent(ws) || this.subscribedSocket !== ws) return;
      this.log("warn", `Kick discovery client ping timed out for category ${this.categoryId}`);
      this.closeSocketAndReconnect(ws);
    }, CLIENT_PONG_TIMEOUT_MS);
    this.clientPongTimer = timer;
  }

  private clearKeepAlive(): void {
    if (this.clientPingTimer !== undefined) {
      this.cancelKeepAlive(this.clientPingTimer);
      this.clientPingTimer = undefined;
    }
    if (this.clientPongTimer !== undefined) {
      this.cancelKeepAlive(this.clientPongTimer);
      this.clientPongTimer = undefined;
    }
  }

  private closeSocketAndReconnect(ws: WebSocketLike): void {
    if (!this.isCurrent(ws)) return;
    this.ws = undefined;
    this.clearKeepAlive();
    this.subscribedSocket = undefined;
    this.intentionallyClosedSockets.add(ws);
    try {
      ws.close();
    } catch {
      // Reconnect is still scheduled when transport close is best-effort.
    }
    this.scheduleNextReconnect();
  }

  private scheduleNextReconnect(): void {
    if (this.stopped || !this.categoryId || this.reconnectTimer !== undefined) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * (2 ** this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    let timer: ReturnType<typeof setTimeout>;
    timer = this.scheduleReconnect(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer = timer;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.cancelReconnect(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeCurrentSocket(): void {
    this.clearKeepAlive();
    this.subscribedSocket = undefined;
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    this.intentionallyClosedSockets.add(ws);
    try {
      ws.close();
    } catch {
      // Closing is best-effort; stale callbacks are inert once ws is cleared.
    }
  }
}

function isTerminalPusherClose(code: number | undefined): boolean {
  return code !== undefined && code >= 4_000 && code <= 4_099;
}

interface PusherFrame {
  event: string;
  channel?: string;
  data?: unknown;
}

function parseFrame(value: unknown): PusherFrame | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.event !== "string") return undefined;
    return {
      event: parsed.event,
      channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
      data: parsed.data,
    };
  } catch {
    return undefined;
  }
}

function decodePusherData(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== "string") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function isCampaignId(value: unknown): value is string | number {
  return (typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
