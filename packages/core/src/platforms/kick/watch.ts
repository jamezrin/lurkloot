import type { ChannelCandidate } from "@lurkloot/shared/models";
import { PendingWatcherDiagnostics, type HeartbeatResult, type TablessWatchController, type WatchContext } from "../../core/tablessWatch";
import type { WebSocketFactory, WebSocketLike } from "../../core/webSocket";
import type { PageFetcher } from "../adapter";

// Tabless Kick farming: a viewer WebSocket that advances drop timers with no
// video. Mirrors kickautodrops (references/kickautodrops/core/kick.py:255-436):
// exchange the session token for a viewer token, open the viewer socket, send a
// handshake/ping cadence, and emit a `tracking.user.watch.livestream` event on
// Kick's own interval. The constant client token is from kick.py:281.
export const KICK_CLIENT_TOKEN = "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823";

// Kick's web client sends `channel_handshake` every 15 s and `ping` every 30 s,
// each on its own timer (#756).
export const KICK_HANDSHAKE_INTERVAL_MS = 15_000;
export const KICK_PING_INTERVAL_MS = 30_000;
// The web client reads its tracking interval, in seconds, from this endpoint
// (`events["tracking.user.watch.livestream"].interval`, 120 in October 2026)
// and caches it for 10 minutes. A missing or failed read uses the default.
export const KICK_GLOBAL_SETTINGS_URL = "https://kick.com/api/internal/settings/global";
export const KICK_DEFAULT_WATCH_EVENT_INTERVAL_MS = 120_000;
const WATCH_EVENT_INTERVAL_MIN_MS = 30_000;
const WATCH_EVENT_INTERVAL_MAX_MS = 300_000;
const GLOBAL_SETTINGS_TTL_MS = 10 * 60_000;
// A tick sends an overdue watch event itself only past this grace, so it never
// races the timer that is about to send it.
const WATCH_EVENT_TICK_GRACE_MS = 5_000;
const STREAM_TARGET_REFRESH_MS = 60_000;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

interface KickChannelTargets {
  channelId: string;
  liveStreamId?: string;
  // Sent with each tracking event when Kick reports one, as the web client does.
  vodId?: string;
  isLive: boolean;
  categoryId?: string;
}

export interface KickWatcherDeps {
  fetcher: PageFetcher;
  // Injectable for tests; defaults to the platform WebSocket. The socket is
  // opened from the background service worker — see the Origin caveat below.
  createWebSocket?: WebSocketFactory;
  now?: () => number;
}

// NOTE: the viewer socket is opened from the service worker, whose Origin is the
// extension, not https://kick.com. If Kick rejects the handshake on that basis
// the watcher reports unhealthy and the scheduler falls back to a real tab, so
// farming still works — it just is not tabless for Kick in that case.
export class KickWatcher implements TablessWatchController {
  readonly platform = "kick" as const;

  private channel?: ChannelCandidate;
  private targets?: KickChannelTargets;
  private ws?: WebSocketLike;
  private connected = false;
  private failed = false;
  private failureMessage?: string;
  private lastWatchSentAt = 0;
  private lastHandshakeSentAt = 0;
  private lastPingSentAt = 0;
  private lastTargetRefreshAt = 0;
  // Whether we have surfaced the one-shot "tabless farming active" info line for
  // the current connection. Reset on connect/stop so each session announces once.
  private watchAnnounced = false;
  private handshakeTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private watchEventIntervalMs = KICK_DEFAULT_WATCH_EVENT_INTERVAL_MS;
  private watchEventIntervalReadAt?: number;

  private readonly fetcher: PageFetcher;
  private readonly createWebSocket: WebSocketFactory;
  private readonly now: () => number;
  private readonly diagnostics = new PendingWatcherDiagnostics();
  private readonly intentionallyClosedSockets = new WeakSet<WebSocketLike>();

  constructor(deps: KickWatcherDeps) {
    this.fetcher = deps.fetcher;
    this.createWebSocket = deps.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.now = deps.now ?? (() => Date.now());
  }

  get channelUrl(): string | undefined {
    return this.channel?.url;
  }

  drainEvents() {
    // A watcher outlives its creating adapter/tick. Reconnect and target-refresh
    // counts belong to its own drained heartbeat operation.
    this.fetcher.flushRouteDiagnostics?.(this.diagnostics.emit);
    return this.diagnostics.drain();
  }

  private log(level: "info" | "warn" | "debug" | "error", message: string): void {
    this.diagnostics.push({ category: "diagnostic", platform: "kick", level, message });
  }

  async start(channel: ChannelCandidate, _context: WatchContext): Promise<void> {
    if (this.channel?.url === channel.url && (this.connected || this.ws)) return;
    await this.stop();
    this.channel = channel;
    this.failed = false;
    this.failureMessage = undefined;
    await this.connect();
  }

  async tick(_context: WatchContext): Promise<HeartbeatResult> {
    if (!this.channel) return { ok: false, message: "Kick tabless watcher has no channel" };
    // A socket that is no longer open is down even if its close event has not
    // run. Reconnect unless this is a hard failure, which falls back to a tab.
    if (this.ws && this.ws.readyState !== WEBSOCKET_OPEN && this.ws.readyState !== WEBSOCKET_CONNECTING) {
      this.connected = false;
    }
    if (!this.connected && !this.failed && this.ws?.readyState !== WEBSOCKET_CONNECTING) await this.connect();
    if (this.failed) {
      return { ok: false, live: this.targets?.isLive ?? true, message: this.failureMessage ?? "Kick viewer connection failed" };
    }
    if (!this.targets?.isLive) {
      return { ok: false, live: false, message: "Kick channel is offline" };
    }
    await this.refreshTargetsIfDue();
    if (!this.targets?.isLive) {
      return { ok: false, live: false, message: "Kick channel is offline" };
    }
    const expectedCategoryId = this.channel.categoryId;
    if (expectedCategoryId && this.targets.categoryId && this.targets.categoryId !== expectedCategoryId) {
      return { ok: false, live: true, message: "Kick channel category no longer matches" };
    }
    if (!this.targets.liveStreamId) {
      return { ok: false, live: true, message: "Kick channel is missing a livestream id" };
    }
    // The timers may not have run (a suspended worker); catch up on what is overdue.
    if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastHandshakeSentAt >= KICK_HANDSHAKE_INTERVAL_MS) this.sendHandshake();
    if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastPingSentAt >= KICK_PING_INTERVAL_MS) this.sendPing();
    if (this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastWatchSentAt >= this.watchEventIntervalMs + WATCH_EVENT_TICK_GRACE_MS) {
      this.sendWatchEventAndReschedule();
    }
    const healthy = this.ws?.readyState === WEBSOCKET_OPEN && this.now() - this.lastWatchSentAt < this.healthWindowMs();
    return { ok: healthy, live: true, message: healthy ? undefined : "Kick viewer connection idle" };
  }

  async stop(): Promise<void> {
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.intentionallyClosedSockets.add(ws);
      try {
        ws.close();
      } catch {
        // The socket may already be closing; nothing to do.
      }
      this.ws = undefined;
    }
    this.connected = false;
    this.lastWatchSentAt = 0;
    this.lastHandshakeSentAt = 0;
    this.lastPingSentAt = 0;
    this.lastTargetRefreshAt = 0;
    this.watchAnnounced = false;
    this.targets = undefined;
  }

  private releaseSocket(): void {
    this.clearTimers();
    const ws = this.ws;
    if (!ws) return;
    this.intentionallyClosedSockets.add(ws);
    this.ws = undefined;
    this.connected = false;
    try {
      ws.close();
    } catch {
      // The socket may already be closing.
    }
  }

  private async connect(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.log("debug", `Opening Kick viewer connection for ${channel.username}`);
    this.watchAnnounced = false;
    try {
      this.releaseSocket();
      this.targets = await this.fetchTargets(channel);
      this.lastTargetRefreshAt = this.now();
      if (!this.targets.isLive) {
        // Offline: let the scheduler re-evaluate via live:false; not a failure.
        this.connected = false;
        this.log("debug", `Kick channel ${channel.username} is offline; skipping the viewer connection`);
        return;
      }
      await this.refreshWatchEventInterval();
      const token = await this.fetchViewerToken();
      const ws = this.createWebSocket(`wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.addEventListener("open", () => {
        if (ws !== this.ws) return;
        this.connected = true;
        this.sendHandshake();
        this.sendPing();
        // The web client tracks at once, then once per interval.
        this.sendWatchEventAndReschedule();
        this.startProtocolTimers();
        this.log("info", `Kick tabless viewer connected for ${channel.username}`);
      });
      ws.addEventListener("close", () => {
        if (ws !== this.ws) {
          this.intentionallyClosedSockets.delete(ws);
          return;
        }
        if (this.intentionallyClosedSockets.delete(ws)) return;
        this.connected = false;
        this.log("debug", `Kick viewer connection closed for ${channel.username}`);
      });
      ws.addEventListener("error", () => {
        if (ws !== this.ws) return;
        this.connected = false;
        this.failed = true;
        this.failureMessage = "Kick viewer WebSocket error; falling back to a watch tab";
        this.log("warn", `${this.failureMessage} (${channel.username})`);
      });
    } catch (error) {
      this.failed = true;
      this.failureMessage = error instanceof Error ? error.message : "Kick viewer connection failed";
      this.log("warn", this.failureMessage);
    }
  }

  // A healthy watch has sent a tracking event within two intervals, plus slack.
  private healthWindowMs(): number {
    return 2 * this.watchEventIntervalMs + 30_000;
  }

  private clearTimers(): void {
    if (this.handshakeTimer) clearInterval(this.handshakeTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.handshakeTimer = undefined;
    this.pingTimer = undefined;
    this.watchTimer = undefined;
  }

  private startProtocolTimers(): void {
    if (this.handshakeTimer) clearInterval(this.handshakeTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.handshakeTimer = setInterval(() => {
      if (this.connected) this.sendHandshake();
    }, KICK_HANDSHAKE_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      if (this.connected) this.sendPing();
    }, KICK_PING_INTERVAL_MS);
  }

  // Each tracking event is timed from the previous one, so the cadence holds at
  // the interval instead of drifting to the next check after it.
  private sendWatchEventAndReschedule(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.sendWatchEvent();
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      if (this.connected) this.sendWatchEventAndReschedule();
    }, this.watchEventIntervalMs);
  }

  private async refreshWatchEventInterval(): Promise<void> {
    if (this.watchEventIntervalReadAt !== undefined && this.now() - this.watchEventIntervalReadAt < GLOBAL_SETTINGS_TTL_MS) return;
    this.watchEventIntervalReadAt = this.now();
    try {
      const settings = await this.fetcher.fetchJson<{
        events?: Record<string, { interval?: unknown } | undefined>;
      }>(KICK_GLOBAL_SETTINGS_URL, undefined, this.diagnostics.emit);
      const seconds = settings?.events?.["tracking.user.watch.livestream"]?.interval;
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new Error("no tracking interval");
      this.watchEventIntervalMs = Math.min(WATCH_EVENT_INTERVAL_MAX_MS, Math.max(WATCH_EVENT_INTERVAL_MIN_MS, Math.round(seconds * 1000)));
    } catch (error) {
      this.watchEventIntervalMs = KICK_DEFAULT_WATCH_EVENT_INTERVAL_MS;
      this.log("debug", `Using Kick's default ${KICK_DEFAULT_WATCH_EVENT_INTERVAL_MS / 1000} s watch interval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    this.safeSend({ type: "ping" });
    if (this.connected) this.lastPingSentAt = this.now();
  }

  private sendHandshake(): void {
    if (!this.targets || !this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    this.safeSend({
      type: "channel_handshake",
      data: { message: { channelId: numericOrString(this.targets.channelId) } },
    });
    if (this.connected) this.lastHandshakeSentAt = this.now();
  }

  private sendWatchEvent(): boolean {
    if (!this.targets?.liveStreamId) return false;
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) {
      this.connected = false;
      return false;
    }
    try {
      this.ws.send(JSON.stringify({
        type: "user_event",
        data: {
          message: {
            name: "tracking.user.watch.livestream",
            channel_id: numericOrString(this.targets.channelId),
            livestream_id: numericOrString(this.targets.liveStreamId),
            // Sent as Kick returns it, a string.
            ...(this.targets.vodId ? { vod_id: this.targets.vodId } : {}),
          },
        },
      }));
    } catch (error) {
      this.connected = false;
      this.log("debug", `Kick viewer send failed; will reconnect: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.lastWatchSentAt = this.now();
    // Announce once per connection at info level so "tab-less farming is alive"
    // is visible without the verbose/debug filter; later sends stay debug.
    if (!this.watchAnnounced) {
      this.watchAnnounced = true;
      this.log("info", `Kick tabless farming active for ${this.channel?.username ?? "channel"} — sending watch events every ${Math.round(this.watchEventIntervalMs / 1000)} s`);
    } else {
      this.log("debug", `Sent Kick watch event for ${this.channel?.username ?? "channel"} (livestream ${this.targets.liveStreamId})`);
    }
    return true;
  }

  private async refreshTargetsIfDue(): Promise<void> {
    const channel = this.channel;
    if (!channel || this.now() - this.lastTargetRefreshAt < STREAM_TARGET_REFRESH_MS) return;
    const previousLiveStreamId = this.targets?.liveStreamId;
    this.targets = await this.fetchTargets(channel, { force: true });
    this.lastTargetRefreshAt = this.now();
    this.log("debug", `Refreshed Kick targets for ${channel.username} (live: ${this.targets.isLive}, category: ${this.targets.categoryId ?? "unknown"})`);
    if (
      this.targets.isLive
      && this.targets.liveStreamId
      && this.targets.liveStreamId !== previousLiveStreamId
      && this.connected
    ) {
      this.sendWatchEventAndReschedule();
    }
  }

  private safeSend(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.connected = false;
      this.log("debug", `Kick viewer send failed; will reconnect: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fetchViewerToken(): Promise<string> {
    this.log("debug", `Requesting a Kick viewer token for ${this.channel?.username ?? "channel"}`);
    const response = await this.fetcher.fetchJson<{ data?: { token?: string } }>(
      "https://websockets.kick.com/viewer/v1/token",
      { headers: { "X-Client-Token": KICK_CLIENT_TOKEN } },
      this.diagnostics.emit,
    );
    const token = response?.data?.token;
    if (!token) throw new Error("Kick did not return a viewer token; refresh your Kick login");
    return token;
  }

  // Reads the web client's channel info route, the one that carries `vod_id`.
  // Without `force`, a candidate that already names its ids still connects when
  // the read fails; it just tracks without a VOD id until the next refresh.
  private async fetchTargets(channel: ChannelCandidate, options: { force?: boolean } = {}): Promise<KickChannelTargets> {
    if (!options.force && channel.channelId && channel.broadcastId) {
      const known: KickChannelTargets = {
        channelId: channel.channelId,
        liveStreamId: channel.broadcastId,
        isLive: true,
        categoryId: channel.categoryId,
      };
      try {
        return await this.fetchTargets(channel, { force: true });
      } catch (error) {
        this.log("debug", `Kick channel info for ${channel.username} failed; connecting with the known ids: ${error instanceof Error ? error.message : String(error)}`);
        return known;
      }
    }
    const data = await this.fetcher.fetchJson<{
      id?: string | number;
      livestream?: {
        id?: string | number;
        is_live?: boolean;
        vod_id?: unknown;
        category?: { id?: string | number };
        categories?: Array<{ id?: string | number }>;
      } | null;
    }>(`https://kick.com/api/v2/channels/${encodeURIComponent(channel.username)}/info`, undefined, this.diagnostics.emit);
    const channelId = data.id == null ? channel.channelId : String(data.id);
    if (!channelId) throw new Error(`Could not resolve the Kick channel id for ${channel.username}`);
    const category = data.livestream?.categories?.[0] ?? data.livestream?.category;
    return {
      channelId,
      liveStreamId: data.livestream?.id == null ? channel.broadcastId : String(data.livestream.id),
      ...(typeof data.livestream?.vod_id === "string" && data.livestream.vod_id ? { vodId: data.livestream.vod_id } : {}),
      categoryId: category?.id == null ? channel.categoryId : String(category.id),
      isLive: Boolean(data.livestream?.is_live ?? data.livestream),
    };
  }
}

// Kick's socket payloads use numeric ids; fall back to the raw string if a value
// is not cleanly numeric so we never send NaN.
function numericOrString(value: string): number | string {
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === value ? numeric : value;
}
