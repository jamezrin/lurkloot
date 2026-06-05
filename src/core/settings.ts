import type { AdFocusMode, ExtensionSettings, PriorityMode } from "./models";
import { LOG_LEVELS, type LogLevel } from "./logging";

const AD_FOCUS_MODES: AdFocusMode[] = ["none", "tab", "window"];
const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];

export const DEFAULT_SETTINGS: ExtensionSettings = {
  running: false,
  autoClaim: true,
  autoClaimChannelPoints: true,
  tablessMode: false,
  muteFarmingTabs: true,
  keepFarmingVideosUnmuted: true,
  pauseOnManualWatch: true,
  adFocusMode: "window",
  autoCloseFinishedDrops: true,
  notifyRewardEarned: true,
  notifyNoDropsLeft: true,
  autoStartDropFarming: true,
  watchQueueFallbackOnly: true,
  priorityMode: "ending_soonest",
  platform: {
    twitch: {
      enabled: true,
      watchQueueChannels: [],
      excludedChannels: [],
      gamePriority: [],
    },
    kick: {
      enabled: true,
      watchQueueChannels: [],
      excludedChannels: [],
      gamePriority: [],
    },
  },
  campaignPriorities: {},
  excludedCampaignIds: [],
  offlineRetryLimit: 3,
  pollIntervalMinutes: 1,
  enabledLogLevels: ["info", "warn", "error"],
};

export function mergeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  const platform = value?.platform;
  return {
    running: booleanOr(value?.running, DEFAULT_SETTINGS.running),
    autoClaim: booleanOr(value?.autoClaim, DEFAULT_SETTINGS.autoClaim),
    autoClaimChannelPoints: booleanOr(value?.autoClaimChannelPoints, DEFAULT_SETTINGS.autoClaimChannelPoints),
    tablessMode: booleanOr(value?.tablessMode, DEFAULT_SETTINGS.tablessMode),
    muteFarmingTabs: booleanOr(value?.muteFarmingTabs, DEFAULT_SETTINGS.muteFarmingTabs),
    keepFarmingVideosUnmuted: booleanOr(value?.keepFarmingVideosUnmuted, DEFAULT_SETTINGS.keepFarmingVideosUnmuted),
    pauseOnManualWatch: booleanOr(value?.pauseOnManualWatch, DEFAULT_SETTINGS.pauseOnManualWatch),
    adFocusMode: AD_FOCUS_MODES.includes(value?.adFocusMode as AdFocusMode)
      ? (value!.adFocusMode as AdFocusMode)
      : DEFAULT_SETTINGS.adFocusMode,
    autoCloseFinishedDrops: booleanOr(value?.autoCloseFinishedDrops, DEFAULT_SETTINGS.autoCloseFinishedDrops),
    notifyRewardEarned: booleanOr(value?.notifyRewardEarned, DEFAULT_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(value?.notifyNoDropsLeft, DEFAULT_SETTINGS.notifyNoDropsLeft),
    autoStartDropFarming: booleanOr(value?.autoStartDropFarming, DEFAULT_SETTINGS.autoStartDropFarming),
    watchQueueFallbackOnly: booleanOr(value?.watchQueueFallbackOnly, DEFAULT_SETTINGS.watchQueueFallbackOnly),
    priorityMode: PRIORITY_MODES.includes(value?.priorityMode as PriorityMode)
      ? (value!.priorityMode as PriorityMode)
      : DEFAULT_SETTINGS.priorityMode,
    platform: {
      twitch: {
        enabled: booleanOr(platform?.twitch?.enabled, DEFAULT_SETTINGS.platform.twitch.enabled),
        watchQueueChannels: normalizeChannelList(platform?.twitch?.watchQueueChannels),
        excludedChannels: normalizeChannelList(platform?.twitch?.excludedChannels),
        gamePriority: normalizeStringList(platform?.twitch?.gamePriority),
      },
      kick: {
        enabled: booleanOr(platform?.kick?.enabled, DEFAULT_SETTINGS.platform.kick.enabled),
        watchQueueChannels: normalizeChannelList(platform?.kick?.watchQueueChannels),
        excludedChannels: normalizeChannelList(platform?.kick?.excludedChannels),
        gamePriority: normalizeStringList(platform?.kick?.gamePriority),
      },
    },
    campaignPriorities: normalizePriorities(value?.campaignPriorities),
    excludedCampaignIds: normalizeStringList(value?.excludedCampaignIds),
    offlineRetryLimit: clampInteger(value?.offlineRetryLimit, 1, 10, DEFAULT_SETTINGS.offlineRetryLimit),
    // chrome.alarms floors periodInMinutes at 1, so sub-minute values are inert.
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 1, 60, DEFAULT_SETTINGS.pollIntervalMinutes),
    enabledLogLevels: normalizeLogLevels(value),
  };
}

function normalizeLogLevels(value: Partial<ExtensionSettings> & { verboseLogging?: boolean } | undefined): LogLevel[] {
  // No stored array -> migrate the legacy verboseLogging toggle (verbose meant
  // debug entries were recorded on top of the info/warn/error baseline).
  if (!Array.isArray(value?.enabledLogLevels)) {
    return value?.verboseLogging
      ? ["debug", ...DEFAULT_SETTINGS.enabledLogLevels]
      : [...DEFAULT_SETTINGS.enabledLogLevels];
  }
  // Filter through LOG_LEVELS for canonical order + dedupe; error is always
  // recorded so failures are never silently dropped.
  const stored = value.enabledLogLevels;
  const valid = LOG_LEVELS.filter((level) => stored.includes(level));
  return valid.includes("error") ? valid : [...valid, "error"];
}

function booleanOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeStringList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeChannelList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean))];
}

function normalizePriorities(value: Record<string, number> | undefined): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([campaignId, priority]) => campaignId.trim() && Number.isFinite(priority))
      .map(([campaignId, priority]) => [campaignId.trim(), Math.round(priority)]),
  );
}
