import type { Platform } from "@lurkloot/shared/models";

export const ALARM_NAME = "lurkloot.tick";
export const TWITCH_ALARM_NAME = "lurkloot.tick.twitch";
export const KICK_ALARM_NAME = "lurkloot.tick.kick";
// A separate, fixed 1-minute alarm drives tabless watch heartbeats independently
// of the (heavier, configurable) discovery tick. chrome.alarms clamps to a
// 1-minute minimum, close enough to TwitchDropsMiner's 59s send cadence.
export const WATCH_ALARM_NAME = "lurkloot.watch";
export const TWITCH_CHANNEL_POINTS_ALARM_NAME = "lurkloot.twitch-channel-points";
export const TWITCH_DROP_CLAIMS_ALARM_NAME = "lurkloot.twitch-drop-claims";
export const KICK_DROP_CLAIMS_ALARM_NAME = "lurkloot.kick-drop-claims";
export const KICK_CHALLENGES_ALARM_NAME = "lurkloot.kick-challenges";
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

export const PLATFORMS: Platform[] = ["twitch", "kick"];
