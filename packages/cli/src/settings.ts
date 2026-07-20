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
import { migrateSettings, type SettingsMigrationDiagnostic } from "@lurkloot/shared/settingsSchema";
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
  idleWatchlistFallbackOnly: boolean;
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim refresh. Twitch-only in practice: the Kick adapter does
  // not declare the capability. See EngineSettings.postClaimHandoff.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
  skipUnfinishableRewards: boolean;
  deadlineSafetyMarginMinutes: number;
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
  idleWatchlistFallbackOnly: DEFAULT_SETTINGS.idleWatchlistFallbackOnly,
  offlineRetryLimit: DEFAULT_SETTINGS.offlineRetryLimit,
  pollIntervalMinutes: DEFAULT_SETTINGS.pollIntervalMinutes,
  postClaimHandoff: DEFAULT_SETTINGS.postClaimHandoff,
  postClaimHandoffIntervalSeconds: DEFAULT_SETTINGS.postClaimHandoffIntervalSeconds,
  postClaimHandoffMaxSeconds: DEFAULT_SETTINGS.postClaimHandoffMaxSeconds,
  skipUnfinishableRewards: DEFAULT_SETTINGS.skipUnfinishableRewards,
  deadlineSafetyMarginMinutes: DEFAULT_SETTINGS.deadlineSafetyMarginMinutes,
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
  "idleWatchlistFallbackOnly",
  "offlineRetryLimit",
  "pollIntervalMinutes",
  "postClaimHandoff",
  "postClaimHandoffIntervalSeconds",
  "postClaimHandoffMaxSeconds",
  "skipUnfinishableRewards",
  "deadlineSafetyMarginMinutes",
  // Accepted only so config parsing can surface the deprecation warning.
  // Runtime log filtering belongs to the global --log option and process logger.
  "enabledLogLevels",
  "notifyRewardEarned",
  "notifyNoDropsLeft",
  "platform",
  "compatibility",
]);

const CLI_PLATFORM_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["enabled", "idleWatchlistChannels", "excludedChannels", "farmAllCategories", "categories", "autoClaimChannelPoints"]),
  kick: new Set(["enabled", "idleWatchlistChannels", "excludedChannels", "farmAllCategories", "categories", "autoClaimChallenges"]),
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

// A migration may rename a legacy key onto one the CLI rejects — `verboseLogging`
// becomes `diagnosticLogging`, which is extension-only. Name the key the user
// actually wrote, or the error points at a line their file does not contain. The
// match is by `replacement`; a nested rename's replacement is a dotted path that
// never equals a bare top-level key, so this only fires for top-level offenders.
function describeOffender(key: string, diagnostics: SettingsMigrationDiagnostic[]): string {
  const renamedFrom = diagnostics.find((diagnostic) => diagnostic.replacement === key)?.path;
  const subject = renamedFrom ? `"${renamedFrom}" (renamed to "${key}")` : `"${key}"`;
  return EXTENSION_ONLY_KEYS.has(key)
    ? `${subject} is an extension-only setting with no effect in the CLI; remove it`
    : `unknown CLI setting ${subject}`;
}

export interface CliSettingsParseResult {
  settings: CliSettings;
  diagnostics: SettingsMigrationDiagnostic[];
}

// Runs the shared migration registry first, so deprecated aliases are renamed
// away before validation and only genuinely unknown keys become errors. The
// caller's object is never mutated and the config file is never rewritten.
export function parseCliSettingsWithDiagnostics(raw: unknown): CliSettingsParseResult {
  if (raw === undefined) return { settings: structuredClone(DEFAULT_CLI_SETTINGS), diagnostics: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Config "settings" must be a JSON object');
  }
  const migration = migrateSettings(raw);
  return { settings: parseMigratedCliSettings(migration.settings, migration.diagnostics), diagnostics: migration.diagnostics };
}

export function parseCliSettings(raw: unknown): CliSettings {
  return parseCliSettingsWithDiagnostics(raw).settings;
}

// Parses and validates the `settings` block of a CLI config. Unknown or
// extension-only keys (top-level or per-platform) are a hard error listing every
// offender at once; recognized values are normalized through the shared
// primitives (range clamps, channel/category/id dedupe, log-level canonicalize).
function parseMigratedCliSettings(value: Record<string, unknown>, diagnostics: SettingsMigrationDiagnostic[]): CliSettings {
  const offenders: string[] = [];

  for (const key of Object.keys(value)) {
    if (!CLI_SETTING_KEYS.has(key)) offenders.push(describeOffender(key, diagnostics));
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
    idleWatchlistFallbackOnly: booleanOr(v.idleWatchlistFallbackOnly, DEFAULT_CLI_SETTINGS.idleWatchlistFallbackOnly),
    offlineRetryLimit: clampInteger(v.offlineRetryLimit, 1, 10, DEFAULT_CLI_SETTINGS.offlineRetryLimit),
    pollIntervalMinutes: clampNumber(v.pollIntervalMinutes, 1, 60, DEFAULT_CLI_SETTINGS.pollIntervalMinutes),
    postClaimHandoff: booleanOr(v.postClaimHandoff, DEFAULT_CLI_SETTINGS.postClaimHandoff),
    postClaimHandoffIntervalSeconds: clampInteger(v.postClaimHandoffIntervalSeconds, 1, 30, DEFAULT_CLI_SETTINGS.postClaimHandoffIntervalSeconds),
    postClaimHandoffMaxSeconds: clampInteger(v.postClaimHandoffMaxSeconds, 5, 120, DEFAULT_CLI_SETTINGS.postClaimHandoffMaxSeconds),
    skipUnfinishableRewards: booleanOr(v.skipUnfinishableRewards, DEFAULT_CLI_SETTINGS.skipUnfinishableRewards),
    deadlineSafetyMarginMinutes: clampInteger(
      v.deadlineSafetyMarginMinutes,
      0,
      60,
      DEFAULT_CLI_SETTINGS.deadlineSafetyMarginMinutes,
    ),
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
        idleWatchlistChannels: normalizeChannelList(ps.idleWatchlistChannels),
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
    kick: {
      ...kick.base,
      autoClaimChallenges: booleanOr(kick.ps.autoClaimChallenges, DEFAULT_CLI_SETTINGS.platform.kick.autoClaimChallenges),
    },
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
