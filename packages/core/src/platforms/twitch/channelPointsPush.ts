import type { DiagnosticEvent } from "@lurkloot/shared/events";
import { PendingDiscoverySignalDiagnostics } from "../../core/discoverySignals";
import type { WebSocketFactory, WebSocketLike } from "../../core/webSocket";

export const TWITCH_HERMES_KEEPALIVE_DEFAULT_SEC = 15;
export const TWITCH_CHANNEL_POINTS_TOPIC_PREFIX = "community-points-user-v1.";

const DEFAULT_TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const WEBSOCKET_OPEN = 1;

export interface TwitchChannelPointsClaimNotice {
  claimId: string;
  channelId: string;
}

export interface TwitchChannelPointsPushDeps {
  createWebSocket: WebSocketFactory;
  getAuthToken: () => Promise<string | undefined>;
  resolveUserId: () => Promise<string | undefined>;
  clientId?: string;
  scheduleReconnect?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelReconnect?: (timer: ReturnType<typeof setTimeout>) => void;
  scheduleKeepAlive?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelKeepAlive?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class TwitchChannelPointsPushController {
  private ws?: WebSocketLike;
  private onClaimAvailable?: (notice: TwitchChannelPointsClaimNotice) => void;
  private authToken?: string;
  private userId?: string;
  private pendingAuthId?: string;
  private pendingSubscribeFrameId?: string;
  private pendingSubscriptionId?: string;
  private subscriptionId?: string;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private keepAliveTimer?: ReturnType<typeof setTimeout>;
  private keepaliveSec = TWITCH_HERMES_KEEPALIVE_DEFAULT_SEC;
  private stopped = true;
  private readonly clientId: string;
  private readonly createWebSocket: WebSocketFactory;
  private readonly getAuthToken: TwitchChannelPointsPushDeps["getAuthToken"];
  private readonly resolveUserId: TwitchChannelPointsPushDeps["resolveUserId"];
  private readonly scheduleReconnect: NonNullable<TwitchChannelPointsPushDeps["scheduleReconnect"]>;
  private readonly cancelReconnect: NonNullable<TwitchChannelPointsPushDeps["cancelReconnect"]>;
  private readonly scheduleKeepAlive: NonNullable<TwitchChannelPointsPushDeps["scheduleKeepAlive"]>;
  private readonly cancelKeepAlive: NonNullable<TwitchChannelPointsPushDeps["cancelKeepAlive"]>;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly intentionallyClosedSockets = new WeakSet<WebSocketLike>();

  constructor(deps: TwitchChannelPointsPushDeps) {
    this.createWebSocket = deps.createWebSocket;
    this.getAuthToken = deps.getAuthToken;
    this.resolveUserId = deps.resolveUserId;
    this.clientId = deps.clientId ?? DEFAULT_TWITCH_CLIENT_ID;
    this.scheduleReconnect = deps.scheduleReconnect ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelReconnect = deps.cancelReconnect ?? ((timer) => clearTimeout(timer));
    this.scheduleKeepAlive = deps.scheduleKeepAlive ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelKeepAlive = deps.cancelKeepAlive ?? ((timer) => clearTimeout(timer));
  }

  get subscribed(): boolean {
    return this.subscriptionId !== undefined;
  }

  async start(onClaimAvailable: (notice: TwitchChannelPointsClaimNotice) => void): Promise<void> {
    this.onClaimAvailable = onClaimAvailable;
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  drainEvents(): DiagnosticEvent[] {
    return this.diagnostics.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.closeCurrentSocket();
    this.reconnectAttempt = 0;
    this.authToken = undefined;
    this.userId = undefined;
    this.onClaimAvailable = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const token = await this.getAuthToken();
    if (this.stopped) return;
    if (typeof token !== "string" || token === "") {
      this.log("debug", "Twitch channel-points push is missing an auth token");
      this.scheduleNextReconnect();
      return;
    }
    this.authToken = token;

    const userId = (await this.resolveUserId())?.trim();
    if (this.stopped) return;
    this.userId = userId || undefined;

    const url = `wss://hermes.twitch.tv/v1?clientId=${this.clientId}`;
    let ws: WebSocketLike;
    try {
      ws = this.createWebSocket(url);
    } catch (error) {
      this.log("warn", `Failed to open Twitch channel-points WebSocket: ${errorMessage(error)}`);
      this.scheduleNextReconnect();
      return;
    }
    this.ws = ws;
    this.log("debug", "Opening Twitch channel-points push connection");

    ws.addEventListener("message", (event) => {
      if (!this.isCurrent(ws)) return;
      this.handleMessage(ws, event);
    });
    ws.addEventListener("close", () => {
      if (!this.isCurrent(ws)) {
        this.intentionallyClosedSockets.delete(ws);
        return;
      }
      if (this.intentionallyClosedSockets.delete(ws)) return;
      this.ws = undefined;
      this.clearKeepAlive();
      this.clearHandshakeState();
      this.log("debug", "Twitch channel-points push connection closed");
      this.scheduleNextReconnect();
    });
  }

  private isCurrent(ws: WebSocketLike): boolean {
    return !this.stopped && ws === this.ws;
  }

  private handleMessage(ws: WebSocketLike, event: { data?: unknown }): void {
    const frame = parseFrame(event.data);
    if (!frame) {
      this.log("debug", "Ignored malformed Twitch channel-points push frame");
      return;
    }

    switch (frame.type) {
      case "welcome":
        this.handleWelcome(ws, frame);
        return;
      case "keepalive":
        this.resetSilenceTimeout();
        return;
      case "authenticateResponse":
        this.handleAuthenticateResponse(ws, frame);
        return;
      case "subscribeResponse":
        this.handleSubscribeResponse(frame);
        return;
      case "notification":
        this.handleNotification(frame);
        return;
      default:
        this.log("debug", "Ignored Twitch channel-points push frame");
        return;
    }
  }

  private handleWelcome(ws: WebSocketLike, frame: HermesFrame): void {
    this.keepaliveSec = readKeepaliveSec(frame.welcome);
    this.resetSilenceTimeout();
    const token = this.authToken;
    if (typeof token !== "string" || token === "") {
      this.log("debug", "Twitch channel-points push is missing an auth token");
      this.closeCurrentSocket();
      this.scheduleNextReconnect();
      return;
    }
    const id = crypto.randomUUID();
    this.pendingAuthId = id;
    this.safeSend(ws, {
      type: "authenticate",
      id,
      authenticate: { token },
      timestamp: new Date().toISOString(),
    });
  }

  private handleAuthenticateResponse(ws: WebSocketLike, frame: HermesFrame): void {
    const response = frame.authenticateResponse;
    if (!isRecord(response)) {
      this.log("debug", "Ignored malformed Twitch channel-points push frame");
      return;
    }
    if (frame.parentId !== this.pendingAuthId) return;
    if (response.result !== "ok") {
      this.log("debug", "Twitch channel-points push authenticate was not ok");
      this.closeCurrentSocket();
      this.scheduleNextReconnect();
      return;
    }

    const userId = this.userId;
    if (!userId) {
      this.log("debug", "Twitch channel-points push is missing a user id");
      this.closeCurrentSocket();
      this.scheduleNextReconnect();
      return;
    }

    const id = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    this.pendingSubscribeFrameId = id;
    this.pendingSubscriptionId = subscriptionId;
    this.safeSend(ws, {
      type: "subscribe",
      id,
      subscribe: {
        id: subscriptionId,
        type: "pubsub",
        pubsub: { topic: `${TWITCH_CHANNEL_POINTS_TOPIC_PREFIX}${userId}` },
      },
      timestamp: new Date().toISOString(),
    });
  }

  private handleSubscribeResponse(frame: HermesFrame): void {
    const response = frame.subscribeResponse;
    if (!isRecord(response)) {
      this.log("debug", "Ignored malformed Twitch channel-points push frame");
      return;
    }
    const subscription = response.subscription;
    if (
      frame.parentId !== this.pendingSubscribeFrameId
      || response.result !== "ok"
      || !isRecord(subscription)
      || subscription.id !== this.pendingSubscriptionId
    ) return;
    this.subscriptionId = this.pendingSubscriptionId;
    this.reconnectAttempt = 0;
    this.log("debug", `Twitch channel-points push subscribed to ${TWITCH_CHANNEL_POINTS_TOPIC_PREFIX}${this.userId}`);
  }

  private handleNotification(frame: HermesFrame): void {
    const notification = frame.notification;
    if (!isRecord(notification)) {
      this.log("debug", "Ignored malformed Twitch channel-points push frame");
      return;
    }
    const subscription = notification.subscription;
    if (!isRecord(subscription) || subscription.id !== this.subscriptionId) {
      this.log("debug", "Ignored Twitch channel-points push notification");
      return;
    }
    const inner = parsePubsub(notification.pubsub);
    if (!inner) {
      this.log("debug", "Ignored malformed Twitch channel-points push frame");
      return;
    }
    const data = inner.data;
    const claim = isRecord(data) ? data.claim : undefined;
    if (
      inner.type !== "claim-available"
      || !isRecord(claim)
      || typeof claim.id !== "string"
      || claim.id.length === 0
      || typeof claim.channel_id !== "string"
      || claim.channel_id.length === 0
    ) {
      this.log("debug", "Ignored Twitch channel-points push notification");
      return;
    }
    try {
      this.onClaimAvailable?.({ claimId: claim.id, channelId: claim.channel_id });
    } catch (error) {
      this.log("warn", `Twitch channel-points push claim callback failed: ${errorMessage(error)}`);
    }
  }

  private safeSend(ws: WebSocketLike, frame: Record<string, unknown>): void {
    if (!this.isCurrent(ws) || ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      this.log("warn", `Failed to send Twitch channel-points push frame: ${errorMessage(error)}`);
    }
  }

  private resetSilenceTimeout(): void {
    this.clearKeepAlive();
    const delayMs = 2 * this.keepaliveSec * 1000;
    let timer: ReturnType<typeof setTimeout>;
    timer = this.scheduleKeepAlive(() => {
      if (this.keepAliveTimer !== timer) return;
      this.keepAliveTimer = undefined;
      if (this.stopped || !this.ws) return;
      this.log("debug", "Twitch channel-points push keepalive timed out");
      this.closeCurrentSocket();
      this.scheduleNextReconnect();
    }, delayMs);
    this.keepAliveTimer = timer;
  }

  private scheduleNextReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * (2 ** this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    let timer: ReturnType<typeof setTimeout>;
    timer = this.scheduleReconnect(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer = timer;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.cancelReconnect(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer === undefined) return;
    this.cancelKeepAlive(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  private clearHandshakeState(): void {
    this.pendingAuthId = undefined;
    this.pendingSubscribeFrameId = undefined;
    this.pendingSubscriptionId = undefined;
    this.subscriptionId = undefined;
  }

  private closeCurrentSocket(): void {
    this.clearKeepAlive();
    this.clearHandshakeState();
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

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "twitch", level, message });
  }
}

interface HermesFrame {
  type: string;
  parentId?: unknown;
  welcome?: unknown;
  authenticateResponse?: unknown;
  subscribeResponse?: unknown;
  notification?: unknown;
}

function parseFrame(value: unknown): HermesFrame | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;
    return {
      type: parsed.type,
      parentId: parsed.parentId,
      welcome: parsed.welcome,
      authenticateResponse: parsed.authenticateResponse,
      subscribeResponse: parsed.subscribeResponse,
      notification: parsed.notification,
    };
  } catch {
    return undefined;
  }
}

function readKeepaliveSec(welcome: unknown): number {
  if (!isRecord(welcome)) return TWITCH_HERMES_KEEPALIVE_DEFAULT_SEC;
  const value = welcome.keepaliveSec;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : TWITCH_HERMES_KEEPALIVE_DEFAULT_SEC;
}

function parsePubsub(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
