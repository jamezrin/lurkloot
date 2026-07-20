import type { AdFocusMode, CampaignFilterKey, CategorySelection, CompatibilitySettings, EngineSettings, ExtensionSettings, KickPlatformSettings, LanguageOverride, Platform, PriorityMode, RateNudgeStatus, SupportedLocale, TwitchPlatformSettings } from "./models";

const AD_FOCUS_MODES: AdFocusMode[] = ["none", "tab", "window"];
const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];
const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = ["notLinked", "subscription", "upcoming", "expired", "excluded", "finished"];
const RATE_NUDGE_STATUSES: RateNudgeStatus[] = ["pending", "rated", "dismissed"];
export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar"];
const LANGUAGE_OVERRIDES: LanguageOverride[] = ["browser", ...SUPPORTED_LOCALES];

export type SettingsPatch = Partial<Omit<ExtensionSettings, "platform" | "compatibility" | "campaignVisibility">> & {
  platform?: {
    twitch?: Partial<TwitchPlatformSettings>;
    kick?: Partial<KickPlatformSettings>;
  };
  compatibility?: {
    twitch?: Partial<CompatibilitySettings["twitch"]>;
    kick?: Partial<CompatibilitySettings["kick"]>;
  };
  campaignVisibility?: Partial<ExtensionSettings["campaignVisibility"]>;
};

// The engine-contract defaults: the universal subset every host shares.
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  running: false,
  autoClaim: true,
  tablessMode: true,
  pauseOnManualWatch: true,
  notifyRewardEarned: true,
  notifyNoDropsLeft: true,
  autoStartDropFarming: true,
  idleWatchlistFallbackOnly: true,
  priorityMode: "ending_soonest",
  platform: {
    twitch: {
      enabled: true,
      idleWatchlistChannels: [],
      excludedChannels: [],
      farmAllCategories: true,
      categories: [],
      autoClaimChannelPoints: true,
    },
    kick: {
      enabled: true,
      idleWatchlistChannels: [],
      excludedChannels: [],
      farmAllCategories: true,
      categories: [],
      autoClaimChallenges: true,
    },
  },
  compatibility: {
    twitch: {
      profile: "auto",
      heartbeatTransport: "auto",
      inventoryQueryVersion: "auto",
    },
    kick: {
      profile: "auto",
      claimLinkHandling: "auto",
    },
  },
  campaignPriorities: {},
  excludedCampaignIds: [],
  offlineRetryLimit: 3,
  pollIntervalMinutes: 1,
  postClaimHandoff: true,
  // Nine refreshes at most, always finishing before the next one-minute watch
  // alarm so the handoff and the alarm never contend for the same heartbeat.
  postClaimHandoffIntervalSeconds: 5,
  postClaimHandoffMaxSeconds: 45,
  skipUnfinishableRewards: true,
  deadlineSafetyMarginMinutes: 5,
};

// The extension's full defaults: the engine contract plus the host-only knobs.
export const DEFAULT_SETTINGS: ExtensionSettings = {
  ...DEFAULT_ENGINE_SETTINGS,
  muteFarmingTabs: true,
  keepFarmingVideosUnmuted: true,
  autoCloseFinishedDrops: true,
  adFocusMode: "window",
  languageOverride: "browser",
  // Preserve the previously hard-coded view: show not-linked, upcoming and
  // finished campaigns; hide expired and excluded ones unless opted back in.
  campaignVisibility: {
    notLinked: true,
    subscription: true,
    upcoming: true,
    expired: false,
    excluded: false,
    finished: true,
  },
  rateNudgeStatus: "pending",
  showTips: true,
  diagnosticLogging: false,
};

// Normalizes the universal engine contract. The engine (packages/core) and any
// non-extension host (CLI) merge through this; host-only fields are not touched.
// Legacy property names are not read here. Hosts run migrateSettings() from
// @lurkloot/shared/settingsSchema on the raw payload first; by the time a value
// reaches normalization it only carries current names.
export function mergeEngineSettings(value: Partial<EngineSettings> | undefined): EngineSettings {
  const platform = value?.platform;
  const compatibility = value?.compatibility;
  return {
    running: booleanOr(value?.running, DEFAULT_ENGINE_SETTINGS.running),
    autoClaim: booleanOr(value?.autoClaim, DEFAULT_ENGINE_SETTINGS.autoClaim),
    tablessMode: booleanOr(value?.tablessMode, DEFAULT_ENGINE_SETTINGS.tablessMode),
    pauseOnManualWatch: booleanOr(value?.pauseOnManualWatch, DEFAULT_ENGINE_SETTINGS.pauseOnManualWatch),
    notifyRewardEarned: booleanOr(value?.notifyRewardEarned, DEFAULT_ENGINE_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(value?.notifyNoDropsLeft, DEFAULT_ENGINE_SETTINGS.notifyNoDropsLeft),
    autoStartDropFarming: booleanOr(value?.autoStartDropFarming, DEFAULT_ENGINE_SETTINGS.autoStartDropFarming),
    idleWatchlistFallbackOnly: booleanOr(value?.idleWatchlistFallbackOnly, DEFAULT_ENGINE_SETTINGS.idleWatchlistFallbackOnly),
    priorityMode: PRIORITY_MODES.includes(value?.priorityMode as PriorityMode)
      ? (value!.priorityMode as PriorityMode)
      : DEFAULT_ENGINE_SETTINGS.priorityMode,
    platform: {
      twitch: {
        enabled: booleanOr(platform?.twitch?.enabled, DEFAULT_ENGINE_SETTINGS.platform.twitch.enabled),
        idleWatchlistChannels: normalizeChannelList(platform?.twitch?.idleWatchlistChannels),
        excludedChannels: normalizeChannelList(platform?.twitch?.excludedChannels),
        farmAllCategories: booleanOr(platform?.twitch?.farmAllCategories, DEFAULT_ENGINE_SETTINGS.platform.twitch.farmAllCategories),
        categories: normalizeCategorySelections(platform?.twitch?.categories),
        autoClaimChannelPoints: booleanOr(platform?.twitch?.autoClaimChannelPoints, DEFAULT_ENGINE_SETTINGS.platform.twitch.autoClaimChannelPoints),
      },
      kick: {
        enabled: booleanOr(platform?.kick?.enabled, DEFAULT_ENGINE_SETTINGS.platform.kick.enabled),
        idleWatchlistChannels: normalizeChannelList(platform?.kick?.idleWatchlistChannels),
        excludedChannels: normalizeChannelList(platform?.kick?.excludedChannels),
        farmAllCategories: booleanOr(platform?.kick?.farmAllCategories, DEFAULT_ENGINE_SETTINGS.platform.kick.farmAllCategories),
        categories: normalizeCategorySelections(platform?.kick?.categories),
        autoClaimChallenges: booleanOr(platform?.kick?.autoClaimChallenges, DEFAULT_ENGINE_SETTINGS.platform.kick.autoClaimChallenges),
      },
    },
    compatibility: {
      twitch: {
        profile: compatibilitySelectionOrAuto(compatibility?.twitch?.profile),
        heartbeatTransport: compatibilitySelectionOrAuto(compatibility?.twitch?.heartbeatTransport),
        inventoryQueryVersion: compatibilitySelectionOrAuto(compatibility?.twitch?.inventoryQueryVersion),
      },
      kick: {
        profile: compatibilitySelectionOrAuto(compatibility?.kick?.profile),
        claimLinkHandling: compatibilitySelectionOrAuto(compatibility?.kick?.claimLinkHandling),
      },
    },
    campaignPriorities: normalizePriorities(value?.campaignPriorities),
    excludedCampaignIds: normalizeIdList(value?.excludedCampaignIds),
    offlineRetryLimit: clampInteger(value?.offlineRetryLimit, 1, 10, DEFAULT_ENGINE_SETTINGS.offlineRetryLimit),
    // chrome.alarms floors periodInMinutes at 1, so sub-minute values are inert.
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 1, 60, DEFAULT_ENGINE_SETTINGS.pollIntervalMinutes),
    postClaimHandoff: booleanOr(value?.postClaimHandoff, DEFAULT_ENGINE_SETTINGS.postClaimHandoff),
    postClaimHandoffIntervalSeconds: clampInteger(value?.postClaimHandoffIntervalSeconds, 1, 30, DEFAULT_ENGINE_SETTINGS.postClaimHandoffIntervalSeconds),
    postClaimHandoffMaxSeconds: clampInteger(value?.postClaimHandoffMaxSeconds, 5, 120, DEFAULT_ENGINE_SETTINGS.postClaimHandoffMaxSeconds),
    skipUnfinishableRewards: booleanOr(value?.skipUnfinishableRewards, DEFAULT_ENGINE_SETTINGS.skipUnfinishableRewards),
    deadlineSafetyMarginMinutes: clampInteger(
      value?.deadlineSafetyMarginMinutes,
      0,
      60,
      DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes,
    ),
  };
}

// Normalizes the extension's full settings: the engine contract plus the
// host-only fields the engine never reads.
export function mergeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  return {
    ...mergeEngineSettings(value),
    muteFarmingTabs: booleanOr(value?.muteFarmingTabs, DEFAULT_SETTINGS.muteFarmingTabs),
    keepFarmingVideosUnmuted: booleanOr(value?.keepFarmingVideosUnmuted, DEFAULT_SETTINGS.keepFarmingVideosUnmuted),
    autoCloseFinishedDrops: booleanOr(value?.autoCloseFinishedDrops, DEFAULT_SETTINGS.autoCloseFinishedDrops),
    adFocusMode: AD_FOCUS_MODES.includes(value?.adFocusMode as AdFocusMode)
      ? (value!.adFocusMode as AdFocusMode)
      : DEFAULT_SETTINGS.adFocusMode,
    languageOverride: normalizeLanguageOverride(value?.languageOverride),
    campaignVisibility: normalizeCampaignVisibility(value?.campaignVisibility),
    rateNudgeStatus: RATE_NUDGE_STATUSES.includes(value?.rateNudgeStatus as RateNudgeStatus)
      ? (value!.rateNudgeStatus as RateNudgeStatus)
      : DEFAULT_SETTINGS.rateNudgeStatus,
    showTips: booleanOr(value?.showTips, DEFAULT_SETTINGS.showTips),
    diagnosticLogging: booleanOr(value?.diagnosticLogging, DEFAULT_SETTINGS.diagnosticLogging),
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
    compatibility: {
      twitch: {
        ...current.compatibility.twitch,
        ...patch.compatibility?.twitch,
      },
      kick: {
        ...current.compatibility.kick,
        ...patch.compatibility?.kick,
      },
    },
    campaignVisibility: {
      ...current.campaignVisibility,
      ...patch.campaignVisibility,
    },
  });
}

function compatibilitySelectionOrAuto(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "auto";
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

// The claim toggles are per-platform, so a scheduler loop holding `platform` as a
// variable cannot read them off the union. These answer "is the toggle on for
// this platform"; whether the platform can actually claim is decided separately
// by the adapter's optional capability method.
export function autoClaimChannelPointsFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "twitch" ? settings.platform.twitch.autoClaimChannelPoints : false;
}

export function autoClaimChallengesFor(settings: EngineSettings, platform: Platform): boolean {
  return platform === "kick" ? settings.platform.kick.autoClaimChallenges : false;
}
