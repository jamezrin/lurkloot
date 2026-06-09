import type { ChannelCandidate, Platform } from "@stream-autopilot/shared/models";

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
  // Stop watching and release any persistent connection.
  stop(): Promise<void>;
}
