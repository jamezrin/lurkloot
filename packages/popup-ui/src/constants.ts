import type { CampaignFilterKey, Platform } from "@lurkloot/shared/models";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { ScreenshotVariant } from "./types";

export const PLATFORMS: Record<Platform, { label: string; mark: string; color: string }> = {
  twitch: { label: "Twitch", mark: "T", color: "#9147ff" },
  kick: { label: "Kick", mark: "K", color: "#53fc18" },
};

export const SELECTED_PLATFORM_KEY = "popup:selectedPlatform";
export const COLLAPSED_SETTINGS_SECTIONS_KEY = "popup:collapsedSettingsSections";

// Chrome Web Store listing for the rate/review nudge. Single source of truth for
// the store id so the reviews URL stays correct if the listing slug changes.
export const CHROME_WEB_STORE_ID = "aobaackpofkghaejdnnmpmeaiaoibhdn";
export const CHROME_WEB_STORE_REVIEW_URL = `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}/reviews`;
// How long after install before the one-time "rate it" nudge appears.
export const RATE_NUDGE_MIN_DAYS = 3;

export const GAME_ACCENTS = ["#2563eb", "#0891b2", "#ef4444", "#16a34a", "#9333ea", "#f59e0b"];

export const CAMPAIGN_TINTS = [
  "from-orange-400 via-sky-400 to-blue-700",
  "from-cyan-400 via-zinc-700 to-rose-500",
  "from-red-600 via-pink-500 to-cyan-300",
  "from-zinc-700 via-slate-500 to-emerald-500",
  "from-violet-500 via-fuchsia-400 to-emerald-300",
  "from-amber-400 via-red-500 to-zinc-800",
];

export const REWARD_TINTS = [
  "from-lime-200 via-zinc-100 to-sky-200",
  "from-lime-500 via-zinc-800 to-cyan-600",
  "from-fuchsia-400 via-pink-300 to-lime-300",
  "from-cyan-400 via-emerald-500 to-zinc-800",
  "from-orange-400 via-red-500 to-zinc-800",
  "from-yellow-100 via-zinc-100 to-stone-200",
  "from-blue-400 via-blue-600 to-zinc-100",
  "from-zinc-100 via-emerald-200 to-slate-500",
];

export const EVENT_LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "#6366f1",
  info: "#a1a1aa",
  warn: "#f59e0b",
  error: "#ef4444",
};

export const CAMPAIGN_FILTERS: Array<{ key: CampaignFilterKey; label: string }> = [
  { key: "notLinked", label: "notLinked" },
  { key: "upcoming", label: "upcoming" },
  { key: "expired", label: "expired" },
  { key: "excluded", label: "excluded" },
  { key: "finished", label: "finished" },
];

const TWITCH_GRADIENT =
  "radial-gradient(circle_at_22%_24%,rgba(145,71,255,0.34),transparent_32%),radial-gradient(circle_at_78%_78%,rgba(83,252,24,0.18),transparent_28%)";
const KICK_GRADIENT =
  "radial-gradient(circle_at_22%_24%,rgba(83,252,24,0.30),transparent_32%),radial-gradient(circle_at_78%_78%,rgba(145,71,255,0.20),transparent_28%)";

export const SCREENSHOT_VARIANTS: Record<string, ScreenshotVariant> = {
  "twitch-drops": {
    platform: "twitch",
    view: "drops",
    accentGradient: TWITCH_GRADIENT,
    headlineKey: "screenshotTwitchHeadline",
    subcopyKey: "screenshotTwitchSubcopy",
  },
  "kick-drops": {
    platform: "kick",
    view: "drops",
    accentGradient: KICK_GRADIENT,
    headlineKey: "screenshotKickHeadline",
    subcopyKey: "screenshotKickSubcopy",
  },
  "watch-queue": {
    platform: "twitch",
    view: "watchQueue",
    accentGradient: TWITCH_GRADIENT,
    headlineKey: "screenshotQueueHeadline",
    subcopyKey: "screenshotQueueSubcopy",
  },
  settings: {
    platform: "twitch",
    view: "settings",
    accentGradient: TWITCH_GRADIENT,
    headlineKey: "screenshotSettingsHeadline",
    subcopyKey: "screenshotSettingsSubcopy",
  },
  activity: {
    platform: "twitch",
    view: "activity",
    accentGradient: TWITCH_GRADIENT,
    headlineKey: "screenshotActivityHeadline",
    subcopyKey: "screenshotActivitySubcopy",
  },
};

export const PROMO_GRADIENT =
  "radial-gradient(circle at 16% 18%, rgba(145,71,255,0.40), transparent 38%), radial-gradient(circle at 86% 82%, rgba(83,252,24,0.26), transparent 40%)";
