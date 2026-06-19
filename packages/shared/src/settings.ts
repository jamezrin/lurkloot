import type { AdFocusMode, CampaignFilterKey, CategorySelection, ExtensionSettings, LanguageOverride, Platform, PlatformSettings, PriorityMode, RateNudgeStatus, SupportedLocale } from "./models";
import { LOG_LEVELS, type LogLevel } from "./logging";

const AD_FOCUS_MODES: AdFocusMode[] = ["none", "tab", "window"];
const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];
const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = ["notLinked", "upcoming", "expired", "excluded", "finished"];
const RATE_NUDGE_STATUSES: RateNudgeStatus[] = ["pending", "rated", "dismissed"];
export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar"];
const LANGUAGE_OVERRIDES: LanguageOverride[] = ["browser", ...SUPPORTED_LOCALES];

export type SettingsPatch = Partial<Omit<ExtensionSettings, "platform" | "campaignVisibility">> & {
  platform?: Partial<Record<Platform, Partial<PlatformSettings>>>;
  campaignVisibility?: Partial<ExtensionSettings["campaignVisibility"]>;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  languageOverride: "browser",
  running: false,
  autoClaim: true,
  autoClaimChannelPoints: true,
  tablessMode: true,
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
      farmAllCategories: true,
      categories: [],
    },
    kick: {
      enabled: true,
      watchQueueChannels: [],
      excludedChannels: [],
      farmAllCategories: true,
      categories: [],
    },
  },
  campaignPriorities: {},
  excludedCampaignIds: [],
  // Preserve the previously hard-coded view: show not-linked, upcoming and
  // finished campaigns; hide expired and excluded ones unless opted back in.
  campaignVisibility: {
    notLinked: true,
    upcoming: true,
    expired: false,
    excluded: false,
    finished: true,
  },
  offlineRetryLimit: 3,
  pollIntervalMinutes: 1,
  enabledLogLevels: ["info", "warn", "error"],
  rateNudgeStatus: "pending",
};

export function mergeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  const platform = value?.platform;
  return {
    languageOverride: normalizeLanguageOverride(value?.languageOverride),
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
        farmAllCategories: booleanOr(platform?.twitch?.farmAllCategories, DEFAULT_SETTINGS.platform.twitch.farmAllCategories),
        categories: normalizeCategorySelections(platform?.twitch?.categories),
      },
      kick: {
        enabled: booleanOr(platform?.kick?.enabled, DEFAULT_SETTINGS.platform.kick.enabled),
        watchQueueChannels: normalizeChannelList(platform?.kick?.watchQueueChannels),
        excludedChannels: normalizeChannelList(platform?.kick?.excludedChannels),
        farmAllCategories: booleanOr(platform?.kick?.farmAllCategories, DEFAULT_SETTINGS.platform.kick.farmAllCategories),
        categories: normalizeCategorySelections(platform?.kick?.categories),
      },
    },
    campaignPriorities: normalizePriorities(value?.campaignPriorities),
    excludedCampaignIds: normalizeIdList(value?.excludedCampaignIds),
    campaignVisibility: normalizeCampaignVisibility(value?.campaignVisibility),
    offlineRetryLimit: clampInteger(value?.offlineRetryLimit, 1, 10, DEFAULT_SETTINGS.offlineRetryLimit),
    // chrome.alarms floors periodInMinutes at 1, so sub-minute values are inert.
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 1, 60, DEFAULT_SETTINGS.pollIntervalMinutes),
    enabledLogLevels: normalizeLogLevels(value),
    rateNudgeStatus: RATE_NUDGE_STATUSES.includes(value?.rateNudgeStatus as RateNudgeStatus)
      ? (value!.rateNudgeStatus as RateNudgeStatus)
      : DEFAULT_SETTINGS.rateNudgeStatus,
  };
}

function normalizeLanguageOverride(value: LanguageOverride | undefined): LanguageOverride {
  return LANGUAGE_OVERRIDES.includes(value as LanguageOverride) ? (value as LanguageOverride) : DEFAULT_SETTINGS.languageOverride;
}

export function applySettingsPatch(current: ExtensionSettings, patch: SettingsPatch): ExtensionSettings {
  return mergeSettings({
    ...current,
    ...patch,
    platform: {
      ...current.platform,
      twitch: {
        ...current.platform.twitch,
        ...patch.platform?.twitch,
      },
      kick: {
        ...current.platform.kick,
        ...patch.platform?.kick,
      },
    },
    campaignVisibility: {
      ...current.campaignVisibility,
      ...patch.campaignVisibility,
    },
  });
}

export function normalizeLogLevels(value: Partial<ExtensionSettings> & { verboseLogging?: boolean } | undefined): LogLevel[] {
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

export function booleanOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Ordered list, deduped by lowercased id; entries need both a non-empty id and a
// non-empty name. The legacy `gamePriority: string[]` is intentionally NOT
// migrated: it stored ids without display names (and was an ordering hint, not an
// allowlist), so carrying it over would surface bare numeric ids like "13".
export function normalizeCategorySelections(value: CategorySelection[] | undefined): CategorySelection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CategorySelection[] = [];
  for (const entry of value) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!id || !name) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const imageUrl = typeof entry?.imageUrl === "string" && entry.imageUrl.trim() ? entry.imageUrl.trim() : undefined;
    result.push(imageUrl ? { id, name, imageUrl } : { id, name });
  }
  return result;
}

// Campaign ids are case-sensitive and matched verbatim against campaign.id in
// the scheduler, so unlike channel/game lists they must not be lowercased.
export function normalizeIdList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeCampaignVisibility(value: Partial<Record<CampaignFilterKey, boolean>> | undefined): Record<CampaignFilterKey, boolean> {
  return Object.fromEntries(
    CAMPAIGN_FILTER_KEYS.map((key) => [key, booleanOr(value?.[key], DEFAULT_SETTINGS.campaignVisibility[key])]),
  ) as Record<CampaignFilterKey, boolean>;
}

export function normalizeChannelList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean))];
}

export function normalizePriorities(value: Record<string, number> | undefined): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([campaignId, priority]) => campaignId.trim() && Number.isFinite(priority))
      .map(([campaignId, priority]) => [campaignId.trim(), Math.round(priority)]),
  );
}
