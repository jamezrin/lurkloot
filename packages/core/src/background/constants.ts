import type { Platform } from "@lurkloot/shared/models";

export const ALARM_NAME = "lurkloot.tick";
export const TWITCH_ALARM_NAME = "lurkloot.tick.twitch";
export const KICK_ALARM_NAME = "lurkloot.tick.kick";
// A separate alarm drives tabless watch heartbeats independently of the
// (heavier, configurable) discovery tick. Chrome 120+ allows a 30-second
// minimum; older Chrome still clamps this to one minute. The HLS watcher also
// polls every 10 seconds while the process stays alive, and a wake that is not
// yet due for the minute health commit runs one segment poll.
export const WATCH_ALARM_NAME = "lurkloot.watch";
export const WATCH_ALARM_PERIOD_MINUTES = 0.5;
export const TWITCH_CHANNEL_POINTS_ALARM_NAME = "lurkloot.twitch-channel-points";
export const TWITCH_DROP_CLAIMS_ALARM_NAME = "lurkloot.twitch-drop-claims";
export const KICK_DROP_CLAIMS_ALARM_NAME = "lurkloot.kick-drop-claims";
export const KICK_CHALLENGES_ALARM_NAME = "lurkloot.kick-challenges";
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

export const PLATFORMS: Platform[] = ["twitch", "kick"];
export const PLATFORM_NAMES: Record<Platform, string> = { twitch: "Twitch", kick: "Kick" };
