import {
  DEFAULT_SETTINGS,
  booleanOr,
  clampInteger,
  clampNumber,
  mergeSettings,
  normalizeCategorySelections,
  normalizeChannelList,
  normalizeIdList,
  normalizeLogLevels,
  normalizePriorities,
} from "@lurkloot/shared/settings";
import type { ExtensionSettings, Platform, PlatformSettings, PriorityMode } from "@lurkloot/shared/models";
import type { LogLevel } from "@lurkloot/shared/logging";

// The CLI's own settings surface — intentionally decoupled from the extension's
// ExtensionSettings. It only exposes settings that actually do something in the
// headless, tabless watch path (direct HTTP heartbeats / Kick WebSocket; no
// browser, no tabs). Anything that only matters with a real browser running is
// rejected (see EXTENSION_ONLY_KEYS) so the config never carries inert knobs.
// Per-platform settings are identical to the extension's, so PlatformSettings is
// reused verbatim — sharing the *type* is fine; the top-level schema is not.
export interface CliSettings {
  autoClaim: boolean;
  autoClaimChannelPoints: boolean;
  priorityMode: PriorityMode;
  campaignPriorities: Record<string, number>;
  excludedCampaignIds: string[];
  watchQueueFallbackOnly: boolean;
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  enabledLogLevels: LogLevel[];
  // Gate the controller's reward/no-drops notifications, which the CLI renders
  // as log lines (see runtime/run.ts createNotification).
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  platform: Record<Platform, PlatformSettings>;
}

const PRIORITY_MODES: PriorityMode[] = ["ending_soonest", "lowest_availability", "priority_list_only"];
const PLATFORMS: Platform[] = ["twitch", "kick"];

// Defaults are derived from the shared DEFAULT_SETTINGS so there is a single
// source of truth for values shared with the extension.
export const DEFAULT_CLI_SETTINGS: CliSettings = {
  autoClaim: DEFAULT_SETTINGS.autoClaim,
  autoClaimChannelPoints: DEFAULT_SETTINGS.autoClaimChannelPoints,
  priorityMode: DEFAULT_SETTINGS.priorityMode,
  campaignPriorities: { ...DEFAULT_SETTINGS.campaignPriorities },
  excludedCampaignIds: [...DEFAULT_SETTINGS.excludedCampaignIds],
  watchQueueFallbackOnly: DEFAULT_SETTINGS.watchQueueFallbackOnly,
  offlineRetryLimit: DEFAULT_SETTINGS.offlineRetryLimit,
  pollIntervalMinutes: DEFAULT_SETTINGS.pollIntervalMinutes,
  enabledLogLevels: [...DEFAULT_SETTINGS.enabledLogLevels],
  notifyRewardEarned: DEFAULT_SETTINGS.notifyRewardEarned,
  notifyNoDropsLeft: DEFAULT_SETTINGS.notifyNoDropsLeft,
  platform: {
    twitch: { ...DEFAULT_SETTINGS.platform.twitch },
    kick: { ...DEFAULT_SETTINGS.platform.kick },
  },
};

const CLI_SETTING_KEYS = new Set<string>([
  "autoClaim",
  "autoClaimChannelPoints",
  "priorityMode",
  "campaignPriorities",
  "excludedCampaignIds",
  "watchQueueFallbackOnly",
  "offlineRetryLimit",
  "pollIntervalMinutes",
  "enabledLogLevels",
  "notifyRewardEarned",
  "notifyNoDropsLeft",
  "platform",
]);

const CLI_PLATFORM_KEYS = new Set<string>(["enabled", "watchQueueChannels", "excludedChannels", "farmAllCategories", "categories"]);

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
]);

function describeOffender(key: string): string {
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
            if (!CLI_PLATFORM_KEYS.has(key)) offenders.push(`unknown setting "${key}" under platform.${name}`);
          }
        }
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Invalid CLI settings:\n  - ${offenders.join("\n  - ")}`);
  }

  const v = value as Partial<ExtensionSettings>;
  return {
    autoClaim: booleanOr(v.autoClaim, DEFAULT_CLI_SETTINGS.autoClaim),
    autoClaimChannelPoints: booleanOr(v.autoClaimChannelPoints, DEFAULT_CLI_SETTINGS.autoClaimChannelPoints),
    priorityMode: PRIORITY_MODES.includes(v.priorityMode as PriorityMode)
      ? (v.priorityMode as PriorityMode)
      : DEFAULT_CLI_SETTINGS.priorityMode,
    campaignPriorities: normalizePriorities(v.campaignPriorities),
    excludedCampaignIds: normalizeIdList(v.excludedCampaignIds),
    watchQueueFallbackOnly: booleanOr(v.watchQueueFallbackOnly, DEFAULT_CLI_SETTINGS.watchQueueFallbackOnly),
    offlineRetryLimit: clampInteger(v.offlineRetryLimit, 1, 10, DEFAULT_CLI_SETTINGS.offlineRetryLimit),
    pollIntervalMinutes: clampNumber(v.pollIntervalMinutes, 1, 60, DEFAULT_CLI_SETTINGS.pollIntervalMinutes),
    enabledLogLevels: normalizeLogLevels({ enabledLogLevels: v.enabledLogLevels }),
    notifyRewardEarned: booleanOr(v.notifyRewardEarned, DEFAULT_CLI_SETTINGS.notifyRewardEarned),
    notifyNoDropsLeft: booleanOr(v.notifyNoDropsLeft, DEFAULT_CLI_SETTINGS.notifyNoDropsLeft),
    platform: normalizePlatform(v.platform),
  };
}

function normalizePlatform(raw: ExtensionSettings["platform"] | undefined): Record<Platform, PlatformSettings> {
  const build = (platform: Platform): PlatformSettings => {
    const ps = (raw?.[platform] ?? {}) as Partial<PlatformSettings>;
    const defaults = DEFAULT_CLI_SETTINGS.platform[platform];
    return {
      enabled: booleanOr(ps.enabled, defaults.enabled),
      watchQueueChannels: normalizeChannelList(ps.watchQueueChannels),
      excludedChannels: normalizeChannelList(ps.excludedChannels),
      farmAllCategories: booleanOr(ps.farmAllCategories, defaults.farmAllCategories),
      categories: normalizeCategorySelections(ps.categories),
    };
  };
  return { twitch: build("twitch"), kick: build("kick") };
}

// Expands the CLI settings into the full ExtensionSettings the shared engine
// requires. The browser-only fields are forced to inert defaults and the CLI
// invariants are pinned: always running, always tabless, never pausing on a
// (nonexistent) manual watch, and never auto-starting via the controller (the
// CLI drives tick() directly).
export function toEngineSettings(cli: CliSettings): ExtensionSettings {
  return mergeSettings({
    ...cli,
    running: true,
    tablessMode: true,
    pauseOnManualWatch: false,
    autoStartDropFarming: false,
  });
}
