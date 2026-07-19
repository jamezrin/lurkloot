import {
  DEFAULT_SETTINGS,
  booleanOr,
  clampInteger,
  clampNumber,
  mergeEngineSettings,
  normalizeCategorySelections,
  normalizeChannelList,
  normalizeIdList,
  normalizePriorities,
} from "@lurkloot/shared/settings";
import type { CompatibilitySettings, EngineSettings, KickPlatformSettings, Platform, PlatformSettingsByPlatform, PriorityMode, TwitchPlatformSettings } from "@lurkloot/shared/models";

// The CLI's own settings surface — intentionally decoupled from the extension's
// ExtensionSettings. It only exposes settings that actually do something in the
// headless, tabless watch path (direct HTTP heartbeats / Kick WebSocket; no
// browser, no tabs). Anything that only matters with a real browser running is
// rejected (see EXTENSION_ONLY_KEYS) so the config never carries inert knobs.
// Per-platform settings reuse the extension's split platform types; the
// top-level schema is deliberately not shared.
export interface CliSettings {
  autoClaim: boolean;
  priorityMode: PriorityMode;
  campaignPriorities: Record<string, number>;
  excludedCampaignIds: string[];
  watchQueueFallbackOnly: boolean;
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim refresh. Twitch-only in practice: the Kick adapter does
  // not declare the capability. See EngineSettings.postClaimHandoff.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
  // Gate the controller's reward/no-drops notifications, which the CLI renders
  // as log lines (see runtime/run.ts createNotification).
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  platform: PlatformSettingsByPlatform;
  compatibility: CompatibilitySettings;
}

const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];
const PLATFORMS: Platform[] = ["twitch", "kick"];

// Defaults are derived from the shared DEFAULT_SETTINGS so there is a single
// source of truth for values shared with the extension.
export const DEFAULT_CLI_SETTINGS: CliSettings = {
  autoClaim: DEFAULT_SETTINGS.autoClaim,
  priorityMode: DEFAULT_SETTINGS.priorityMode,
  campaignPriorities: { ...DEFAULT_SETTINGS.campaignPriorities },
  excludedCampaignIds: [...DEFAULT_SETTINGS.excludedCampaignIds],
  watchQueueFallbackOnly: DEFAULT_SETTINGS.watchQueueFallbackOnly,
  offlineRetryLimit: DEFAULT_SETTINGS.offlineRetryLimit,
  pollIntervalMinutes: DEFAULT_SETTINGS.pollIntervalMinutes,
  postClaimHandoff: DEFAULT_SETTINGS.postClaimHandoff,
  postClaimHandoffIntervalSeconds: DEFAULT_SETTINGS.postClaimHandoffIntervalSeconds,
  postClaimHandoffMaxSeconds: DEFAULT_SETTINGS.postClaimHandoffMaxSeconds,
  notifyRewardEarned: DEFAULT_SETTINGS.notifyRewardEarned,
  notifyNoDropsLeft: DEFAULT_SETTINGS.notifyNoDropsLeft,
  platform: {
    twitch: { ...DEFAULT_SETTINGS.platform.twitch },
    kick: { ...DEFAULT_SETTINGS.platform.kick },
  },
  compatibility: {
    twitch: { ...DEFAULT_SETTINGS.compatibility.twitch },
    kick: { ...DEFAULT_SETTINGS.compatibility.kick },
  },
};

const CLI_SETTING_KEYS = new Set<string>([
  "autoClaim",
  "priorityMode",
  "campaignPriorities",
  "excludedCampaignIds",
  "watchQueueFallbackOnly",
  "offlineRetryLimit",
  "pollIntervalMinutes",
  "postClaimHandoff",
  "postClaimHandoffIntervalSeconds",
  "postClaimHandoffMaxSeconds",
  // Accepted only so config parsing can surface the deprecation warning.
  // Runtime log filtering belongs to the global --log option and process logger.
  "enabledLogLevels",
  "notifyRewardEarned",
  "notifyNoDropsLeft",
  "platform",
  "compatibility",
]);

const CLI_PLATFORM_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["enabled", "watchQueueChannels", "excludedChannels", "farmAllCategories", "categories", "autoClaimChannelPoints"]),
  kick: new Set(["enabled", "watchQueueChannels", "excludedChannels", "farmAllCategories", "categories"]),
};
const CLI_COMPATIBILITY_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["profile", "heartbeatTransport", "inventoryQueryVersion"]),
  kick: new Set(["profile", "claimLinkHandling"]),
};

// Settings that exist in the extension but are inert in the CLI's tabless path.
// Called out by name so a config copy-pasted from the extension gets an
// actionable error instead of a silently-ignored knob. `running` and
// `tablessMode` live here too: the CLI always runs and is always tabless.
const EXTENSION_ONLY_KEYS = new Set<string>([
  "running",
  "tablessMode",
  "muteFarmingTabs",
  "keepFarmingVideosUnmuted",
  "pauseOnManualWatch",
  "adFocusMode",
  "autoCloseFinishedDrops",
  "autoStartDropFarming",
  "campaignVisibility",
  "languageOverride",
  "rateNudgeStatus",
  "diagnosticLogging",
]);

// Top-level settings that moved into a per-platform block. Named separately so
// an existing config that still carries one gets a "move it here" error instead
// of a misleading "unknown setting".
const MOVED_SETTING_KEYS: Record<string, string> = {
  autoClaimChannelPoints: "platform.twitch.autoClaimChannelPoints",
};

function describeOffender(key: string): string {
  const movedTo = MOVED_SETTING_KEYS[key];
  if (movedTo) return `"${key}" moved to "${movedTo}"; move the value there`;
  return EXTENSION_ONLY_KEYS.has(key)
    ? `"${key}" is an extension-only setting with no effect in the CLI; remove it`
    : `unknown CLI setting "${key}"`;
}

// Parses and validates the `settings` block of a CLI config. Unknown or
// extension-only keys (top-level or per-platform) are a hard error listing every
// offender at once; recognized values are normalized through the shared
// primitives (range clamps, channel/category/id dedupe, log-level canonicalize).
export function parseCliSettings(raw: unknown): CliSettings {
  if (raw === undefined) return structuredClone(DEFAULT_CLI_SETTINGS);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Config "settings" must be a JSON object');
  }
  const value = raw as Record<string, unknown>;
  const offenders: string[] = [];

  for (const key of Object.keys(value)) {
    if (!CLI_SETTING_KEYS.has(key)) offenders.push(describeOffender(key));
  }

  const platformRaw = value.platform;
  if (platformRaw !== undefined) {
    if (platformRaw === null || typeof platformRaw !== "object" || Array.isArray(platformRaw)) {
      offenders.push('"platform" must be a JSON object');
    } else {
      for (const [name, entry] of Object.entries(platformRaw as Record<string, unknown>)) {
        if (!PLATFORMS.includes(name as Platform)) {
          offenders.push(`unknown platform "${name}" (expected one of: ${PLATFORMS.join(", ")})`);
          continue;
        }
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          for (const key of Object.keys(entry as Record<string, unknown>)) {
            if (!CLI_PLATFORM_KEYS[name as Platform].has(key)) offenders.push(`unknown setting "${key}" under platform.${name}`);
          }
        }
      }
    }
  }

  const compatibilityRaw = value.compatibility;
  if (compatibilityRaw !== undefined) {
    if (compatibilityRaw === null || typeof compatibilityRaw !== "object" || Array.isArray(compatibilityRaw)) {
      offenders.push('"compatibility" must be a JSON object');
    } else {
      for (const [name, entry] of Object.entries(compatibilityRaw as Record<string, unknown>)) {
        if (!PLATFORMS.includes(name as Platform)) {
          offenders.push(`unknown compatibility platform "${name}" (expected one of: ${PLATFORMS.join(", ")})`);
          continue;
        }
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          offenders.push(`"compatibility.${name}" must be a JSON object`);
          continue;
        }
        for (const key of Object.keys(entry as Record<string, unknown>)) {
          if (!CLI_COMPATIBILITY_KEYS[name as Platform].has(key)) {
            offenders.push(`unknown setting "${key}" under compatibility.${name}`);
          }
        }
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Invalid CLI settings:\n  - ${offenders.join("\n  - ")}`);
  }

  const v = value as Partial<EngineSettings>;
  return {
    autoClaim: booleanOr(v.autoClaim, DEFAULT_CLI_SETTINGS.autoClaim),
    priorityMode: PRIORITY_MODES.includes(v.priorityMode as PriorityMode)
      ? (v.priorityMode as PriorityMode)
      : DEFAULT_CLI_SETTINGS.priorityMode,
    campaignPriorities: normalizePriorities(v.campaignPriorities),
    excludedCampaignIds: normalizeIdList(v.excludedCampaignIds),
    watchQueueFallbackOnly: booleanOr(v.watchQueueFallbackOnly, DEFAULT_CLI_SETTINGS.watchQueueFallbackOnly),
    offlineRetryLimit: clampInteger(v.offlineRetryLimit, 1, 10, DEFAULT_CLI_SETTINGS.offlineRetryLimit),
    pollIntervalMinutes: clampNumber(v.pollIntervalMinutes, 1, 60, DEFAULT_CLI_SETTINGS.pollIntervalMinutes),
    postClaimHandoff: booleanOr(v.postClaimHandoff, DEFAULT_CLI_SETTINGS.postClaimHandoff),
    postClaimHandoffIntervalSeconds: clampInteger(v.postClaimHandoffIntervalSeconds, 1, 30, DEFAULT_CLI_SETTINGS.postClaimHandoffIntervalSeconds),
    postClaimHandoffMaxSeconds: clampInteger(v.postClaimHandoffMaxSeconds, 5, 120, DEFAULT_CLI_SETTINGS.postClaimHandoffMaxSeconds),
    notifyRewardEarned: booleanOr(v.notifyRewardEarned, DEFAULT_CLI_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(v.notifyNoDropsLeft, DEFAULT_CLI_SETTINGS.notifyNoDropsLeft),
    platform: normalizePlatform(v.platform),
    compatibility: normalizeCompatibility(v.compatibility),
  };
}

function normalizeCompatibility(raw: EngineSettings["compatibility"] | undefined): CompatibilitySettings {
  const selectionOrAuto = (value: unknown): string =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "auto";
  return {
    twitch: {
      profile: selectionOrAuto(raw?.twitch?.profile),
      heartbeatTransport: selectionOrAuto(raw?.twitch?.heartbeatTransport),
      inventoryQueryVersion: selectionOrAuto(raw?.twitch?.inventoryQueryVersion),
    },
    kick: {
      profile: selectionOrAuto(raw?.kick?.profile),
      claimLinkHandling: selectionOrAuto(raw?.kick?.claimLinkHandling),
    },
  };
}

function normalizePlatform(raw: EngineSettings["platform"] | undefined): PlatformSettingsByPlatform {
  const common = (platform: Platform) => {
    const ps = (raw?.[platform] ?? {}) as Partial<TwitchPlatformSettings & KickPlatformSettings>;
    const defaults = DEFAULT_CLI_SETTINGS.platform[platform];
    return {
      ps,
      base: {
        enabled: booleanOr(ps.enabled, defaults.enabled),
        watchQueueChannels: normalizeChannelList(ps.watchQueueChannels),
        excludedChannels: normalizeChannelList(ps.excludedChannels),
        farmAllCategories: booleanOr(ps.farmAllCategories, defaults.farmAllCategories),
        categories: normalizeCategorySelections(ps.categories),
      },
    };
  };
  const twitch = common("twitch");
  const kick = common("kick");
  return {
    twitch: {
      ...twitch.base,
      autoClaimChannelPoints: booleanOr(twitch.ps.autoClaimChannelPoints, DEFAULT_CLI_SETTINGS.platform.twitch.autoClaimChannelPoints),
    },
    // autoClaimChallenges is not a CLI-configurable knob (CLI_PLATFORM_KEYS omits
    // it for kick, and `ps` above is never read for it), but KickPlatformSettings
    // still requires the field, so it's pinned to the shared default here.
    kick: { ...kick.base, autoClaimChallenges: DEFAULT_CLI_SETTINGS.platform.kick.autoClaimChallenges },
  };
}

// Expands the CLI settings into the EngineSettings contract the shared engine
// consumes. The CLI invariants are pinned: always running, always tabless, never
// pausing on a (nonexistent) manual watch, and never auto-starting via the
// controller (the CLI drives tick() directly). Tab-policy fields are not part of
// the engine contract — the CLI never opens a tab — so there is nothing to force.
export function toEngineSettings(cli: CliSettings): EngineSettings {
  return mergeEngineSettings({
    ...cli,
    running: true,
    tablessMode: true,
    pauseOnManualWatch: false,
    autoStartDropFarming: false,
  });
}
