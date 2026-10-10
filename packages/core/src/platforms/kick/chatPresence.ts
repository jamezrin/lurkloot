import type { DiagnosticEvent } from "@lurkloot/shared/events";
import type { ChatPresenceBlockReason, ChatPresenceStatus } from "@lurkloot/shared/models";
import type { ChatPresenceClient, ChatPresenceTarget } from "../../core/chatPresence";
import { PendingDiscoverySignalDiagnostics } from "../../core/discoverySignals";
import { SafeFetchError } from "../../core/fetchError";
import { KickRealtimeConnection, kickRealtimeNegotiation, parseKickRealtimeEndpoint } from "./realtime";

// Kick chat presence (#754), as Kick's web client joins a channel's chat:
// resolve the channel and chatroom, call the channel's chat/connection as the
// realtime client, then subscribe its chat channels on the shared realtime
// connection. It never calls a send endpoint and never reads chat.

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const CHANNEL_SLUG = /^[a-z0-9_-]{1,64}$/;

type Timer = ReturnType<typeof setTimeout>;

export interface KickChatRoom {
  channelId: string;
  chatroomId: string;
}

export interface KickChatPresenceDeps {
  connection: KickRealtimeConnection;
  // POSTs JSON through the Kick fetcher; throws SafeFetchError on failure.
  postJson: (url: string, body: unknown) => Promise<unknown>;
  // GETs JSON through the Kick fetcher.
  getJson: (url: string) => Promise<unknown>;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

// The channels Kick's web client subscribes for a channel's chat. The
// drops_category_ channel belongs to discovery signals, not presence.
export function kickChatChannels(room: KickChatRoom): string[] {
  return [
    `channel_${room.channelId}`,
    `channel.${room.channelId}`,
    `chatroom_${room.chatroomId}`,
    `chatrooms.${room.chatroomId}`,
    `chatrooms.${room.chatroomId}.v2`,
  ];
}

export class KickChatPresenceClient implements ChatPresenceClient {
  private desired?: string;
  private room?: KickChatRoom & { slug: string };
  private subscribed: string[] = [];
  private failed = false;
  private blockReason?: ChatPresenceBlockReason;
  private stopped = false;
  private attempt = 0;
  private retryTimer?: Timer;
  // Bumped by every follow and stop, so a slow lookup knows it is stale.
  private generation = 0;
  private joinedAnnounced?: string;
  private readonly warned = new Set<string>();
  private readonly diagnostics = new PendingDiscoverySignalDiagnostics();
  private readonly setTimer: NonNullable<KickChatPresenceDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<KickChatPresenceDeps["clearTimer"]>;

  constructor(private readonly deps: KickChatPresenceDeps) {
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async follow(target: ChatPresenceTarget | undefined): Promise<void> {
    if (this.stopped) return;
    const next = target?.username.toLowerCase();
    if (next === this.desired) return;
    this.desired = next;
    this.attempt = 0;
    this.clearRetry();
    const generation = ++this.generation;
    if (!next) {
      this.leave();
      return;
    }
    if (this.blockReason) return;
    await this.join(next, target?.channelId, generation);
  }

  status(): ChatPresenceStatus {
    if (!this.desired) return { state: "left" };
    const channel = { channel: this.desired };
    const realtime = this.deps.connection.status();
    if (this.blockReason) return { state: "blocked", ...channel, reason: this.blockReason };
    if (realtime.state === "blocked") return { state: "blocked", ...channel, reason: realtime.reason ?? "unsupported-provider" };
    if (this.failed || realtime.state === "error") return { state: "error", ...channel };
    const joined = this.room?.slug === this.desired && this.deps.connection.isSubscribed(`chatrooms.${this.room.chatroomId}.v2`);
    if (joined && this.joinedAnnounced !== this.desired) {
      this.joinedAnnounced = this.desired;
      this.log("debug", `Kick chat presence joined ${this.desired}`);
    }
    return { state: joined ? "joined" : "joining", ...channel };
  }

  drainEvents(): DiagnosticEvent[] {
    return [...this.diagnostics.drain(), ...this.deps.connection.drainEvents()];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.clearRetry();
    this.desired = undefined;
    this.leave();
    await this.deps.connection.stop();
  }

  private async join(slug: string, knownChannelId: string | undefined, generation: number): Promise<void> {
    try {
      if (!CHANNEL_SLUG.test(slug)) throw new Error(`Not a Kick channel name: ${slug.slice(0, 64)}`);
      const room = await this.lookupRoom(slug, knownChannelId);
      if (generation !== this.generation) return;
      const clientId = this.deps.connection.clientIdentity();
      const endpoint = parseKickRealtimeEndpoint(await this.deps.postJson(
        `https://web.kick.com/api/v1/realtime/channels/${encodeURIComponent(room.channelId)}/chat/connection`,
        kickRealtimeNegotiation(clientId),
      ));
      if (generation !== this.generation) return;
      // The chat connection may name another endpoint; the shared connection
      // moves there before subscribing.
      this.deps.connection.start(endpoint);
      const previous = this.subscribed;
      const next = kickChatChannels(room);
      for (const channel of next) this.deps.connection.subscribe(channel);
      for (const channel of previous) if (!next.includes(channel)) this.deps.connection.unsubscribe(channel);
      const from = this.room?.slug;
      this.room = { ...room, slug };
      this.subscribed = next;
      this.failed = false;
      this.warned.clear();
      if (from && from !== slug) this.log("debug", `Kick chat presence switched ${from} → ${slug}`);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof SafeFetchError && error.failure.kind === "authentication_rejected") {
        this.blockReason = "auth";
        this.warnOnce("auth", "Kick chat presence stopped: Kick rejected the session");
        return;
      }
      this.failed = true;
      this.warnOnce(`join:${errorMessage(error)}`, `Could not join ${slug}'s Kick chat: ${errorMessage(error)}`);
      this.scheduleRetry(slug, knownChannelId, generation);
    }
  }

  private async lookupRoom(slug: string, knownChannelId: string | undefined): Promise<KickChatRoom> {
    if (this.room?.slug === slug) return this.room;
    const body = record(await this.deps.getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`));
    const channelId = idString(body?.id) ?? knownChannelId;
    const chatroomId = idString(record(body?.chatroom)?.id);
    if (!channelId || !chatroomId) throw new Error("Kick did not name the channel's chatroom");
    return { channelId, chatroomId };
  }

  private scheduleRetry(slug: string, knownChannelId: string | undefined, generation: number): void {
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempt, RETRY_MAX_MS);
    this.attempt += 1;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      if (generation !== this.generation || this.stopped) return;
      void this.join(slug, knownChannelId, generation);
    }, delay);
  }

  private leave(): void {
    const from = this.room?.slug;
    for (const channel of this.subscribed) this.deps.connection.unsubscribe(channel);
    this.subscribed = [];
    this.room = undefined;
    this.failed = false;
    this.joinedAnnounced = undefined;
    this.warned.clear();
    if (from) this.log("debug", `Kick chat presence left ${from}`);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log("warn", message);
  }

  private log(level: "debug" | "warn", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function idString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
