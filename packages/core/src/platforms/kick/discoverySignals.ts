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
const WEBSOCKET_OPEN = 1;

export interface KickDiscoverySignalDeps {
  createWebSocket: WebSocketFactory;
  scheduleReconnect?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelReconnect?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class KickDiscoverySignalController implements DiscoverySignalController {
  readonly platform = "kick" as const;

  private categoryId?: string;
  private ws?: WebSocketLike;
  private onSignal?: () => void;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private readonly createWebSocket: WebSocketFactory;
  private readonly scheduleReconnect: NonNullable<KickDiscoverySignalDeps["scheduleReconnect"]>;
  private readonly cancelReconnect: NonNullable<KickDiscoverySignalDeps["cancelReconnect"]>;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly intentionallyClosedSockets = new WeakSet<WebSocketLike>();

  constructor(deps: KickDiscoverySignalDeps) {
    this.createWebSocket = deps.createWebSocket;
    this.scheduleReconnect = deps.scheduleReconnect ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelReconnect = deps.cancelReconnect ?? ((timer) => clearTimeout(timer));
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
    ws.addEventListener("close", () => {
      if (!this.isCurrent(ws)) {
        this.intentionallyClosedSockets.delete(ws);
        return;
      }
      if (this.intentionallyClosedSockets.delete(ws)) return;
      this.ws = undefined;
      this.log("debug", `Kick discovery connection closed for category ${this.categoryId}`);
      this.scheduleNextReconnect();
    });
  }

  private isCurrent(ws: WebSocketLike): boolean {
    return !this.stopped && ws === this.ws;
  }

  private handleMessage(ws: WebSocketLike, event: { data?: unknown }): void {
    const frame = parseFrame(event.data);
    if (!frame) return;

    if (frame.event === "pusher:connection_established") {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) return;
      this.reconnectAttempt = 0;
      this.safeSend(ws, {
        event: "pusher:subscribe",
        data: { auth: "", channel: this.currentChannelName() },
      });
      return;
    }

    if (frame.event === "pusher:ping") {
      const data = decodePusherData(frame.data);
      if (!data.ok || !isRecord(data.value)) return;
      this.safeSend(ws, { event: "pusher:pong", data: {} });
      return;
    }

    if (frame.event !== CAMPAIGN_STARTED_EVENT || frame.channel !== this.currentChannelName()) return;
    const data = decodePusherData(frame.data);
    if (!data.ok || !isCampaignId(data.value)) return;
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

  private scheduleNextReconnect(): void {
    if (this.stopped || !this.categoryId || this.reconnectTimer) return;
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
    if (!this.reconnectTimer) return;
    this.cancelReconnect(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeCurrentSocket(): void {
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
