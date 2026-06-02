import type { AdFocusMode, ExtensionSettings } from "./models";

const AD_FOCUS_MODES: AdFocusMode[] = ["none", "tab", "window"];

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
  verboseLogging: false,
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
    priorityMode: value?.priorityMode === "lowest_availability" || value?.priorityMode === "ending_soonest"
      ? value.priorityMode
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
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 0.5, 60, DEFAULT_SETTINGS.pollIntervalMinutes),
    verboseLogging: booleanOr(value?.verboseLogging, DEFAULT_SETTINGS.verboseLogging),
  };
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
