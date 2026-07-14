import type { ChannelCandidate, Platform } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EventEmitter } from "@lurkloot/shared/events";

// Persistent sockets/timers can produce diagnostics between controller
// operations. Keep a small bounded FIFO so those events are reported by the
// next operation without retaining an old operation's collector indefinitely.
export const MAX_PENDING_WATCHER_DIAGNOSTICS = 250;

export class PendingWatcherDiagnostics {
  private readonly events: DiagnosticEvent[] = [];
  readonly emit: EventEmitter = (event) => {
    if (event.category === "diagnostic") this.push(event);
  };

  push(event: DiagnosticEvent): void {
    if (this.events.length >= MAX_PENDING_WATCHER_DIAGNOSTICS) this.events.shift();
    this.events.push(event);
  }

  drain(): DiagnosticEvent[] {
    return this.events.splice(0);
  }
}

// Result of one watch-heartbeat cycle. `ok` is whether the watch signal was
// accepted (drop progress should advance); `live: false` tells the scheduler the
// channel went offline so it can re-evaluate; `message` is surfaced to the log.
export interface HeartbeatResult {
  ok: boolean;
  live?: boolean;
  message?: string;
}

// Auth/identity the watcher needs that the adapter cannot infer on its own. The
// Twitch minute-watched event must carry the viewer's own user id.
export interface WatchContext {
  userId?: string;
}

// A per-platform driver that earns drop progress for the currently-selected
// channel without a video tab. Twitch implementations are stateless per tick
// (each tick sends one spade event); Kick keeps a persistent viewer WebSocket
// and self-paces its sends, so its tick() mainly reports connection health.
export interface TablessWatchController {
  readonly platform: Platform;
  // URL of the channel currently being watched, if any. Used to detect when the
  // scheduler has switched targets so the watcher can restart.
  readonly channelUrl: string | undefined;
  // Begin (or switch to) watching the channel. Idempotent for the same channel.
  start(channel: ChannelCandidate, context: WatchContext): Promise<void>;
  // Run one heartbeat cycle and report health.
  tick(context: WatchContext): Promise<HeartbeatResult>;
  // Transfer diagnostics emitted by persistent callbacks/timers since the last
  // controller operation. Draining is destructive and preserves causal order.
  drainEvents(): DiagnosticEvent[];
  // Stop watching and release any persistent connection.
  stop(): Promise<void>;
}
