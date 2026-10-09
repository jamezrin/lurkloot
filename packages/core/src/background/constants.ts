import type { Platform } from "@lurkloot/shared/models";

export const ALARM_NAME = "lurkloot.tick";
export const TWITCH_ALARM_NAME = "lurkloot.tick.twitch";
export const KICK_ALARM_NAME = "lurkloot.tick.kick";
// A separate alarm drives tabless watch heartbeats independently of the
// (heavier, configurable) discovery tick. It runs every minute, the health
// commit cadence (#336). While a watcher polls between commits (Twitch HLS) it
// runs every 30 seconds instead, so a suspended service worker still requests
// new segments; a wake that is not due for the health commit runs one poll.
// Chrome 120+ allows the 30-second period; older Chrome clamps it to a minute.
export const WATCH_ALARM_NAME = "lurkloot.watch";
export const WATCH_ALARM_PERIOD_MINUTES = 1;
export const WATCH_ALARM_SUSTAIN_PERIOD_MINUTES = 0.5;
export const TWITCH_CHANNEL_POINTS_ALARM_NAME = "lurkloot.twitch-channel-points";
export const TWITCH_DROP_CLAIMS_ALARM_NAME = "lurkloot.twitch-drop-claims";
export const KICK_DROP_CLAIMS_ALARM_NAME = "lurkloot.kick-drop-claims";
export const KICK_CHALLENGES_ALARM_NAME = "lurkloot.kick-challenges";
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

export const PLATFORMS: Platform[] = ["twitch", "kick"];
export const PLATFORM_NAMES: Record<Platform, string> = { twitch: "Twitch", kick: "Kick" };
