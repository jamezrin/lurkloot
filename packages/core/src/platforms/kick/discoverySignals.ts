import type { DiagnosticEvent } from "@lurkloot/shared/events";
import {
  PendingDiscoverySignalDiagnostics,
  type DiscoverySignalController,
  type DiscoverySignalTarget,
} from "../../core/discoverySignals";
import type { WebSocketFactory } from "../../core/webSocket";
import { KickRealtimeConnection } from "./realtime";

const CHANNEL_PREFIX = "drops_category_";
const CAMPAIGN_STARTED_EVENT = "drops_campaign_started";

export interface KickDiscoverySignalDeps {
  createWebSocket: WebSocketFactory;
  // POSTs Kick's realtime negotiation. Background only: discovery runs during
  // every Kick farm and must never open a page-context tab.
  postJson: (url: string, body: unknown) => Promise<unknown>;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  randomId?: () => string;
  // A connection shared with other owners (Kick chat presence), which the
  // host built for its own sockets and providers. Without it, discovery opens
  // its own, Pusher only.
  connection?: KickRealtimeConnection;
}

// Kick discovery signals (#384) as an owner on Kick's negotiated realtime
// connection (#755): drops_category_<category> for drops_campaign_started.
// A host may share its connection (Centrifugo through the kick.com relay on
// Chrome). Otherwise discovery opens its own, accepting Pusher only, since
// Kick's Centrifugo refuses this host's origin.
export class KickDiscoverySignalController implements DiscoverySignalController {
  readonly platform = "kick" as const;

  private categoryId?: string;
  private onSignal?: () => void;
  private connection?: KickRealtimeConnection;
  // The category whose confirmed subscription was last logged.
  private loggedSubscription?: string;
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();

  constructor(private readonly deps: KickDiscoverySignalDeps) {}

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

    const previous = this.categoryId;
    this.categoryId = categoryId;
    const connection = this.connection ??= this.deps.connection ?? new KickRealtimeConnection({
      createWebSocket: this.deps.createWebSocket,
      postJson: this.deps.postJson,
      acceptedProviders: ["pusher"],
      ...(this.deps.setTimer ? { setTimer: this.deps.setTimer } : {}),
      ...(this.deps.clearTimer ? { clearTimer: this.deps.clearTimer } : {}),
      ...(this.deps.randomId ? { randomId: this.deps.randomId } : {}),
    });
    // The new category first, then the old one leaves: one socket throughout.
    connection.subscribe(channelName(categoryId), {
      events: [CAMPAIGN_STARTED_EVENT],
      onEvent: (_event, data) => this.accept(categoryId, data),
    });
    if (previous) connection.unsubscribe(channelName(previous));
    this.log("debug", `Kick discovery following category ${categoryId}`);
    connection.start();
  }

  drainEvents(): DiagnosticEvent[] {
    const categoryId = this.categoryId;
    if (categoryId && this.loggedSubscription !== categoryId && this.connection?.isSubscribed(channelName(categoryId))) {
      this.loggedSubscription = categoryId;
      this.log("debug", `Kick discovery subscribed to category ${categoryId}`);
    }
    return [...(this.connection?.drainEvents() ?? []), ...this.diagnostics.drain()];
  }

  async stop(): Promise<void> {
    const categoryId = this.categoryId;
    this.categoryId = undefined;
    this.onSignal = undefined;
    this.loggedSubscription = undefined;
    const connection = this.connection;
    this.connection = undefined;
    // Leave only our own channel; the connection closes once nobody needs it.
    if (categoryId) connection?.unsubscribe(channelName(categoryId));
    await connection?.releaseIfIdle();
  }

  private accept(categoryId: string, data: unknown): void {
    if (categoryId !== this.categoryId) return;
    if (!isCampaignId(data)) {
      this.log("debug", "Ignored malformed Kick discovery frame");
      return;
    }
    this.log("debug", `Accepted Kick campaign-start discovery signal for category ${categoryId}`);
    try {
      this.onSignal?.();
    } catch (error) {
      this.log("warn", `Kick discovery signal callback failed: ${errorMessage(error)}`);
    }
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }
}

function channelName(categoryId: string): string {
  return `${CHANNEL_PREFIX}${categoryId}`;
}

function isCampaignId(value: unknown): value is string | number {
  return (typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isFinite(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
