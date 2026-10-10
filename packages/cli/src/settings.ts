import {
  DEFAULT_SETTINGS,
  booleanOr,
  clampInteger,
  clampNumber,
  mergeEngineSettings,
  CATEGORY_MODES,
  normalizeCategoryMode,
  normalizeCategorySelections,
  normalizeFarmingEligibility,
  normalizeChannelList,
  normalizeIdList,
  normalizeSubscriptionMarks,
  POLL_INTERVAL_MAX_MINUTES,
  POLL_INTERVAL_MIN_MINUTES,
  IDLE_WATCHLIST_LIMIT,
} from "@lurkloot/shared/settings";
import { CURRENT_SETTINGS_SCHEMA_VERSION, migrateSettings, type SettingsMigrationDiagnostic } from "@lurkloot/shared/settingsSchema";
import { SETTINGS_EXPORT_KIND, type SettingsExportEnvelope } from "@lurkloot/shared/settingsExport";
import { normalizePlatformWatchSourcePriority } from "@lurkloot/shared/watchSources";
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
  // Ordered campaign ids that rank above everything the strategy places. The
  // extension writes this by dragging a card; headless, it is hand-edited, so
  // order is the data and no numeric weights are involved.
  campaignPins: string[];
  // Farm only the pinned campaigns. Eligibility, not ranking.
  farmPinnedOnly: boolean;
  excludedCampaignIds: string[];
  /** @deprecated Compatibility input for profiles without watchSourcePriority. */
  idleWatchlistFallbackOnly: boolean;
  // See EngineSettings.preferKnownChannels. Applies to campaign channel
  // selection the same way headless as in the extension.
  preferKnownChannels: boolean;
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim refresh. Twitch-only in practice: the Kick adapter does
  // not declare the capability. See EngineSettings.postClaimHandoff.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
  skipUnfinishableRewards: boolean;
  deadlineSafetyMarginMinutes: number;
  // Kill switch for the critical-failure detector, which runs in the shared
  // scheduler/controller regardless of host. See EngineSettings.criticalFailurePromptEnabled.
  criticalFailurePromptEnabled: boolean;
  // Not extension-only: these two keys gate what the scheduler is allowed to
  // farm, so they change headless behavior. The display-only popup preference
  // (the retired dropsListFilter) is migrated away instead — a headless run has
  // no Drops list to filter.
  farmingEligibility: EngineSettings["farmingEligibility"];
  // Gate the controller's reward/no-drops notifications, which the CLI renders
  // as log lines (see runtime/run.ts createNotification).
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  platform: PlatformSettingsByPlatform;
  compatibility: CompatibilitySettings;
}

// The two farming-eligibility toggles the CLI honours. Kept local (not imported)
// because the shared split has no exported key tuple; only these two exist.
const FARMING_ELIGIBILITY_KEYS: string[] = ["farmUnlinkedCampaigns", "farmSubscriptionCampaigns"];
const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability"];
const PLATFORMS: Platform[] = ["twitch", "kick"];

// Defaults are derived from the shared DEFAULT_SETTINGS so there is a single
// source of truth for values shared with the extension.
export const DEFAULT_CLI_SETTINGS: CliSettings = {
  autoClaim: DEFAULT_SETTINGS.autoClaim,
  priorityMode: DEFAULT_SETTINGS.priorityMode,
  campaignPins: [...DEFAULT_SETTINGS.campaignPins],
  farmPinnedOnly: DEFAULT_SETTINGS.farmPinnedOnly,
  excludedCampaignIds: [...DEFAULT_SETTINGS.excludedCampaignIds],
  idleWatchlistFallbackOnly: DEFAULT_SETTINGS.idleWatchlistFallbackOnly,
  preferKnownChannels: DEFAULT_SETTINGS.preferKnownChannels,
  offlineRetryLimit: DEFAULT_SETTINGS.offlineRetryLimit,
  pollIntervalMinutes: DEFAULT_SETTINGS.pollIntervalMinutes,
  postClaimHandoff: DEFAULT_SETTINGS.postClaimHandoff,
  postClaimHandoffIntervalSeconds: DEFAULT_SETTINGS.postClaimHandoffIntervalSeconds,
  postClaimHandoffMaxSeconds: DEFAULT_SETTINGS.postClaimHandoffMaxSeconds,
  skipUnfinishableRewards: DEFAULT_SETTINGS.skipUnfinishableRewards,
  deadlineSafetyMarginMinutes: DEFAULT_SETTINGS.deadlineSafetyMarginMinutes,
  criticalFailurePromptEnabled: DEFAULT_SETTINGS.criticalFailurePromptEnabled,
  farmingEligibility: { ...DEFAULT_SETTINGS.farmingEligibility },
  notifyRewardEarned: DEFAULT_SETTINGS.notifyRewardEarned,
  notifyNoDropsLeft: DEFAULT_SETTINGS.notifyNoDropsLeft,
  // Both platforms on by default. The extension ships them off so a fresh
  // install sits idle until the user opts in; the CLI has no such moment — it is
  // started deliberately, and running it with everything disabled would do
  // nothing at all.
  platform: {
    twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
    kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
  },
  compatibility: {
    twitch: { ...DEFAULT_SETTINGS.compatibility.twitch },
    kick: { ...DEFAULT_SETTINGS.compatibility.kick },
  },
};

const CLI_SETTING_KEYS = new Set<string>([
  "autoClaim",
  "priorityMode",
  "campaignPins",
  "farmPinnedOnly",
  "excludedCampaignIds",
  "idleWatchlistFallbackOnly",
  "preferKnownChannels",
  "offlineRetryLimit",
  "pollIntervalMinutes",
  "postClaimHandoff",
  "postClaimHandoffIntervalSeconds",
  "postClaimHandoffMaxSeconds",
  "skipUnfinishableRewards",
  "deadlineSafetyMarginMinutes",
  "criticalFailurePromptEnabled",
  "farmingEligibility",
  // Accepted only so config parsing can surface the deprecation warning.
  // Runtime log filtering belongs to the global --log option and process logger.
  "enabledLogLevels",
  "notifyRewardEarned",
  "notifyNoDropsLeft",
  "platform",
  "compatibility",
]);

const CLI_PLATFORM_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["enabled", "watchSourcePriority", "idleWatchlistChannels", "excludedChannels", "categoryMode", "categories", "favouriteCategories", "blockedCategories", "subscribedRewardMarks", "autoClaimChannelPoints", "strictCampaignAvailability", "channelPointsPushClaim", "alwaysEnterChat"]),
  kick: new Set(["enabled", "watchSourcePriority", "idleWatchlistChannels", "excludedChannels", "categoryMode", "categories", "favouriteCategories", "blockedCategories", "subscribedRewardMarks", "autoClaimChallenges", "alwaysEnterChat"]),
};
const CLI_COMPATIBILITY_KEYS: Record<Platform, Set<string>> = {
  twitch: new Set(["profile", "heartbeatTransport", "inventoryQueryVersion"]),
  kick: new Set(["profile", "claimLinkHandling"]),
};

// Settings that exist in the extension but are inert in the CLI's tabless path.
// Called out by name so a config copy-pasted from the extension gets an
// actionable error instead of a silently-ignored knob. `running` is deliberately
// absent: it was removed from the settings contract, so the schema migration
// strips it (with a diagnostic) before this scan ever sees it. So is
// `tablessMode`, which the CLI accepts and ignores (see withoutTablessMode).
const EXTENSION_ONLY_KEYS = new Set<string>([
  "twitchExtensions",
  "muteFarmingTabs",
  "keepFarmingVideosUnmuted",
  "pauseOnManualWatch",
  "adFocusMode",
  "autoCloseFinishedDrops",
  "autoStartDropFarming",
  "languageOverride",
  "rateNudgeStatus",
  "githubStarNudgeStatus",
  "diagnosticLogging",
]);

// A migration may rename a legacy key onto one the CLI rejects — `verboseLogging`
// becomes `diagnosticLogging`, which is extension-only. Name the key the user
// actually wrote, or the error points at a line their file does not contain. The
// match is by `replacement`; a nested rename's replacement is a dotted path that
// never equals a bare top-level key, so this only fires for top-level offenders.
// A user who writes BOTH the legacy and the current form of such a key sees the
// "renamed from" framing even though they also wrote the current name directly;
// that collision is pathological (an extension-only key in two forms in a CLI
// config) and still names a real offending line, so it is left as-is.
function describeOffender(key: string, diagnostics: CliSettingsDiagnostic[]): string {
  const renamedFrom = diagnostics.find((diagnostic) => diagnostic.code !== "limit_exceeded" && diagnostic.replacement === key)?.path;
  const subject = renamedFrom ? `"${renamedFrom}" (renamed to "${key}")` : `"${key}"`;
  return EXTENSION_ONLY_KEYS.has(key)
    ? `${subject} is an extension-only setting with no effect in the CLI; remove it`
    : `unknown CLI setting ${subject}`;
}

// A value the CLI accepted but had to cut down to fit an engine limit. Unlike a
// migration diagnostic, its message names what was dropped, so the user can
// fix the config file that still lists it.
export interface CliSettingsLimitDiagnostic {
  code: "limit_exceeded";
  path: string;
  message: string;
}

export type CliSettingsDiagnostic = SettingsMigrationDiagnostic | CliSettingsLimitDiagnostic;

export interface CliSettingsParseResult {
  settings: CliSettings;
  diagnostics: CliSettingsDiagnostic[];
}

// Parses and validates the `settings` block of a CLI config. Runs the shared
// migration registry first, so deprecated aliases are renamed away before
// validation and only genuinely unknown keys become errors; the caller's object
// is never mutated and the config file is never rewritten. Unknown or
// extension-only keys (top-level or per-platform) are a hard error listing every
// offender at once; recognized values are normalized through the shared
// primitives (range clamps, channel/category/id dedupe, log-level canonicalize).
export function parseCliSettingsWithDiagnostics(raw: unknown): CliSettingsParseResult {
  if (raw === undefined) return { settings: structuredClone(DEFAULT_CLI_SETTINGS), diagnostics: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Config "settings" must be a JSON object');
  }
  const migration = migrateSettings(raw);
  const diagnostics: CliSettingsDiagnostic[] = [...migration.diagnostics];
  const settings = withoutTablessMode(migration.settings, diagnostics);
  return { settings: parseMigratedCliSettings(settings, diagnostics), diagnostics };
}

// The CLI has no browser tabs, so the engine derives tabless watching from the
// missing capability (#598) and `tablessMode` has nothing left to decide. A
// config that still sets it, to either value, keeps loading: the key is dropped
// with a warning instead of failing the whole config.
function withoutTablessMode(value: Record<string, unknown>, diagnostics: CliSettingsDiagnostic[]): Record<string, unknown> {
  if (!Object.hasOwn(value, "tablessMode")) return value;
  const { tablessMode: _ignored, ...rest } = value;
  diagnostics.push({
    code: "deprecated_property",
    path: "tablessMode",
    message: '"tablessMode" is ignored: the CLI has no browser tabs, so it always watches tabless',
  });
  return rest;
}

export function parseCliSettings(raw: unknown): CliSettings {
  return parseCliSettingsWithDiagnostics(raw).settings;
}

export type CliSettingsExportPayload = SettingsExportEnvelope<CliSettings>;

// Uses the same envelope (`kind`/`schemaVersion`) the extension's export does,
// so a file can be recognized by either host — but the settings block itself
// is the CLI's own strict schema, not the extension's. Feeding an
// extension-exported file into `config import` therefore fails with the same
// per-key "extension-only setting" errors parseCliSettingsWithDiagnostics
// already gives a copy-pasted config, rather than silently accepting inert
// extension knobs.
export function buildCliSettingsExportPayload(settings: CliSettings): CliSettingsExportPayload {
  return {
    kind: SETTINGS_EXPORT_KIND,
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: parseCliSettingsWithDiagnostics(settings).settings,
  };
}

export function parseCliSettingsImportPayload(raw: unknown): CliSettingsParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Not a lurkloot settings file: expected a JSON object");
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.kind !== SETTINGS_EXPORT_KIND) {
    throw new Error('Not a lurkloot settings file: unrecognized "kind"');
  }
  if (envelope.settings === null || typeof envelope.settings !== "object" || Array.isArray(envelope.settings)) {
    throw new Error('Not a lurkloot settings file: missing "settings"');
  }
  return parseCliSettingsWithDiagnostics({ ...(envelope.settings as Record<string, unknown>), schemaVersion: envelope.schemaVersion });
}

// Validates and normalizes an already-migrated settings payload. See
// parseCliSettingsWithDiagnostics for the full contract; `diagnostics` is passed
// through so a renamed-away key can be named by its original path in errors, and
// so values cut down to an engine limit can be reported.
function parseMigratedCliSettings(value: Record<string, unknown>, diagnostics: CliSettingsDiagnostic[]): CliSettings {
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
          const block = entry as Record<string, unknown>;
          for (const key of Object.keys(block)) {
            if (!CLI_PLATFORM_KEYS[name as Platform].has(key)) offenders.push(`unknown setting "${key}" under platform.${name}`);
          }
          // Like the farmingEligibility values below: normalizeCategoryMode
          // would quietly fall back to "all" for a typo such as "exclude_all",
          // silently farming the whole directory instead of the chosen subset.
          if (Object.hasOwn(block, "categoryMode") && !CATEGORY_MODES.includes(block.categoryMode as never)) {
            offenders.push(`"platform.${name}.categoryMode" must be one of: ${CATEGORY_MODES.join(", ")}`);
          }
        }
      }
    }
  }

  // Eligibility keys are validated like platform/compatibility keys: a typo would
  // otherwise silently fall back to the default and quietly farm the wrong set.
  const farmingEligibilityRaw = value.farmingEligibility;
  if (farmingEligibilityRaw !== undefined) {
    if (farmingEligibilityRaw === null || typeof farmingEligibilityRaw !== "object" || Array.isArray(farmingEligibilityRaw)) {
      offenders.push('"farmingEligibility" must be a JSON object');
    } else {
      for (const [key, entry] of Object.entries(farmingEligibilityRaw as Record<string, unknown>)) {
        if (!FARMING_ELIGIBILITY_KEYS.includes(key)) {
          offenders.push(`unknown setting "${key}" under farmingEligibility (expected one of: ${FARMING_ELIGIBILITY_KEYS.join(", ")})`);
          continue;
        }
        // Values are checked too, not just names: booleanOr would quietly
        // restore the default for `"farmUnlinkedCampaigns": "yes"`, which is the
        // same silent wrong-set farming the key check exists to prevent.
        if (typeof entry !== "boolean") offenders.push(`"farmingEligibility.${key}" must be a boolean`);
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
    campaignPins: normalizeIdList(v.campaignPins),
    farmPinnedOnly: booleanOr(v.farmPinnedOnly, DEFAULT_CLI_SETTINGS.farmPinnedOnly),
    excludedCampaignIds: normalizeIdList(v.excludedCampaignIds),
    idleWatchlistFallbackOnly: booleanOr(v.idleWatchlistFallbackOnly, DEFAULT_CLI_SETTINGS.idleWatchlistFallbackOnly),
    preferKnownChannels: booleanOr(v.preferKnownChannels, DEFAULT_CLI_SETTINGS.preferKnownChannels),
    offlineRetryLimit: clampInteger(v.offlineRetryLimit, 1, 10, DEFAULT_CLI_SETTINGS.offlineRetryLimit),
    pollIntervalMinutes: clampNumber(v.pollIntervalMinutes, POLL_INTERVAL_MIN_MINUTES, POLL_INTERVAL_MAX_MINUTES, DEFAULT_CLI_SETTINGS.pollIntervalMinutes),
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
    criticalFailurePromptEnabled: booleanOr(v.criticalFailurePromptEnabled, DEFAULT_CLI_SETTINGS.criticalFailurePromptEnabled),
    farmingEligibility: normalizeFarmingEligibility(v.farmingEligibility),
    notifyRewardEarned: booleanOr(v.notifyRewardEarned, DEFAULT_CLI_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(v.notifyNoDropsLeft, DEFAULT_CLI_SETTINGS.notifyNoDropsLeft),
    platform: normalizePlatform(v.platform, v.idleWatchlistFallbackOnly, diagnostics),
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

function normalizePlatform(
  raw: EngineSettings["platform"] | undefined,
  legacyFallbackOnly: boolean | undefined,
  diagnostics: CliSettingsDiagnostic[],
): PlatformSettingsByPlatform {
  const common = (platform: Platform) => {
    const ps = (raw?.[platform] ?? {}) as Partial<TwitchPlatformSettings & KickPlatformSettings>;
    const defaults = DEFAULT_CLI_SETTINGS.platform[platform];
    return {
      ps,
      base: {
        enabled: booleanOr(ps.enabled, defaults.enabled),
        watchSourcePriority: normalizePlatformWatchSourcePriority(platform, ps, legacyFallbackOnly),
        idleWatchlistChannels: limitIdleWatchlist(platform, ps.idleWatchlistChannels, diagnostics),
        excludedChannels: normalizeChannelList(ps.excludedChannels),
        categoryMode: normalizeCategoryMode(ps.categoryMode),
        categories: normalizeCategorySelections(ps.categories),
        favouriteCategories: normalizeCategorySelections(ps.favouriteCategories),
        blockedCategories: normalizeCategorySelections(ps.blockedCategories),
        subscribedRewardMarks: normalizeSubscriptionMarks(ps.subscribedRewardMarks),
        alwaysEnterChat: booleanOr(ps.alwaysEnterChat, false),
      },
    };
  };
  const twitch = common("twitch");
  const kick = common("kick");
  return {
    twitch: {
      ...twitch.base,
      autoClaimChannelPoints: booleanOr(twitch.ps.autoClaimChannelPoints, DEFAULT_CLI_SETTINGS.platform.twitch.autoClaimChannelPoints),
      strictCampaignAvailability: booleanOr(twitch.ps.strictCampaignAvailability, DEFAULT_CLI_SETTINGS.platform.twitch.strictCampaignAvailability),
      channelPointsPushClaim: booleanOr(twitch.ps.channelPointsPushClaim, DEFAULT_CLI_SETTINGS.platform.twitch.channelPointsPushClaim),
    },
    kick: {
      ...kick.base,
      autoClaimChallenges: booleanOr(kick.ps.autoClaimChallenges, DEFAULT_CLI_SETTINGS.platform.kick.autoClaimChallenges),
    },
  };
}

// The engine keeps at most IDLE_WATCHLIST_LIMIT idle watchlist channels and the
// popup refuses to add more, but a config file can list any number. Keep the
// first ones, as the engine would, and name the rest instead of dropping them
// silently.
function limitIdleWatchlist(platform: Platform, channels: string[] | undefined, diagnostics: CliSettingsDiagnostic[]): string[] {
  const normalized = normalizeChannelList(channels);
  const dropped = normalized.slice(IDLE_WATCHLIST_LIMIT);
  if (dropped.length > 0) {
    diagnostics.push({
      code: "limit_exceeded",
      path: `platform.${platform}.idleWatchlistChannels`,
      message: `The ${platform} idle watchlist holds at most ${IDLE_WATCHLIST_LIMIT} channels; ignoring the other ${dropped.length}: ${dropped.join(", ")}`,
    });
  }
  return normalized.slice(0, IDLE_WATCHLIST_LIMIT);
}

// Expands the CLI settings into the EngineSettings contract the shared engine
// consumes. The CLI invariants are pinned: never pausing on a (nonexistent)
// manual watch, and always resuming the enabled platforms when the process
// starts. The startup reconciliation reads autoStartDropFarming (#593): false
// would switch the platforms off on every start. The CLI still drives its ticks
// itself. Tabless watching is not pinned here: the engine derives it from the
// missing browserTabs capability (#598), so `tablessMode` keeps its default and
// decides nothing. Tab-policy fields are not part of the engine contract
// either — the CLI never opens a tab — so there is nothing to force.
export function toEngineSettings(cli: CliSettings): EngineSettings {
  return mergeEngineSettings({
    ...cli,
    pauseOnManualWatch: false,
    autoStartDropFarming: true,
  });
}
