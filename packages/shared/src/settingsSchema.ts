import { normalizePlatformWatchSourcePriority } from "./watchSources";
import { isRecord } from "./records";

// The single authority for versioned settings-shape migrations. Both hosts run
// `migrateSettings` on their raw persisted payload *before* normalization: the
// raw property information is what makes accurate deprecation diagnostics
// possible, and defaulting or clamping would erase it.
//
// See docs/architecture.md ("Settings Migrations") before adding one.

// Incremented for every semantic settings-shape migration.
export const CURRENT_SETTINGS_SCHEMA_VERSION = 10;

// Reserved metadata stored alongside the settings properties. It is stripped
// before any runtime EngineSettings/ExtensionSettings/CliSettings value is
// produced, so it never appears in those types.
export const SETTINGS_SCHEMA_VERSION_KEY = "schemaVersion";

export type SettingsMigrationDiagnosticCode = "deprecated_property" | "moved_property";

export interface SettingsMigrationDiagnostic {
  // Stable across releases; hosts may route on it.
  code: SettingsMigrationDiagnosticCode;
  // Dotted path relative to the settings object, e.g. "platform.twitch.watchQueueChannels".
  path: string;
  // Dotted replacement path, when the property has one.
  replacement?: string;
  // Every dotted replacement path, when the value moved onto both platforms
  // and so has no single replacement.
  replacements?: string[];
  // Host-neutral text. Hosts add their own prefix (the CLI prepends "settings.").
  message: string;
}

export interface SettingsMigrationResult {
  // The migrated raw payload, without the reserved version property.
  settings: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  // True when the stored document was not already at the current version, i.e.
  // when a host should persist the canonical result.
  changed: boolean;
  diagnostics: SettingsMigrationDiagnostic[];
}

export class UnsupportedSettingsVersionError extends Error {
  readonly version: unknown;
  readonly supported: number;
  readonly reason: "future" | "invalid";

  constructor(version: unknown, reason: "future" | "invalid") {
    super(
      reason === "future"
        ? `Settings schema version ${String(version)} is newer than this build supports (${CURRENT_SETTINGS_SCHEMA_VERSION})`
        : `Settings schema version ${String(version)} is not a non-negative integer`,
    );
    this.name = "UnsupportedSettingsVersionError";
    this.version = version;
    this.supported = CURRENT_SETTINGS_SCHEMA_VERSION;
    this.reason = reason;
  }
}

type Diagnose = (diagnostic: SettingsMigrationDiagnostic) => void;

interface SettingsMigration {
  // The version this migration produces. MIGRATIONS[i].to === i + 1.
  to: number;
  // Receives a deep clone it owns outright, so it may mutate freely.
  migrate: (raw: Record<string, unknown>, diagnose: Diagnose) => Record<string, unknown>;
}

// Ordered registry. Entry i upgrades version i to version i + 1. Never edit a
// released migration except to fix data loss; add a new version instead.
const MIGRATIONS: SettingsMigration[] = [
  { to: 1, migrate: migrateToV1 },
  { to: 2, migrate: migrateToV2 },
  { to: 3, migrate: migrateToV3 },
  { to: 4, migrate: migrateToV4 },
  { to: 5, migrate: migrateToV5 },
  { to: 6, migrate: migrateToV6 },
  { to: 7, migrate: migrateToV7 },
  { to: 8, migrate: migrateToV8 },
  { to: 9, migrate: migrateToV9 },
  { to: 10, migrate: migrateToV10 },
];

// Migration 1 consolidates every legacy shape that predates the registry: the
// Idle Watchlist rename (PR #177), the pre-split top-level channel-points
// toggle, and the verboseLogging rename. Diagnostics are emitted in a fixed
// order so host warnings are stable across runs.
function migrateToV1(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  renameProperty(raw, "watchQueueFallbackOnly", "idleWatchlistFallbackOnly", "", diagnose);
  renameProperty(raw, "verboseLogging", "diagnosticLogging", "", diagnose);

  if (Object.hasOwn(raw, "autoClaimChannelPoints")) {
    // Move the pre-split top-level toggle under platform.twitch. A genuinely
    // absent platform block is created here; a malformed one (a non-object, or
    // platform.twitch not an object) cannot take the value, so it is dropped.
    // That is consistent, not a loss worth preserving: normalization defaults
    // the entire corrupt platform block regardless, so keeping this one field
    // of it would be arbitrary, and a leftover top-level key is dead data the
    // extension no longer reads and the CLI would reject as unknown. The
    // malformed platform itself is surfaced by each host — the extension
    // defaults it, the CLI reports it. Only a manually corrupted document can
    // reach this; every real prior version wrote platform as an object.
    const legacy = raw.autoClaimChannelPoints;
    delete raw.autoClaimChannelPoints;
    const twitch = ensurePlatformBlock(raw, "twitch");
    if (twitch) {
      diagnose({
        code: "moved_property",
        path: "autoClaimChannelPoints",
        replacement: "platform.twitch.autoClaimChannelPoints",
        message: "autoClaimChannelPoints moved to platform.twitch.autoClaimChannelPoints",
      });
      if (!Object.hasOwn(twitch, "autoClaimChannelPoints")) twitch.autoClaimChannelPoints = legacy;
    }
  }

  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block) continue;
    renameProperty(
      block,
      "watchQueueChannels",
      "idleWatchlistChannels",
      `platform.${platform}.`,
      diagnose,
    );
  }

  return raw;
}

// Migration 2 replaces the six-key campaignVisibility record. In the shipped
// release campaignVisibility was DISPLAY-ONLY: it decided what the popup's Drops
// list showed and never affected farming. In this branch, farming eligibility is
// gated by a new, separate field. campaignVisibility was purely a display
// preference, so all six keys map into the new display field dropsListFilter —
// including notLinked/subscription, which dropsListFilter now expresses as
// showNotLinked/showSubscription. This preserves the user's old display prefs
// exactly. farmingEligibility is deliberately NOT populated here: mapping a
// display preference into a farming flag would silently reduce farming for
// anyone who had merely hidden those campaigns, which never meant anything about
// farming. With farmingEligibility absent, normalization defaults both flags to
// true, preserving today's farming behaviour for every profile. This upholds the
// invariant "anything farmed must be visible": farming defaults on, so the
// farming-on branch of isCampaignVisible keeps not-linked/subscription campaigns
// visible regardless of the migrated show flags. The interim campaignFilters
// name never shipped and is dropped defensively. Migrations reshape; they never
// inspect sub-value types, so a wrong-typed old value is carried across and
// normalization decides.
const CAMPAIGN_VISIBILITY_MAPPING: ReadonlyArray<{ from: string; toKey: string }> = [
  { from: "upcoming", toKey: "showUpcoming" },
  { from: "expired", toKey: "showExpired" },
  { from: "finished", toKey: "showFinished" },
  { from: "excluded", toKey: "showExcluded" },
  { from: "notLinked", toKey: "showNotLinked" },
  { from: "subscription", toKey: "showSubscription" },
];

function migrateToV2(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  // The interim name never persisted, but a branch-built profile might carry it;
  // drop it so it cannot linger as dead data the CLI would reject as unknown.
  delete raw.campaignFilters;

  if (!Object.hasOwn(raw, "campaignVisibility")) return raw;
  const legacy = raw.campaignVisibility;
  delete raw.campaignVisibility;

  // Present but not a plain object: drop it without writing garbage into the new
  // field; normalization then defaults it.
  if (!isRecord(legacy)) return raw;

  // Names where the value ends up once every migration has run: migration 7
  // retired dropsListFilter, so naming it would point at a removed setting.
  diagnose({
    code: "deprecated_property",
    path: "campaignVisibility",
    message:
      "campaignVisibility was removed; the popup groups campaigns into Queue, Completed, Skipped and Upcoming, and farming eligibility is controlled separately",
  });

  for (const { from, toKey } of CAMPAIGN_VISIBILITY_MAPPING) {
    if (!Object.hasOwn(legacy, from)) continue;
    const block = ensureBlock(raw, "dropsListFilter");
    // A malformed pre-existing block cannot take the value; a current key wins.
    if (block && !Object.hasOwn(block, toKey)) block[toKey] = legacy[from];
  }

  return raw;
}

// Migration 3 introduces the critical-failure prompt toggle. Absent means "on":
// existing installs get the detector, and an explicit false is preserved.
function migrateToV3(raw: Record<string, unknown>, _diagnose: Diagnose): Record<string, unknown> {
  if (!Object.hasOwn(raw, "criticalFailurePromptEnabled")) raw.criticalFailurePromptEnabled = true;
  return raw;
}

// Drops the global `running` master switch: farming is now active for a platform
// when that platform is enabled, and nothing else.
//
// The value cannot simply be discarded. The popup used to render each toggle as
// `running && platform.enabled`, so a stored `running: false` displayed every
// platform as off no matter what the per-platform flags said. Keeping those
// flags as-is would silently start farming on upgrade for platforms the user
// last saw switched off. Committing what was displayed is the faithful
// translation, and it matches how autoStartDropFarming now suspends farming.
function migrateToV4(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  if (!Object.hasOwn(raw, "running")) return raw;
  const wasRunning = raw.running;
  delete raw.running;
  if (wasRunning !== false) return raw;
  const disabled: string[] = [];
  for (const key of ["twitch", "kick"]) {
    const block = platformBlock(raw, key);
    if (!block || block.enabled === false) continue;
    block.enabled = false;
    disabled.push(key);
  }
  if (disabled.length > 0) {
    diagnose({
      code: "deprecated_property",
      path: "running",
      message: `running was removed; automation was switched off, so ${disabled.join(" and ")} kept the disabled state they were shown with`,
    });
  }
  return raw;
}

// Replaces the per-platform `farmAllCategories` boolean with the three-value
// `categoryMode`. Not a rename: the key and the value shape both change, so
// renameProperty cannot express it.
//
// `false` was the only value that ever meant "restrict to the list", because
// normalization read the boolean as booleanOr(value, true) — absent, null, or a
// wrong-typed value already meant farm-all. So `=== false` maps to "include"
// and everything else maps to "all", which reproduces every existing profile's
// farming behaviour exactly. `categories` is not touched: order and metadata
// carry over untouched, so a later switch to exclude and back restores the same
// include priority ordering.
function migrateToV5(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block || !Object.hasOwn(block, "farmAllCategories")) continue;
    const legacy = block.farmAllCategories;
    delete block.farmAllCategories;
    diagnose({
      code: "deprecated_property",
      path: `platform.${platform}.farmAllCategories`,
      replacement: `platform.${platform}.categoryMode`,
      message: `platform.${platform}.farmAllCategories is deprecated; use platform.${platform}.categoryMode`,
    });
    // A current key always wins, matching renameProperty's convention.
    if (!Object.hasOwn(block, "categoryMode"))
      block.categoryMode = legacy === false ? "include" : "all";
  }
  return raw;
}

// Materializes complete per-platform source orders so hosts persist the new
// shape once, including the legacy preference for watching Idle first.
function migrateToV6(raw: Record<string, unknown>, _diagnose: Diagnose): Record<string, unknown> {
  for (const platform of ["twitch", "kick"] as const) {
    const block = ensurePlatformBlock(raw, platform);
    if (block && !Object.hasOwn(block, "watchSourcePriority")) {
      block.watchSourcePriority = normalizePlatformWatchSourcePriority(
        platform,
        block,
        raw.idleWatchlistFallbackOnly,
      );
    }
  }
  // Keep the old serialized field for backward compatibility. Its old false
  // sticky-idle preference now becomes predictable Watchlist-first selection.
  return raw;
}

// Collapses the old ranking stack into the pins/favourites/strategy model:
// the dense campaignPriorities map becomes an ordered pin list, the
// priority_list_only mode becomes the farmPinnedOnly switch, and an
// exclude-mode category list becomes blockedCategories under the "all" mode.
// The display-only dropsListFilter goes away entirely — Completed, Skipped and
// Upcoming are sections of the popup now, not toggles.
function migrateToV7(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  if (Object.hasOwn(raw, "campaignPriorities")) {
    const legacy = raw.campaignPriorities;
    delete raw.campaignPriorities;
    diagnose({
      code: "moved_property",
      path: "campaignPriorities",
      replacement: "campaignPins",
      message: "campaignPriorities is now the ordered campaignPins list",
    });
    if (!Object.hasOwn(raw, "campaignPins") && isRecord(legacy)) {
      raw.campaignPins = Object.entries(legacy)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        )
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([campaignId]) => campaignId);
    }
  }

  if (raw.priorityMode === "priority_list_only") {
    raw.priorityMode = "ending_soonest";
    // Migration 8 moves the top-level switch onto each platform, so the
    // message names where it ends up.
    diagnose({
      code: "moved_property",
      path: "priorityMode",
      replacements: ["platform.twitch.farmPinnedOnly", "platform.kick.farmPinnedOnly"],
      message:
        'priorityMode "priority_list_only" is now the platform.twitch and platform.kick farmPinnedOnly switch',
    });
    if (!Object.hasOwn(raw, "farmPinnedOnly")) raw.farmPinnedOnly = true;
  }

  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block || block.categoryMode !== "exclude") continue;
    const listed = block.categories;
    block.categoryMode = "all";
    block.categories = [];
    // Reported on categoryMode, the key that triggers it: a document can set
    // the exclude mode without a categories list.
    diagnose({
      code: "moved_property",
      path: `platform.${platform}.categoryMode`,
      message: `platform.${platform}.categoryMode "exclude" is now "all", with its categories moved to platform.${platform}.blockedCategories`,
    });
    if (!Object.hasOwn(block, "blockedCategories"))
      block.blockedCategories = Array.isArray(listed) ? listed : [];
  }

  if (Object.hasOwn(raw, "dropsListFilter")) {
    delete raw.dropsListFilter;
    diagnose({
      code: "deprecated_property",
      path: "dropsListFilter",
      message:
        "dropsListFilter is deprecated; the popup groups campaigns into Queue, Completed, Skipped and Upcoming",
    });
  }

  return raw;
}

// Replaces the Queue tab's farmRewardTypes and the global farmingEligibility
// and farmPinnedOnly switches with per-platform settings: a rewardFilter
// ({ kinds, subscriptions }), farmPinnedOnly and farmUnlinkedCampaigns. Only the
// parts the old settings determined are written; normalization fills the rest.
// A tab's subscription choice wins over the old subscription toggle, and a
// current per-platform key always wins over a legacy one.
function migrateToV8(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  const eligibility = raw.farmingEligibility;
  const legacyEligibility = isRecord(eligibility) ? eligibility : {};
  if (Object.hasOwn(raw, "farmingEligibility") && !isRecord(eligibility)) {
    diagnose({
      code: "deprecated_property",
      path: "farmingEligibility",
      message: "farmingEligibility was removed; its switches are per platform now",
    });
  }
  delete raw.farmingEligibility;
  const hasPinnedOnly = Object.hasOwn(raw, "farmPinnedOnly");
  const pinnedOnly = raw.farmPinnedOnly;
  delete raw.farmPinnedOnly;

  // Each moves to both platforms, so no single replacement path exists.
  const onBothPlatforms = (key: string) => [`platform.twitch.${key}`, `platform.kick.${key}`];
  const movedToPlatforms: Array<
    [present: boolean, path: string, message: string, replacements?: string[]]
  > = [
    [
      Object.hasOwn(legacyEligibility, "farmUnlinkedCampaigns"),
      "farmingEligibility.farmUnlinkedCampaigns",
      // Migration 9 turns the copied switch into unlinkedCampaigns.
      "farmingEligibility.farmUnlinkedCampaigns moved to platform.twitch and platform.kick unlinkedCampaigns",
      onBothPlatforms("unlinkedCampaigns"),
    ],
    [
      Object.hasOwn(legacyEligibility, "farmSubscriptionCampaigns"),
      "farmingEligibility.farmSubscriptionCampaigns",
      "farmingEligibility.farmSubscriptionCampaigns is now platform.twitch and platform.kick rewardFilter.subscriptions",
    ],
    [
      hasPinnedOnly,
      "farmPinnedOnly",
      "farmPinnedOnly moved to platform.twitch and platform.kick farmPinnedOnly",
      onBothPlatforms("farmPinnedOnly"),
    ],
  ];
  for (const [present, path, message, replacements] of movedToPlatforms) {
    if (present)
      diagnose({ code: "moved_property", path, message, ...(replacements && { replacements }) });
  }
  for (const key of Object.keys(legacyEligibility)) {
    if (key === "farmUnlinkedCampaigns" || key === "farmSubscriptionCampaigns") continue;
    diagnose({
      code: "deprecated_property",
      path: `farmingEligibility.${key}`,
      message: `farmingEligibility.${key} is not a setting and was dropped`,
    });
  }
  const skipsSubscriptions = legacyEligibility.farmSubscriptionCampaigns === false;

  for (const platform of ["twitch", "kick"] as const) {
    const existing = platformBlock(raw, platform);
    const derived: Record<string, unknown> = {};
    if (existing && Object.hasOwn(existing, "farmRewardTypes")) {
      const types = existing.farmRewardTypes;
      delete existing.farmRewardTypes;
      diagnose({
        code: "moved_property",
        path: `platform.${platform}.farmRewardTypes`,
        replacement: `platform.${platform}.rewardFilter`,
        message: `platform.${platform}.farmRewardTypes is now platform.${platform}.rewardFilter`,
      });
      Object.assign(derived, rewardFilterFromFarmTypes(types, platform));
    }
    if (skipsSubscriptions && !Object.hasOwn(derived, "subscriptions"))
      derived.subscriptions = "skip";

    const moved: Record<string, unknown> = {};
    if (Object.keys(derived).length > 0) moved.rewardFilter = derived;
    if (Object.hasOwn(legacyEligibility, "farmUnlinkedCampaigns"))
      moved.farmUnlinkedCampaigns = legacyEligibility.farmUnlinkedCampaigns;
    if (hasPinnedOnly) moved.farmPinnedOnly = pinnedOnly;
    if (Object.keys(moved).length === 0) continue;

    const block = ensurePlatformBlock(raw, platform);
    if (!block) continue;
    for (const [key, value] of Object.entries(moved)) {
      if (!Object.hasOwn(block, key)) block[key] = value;
    }
  }

  return raw;
}

// farmRewardTypes (1.18.0) farmed a reward matching ANY selected type, while a
// rewardFilter farms one matching its kinds AND its subscription mode. A union
// the filter can express maps exactly. One it cannot — a badge together with a
// subscription type — gets no filter, so normalization farms every reward: the
// mapping may widen farming but never narrows it. Kick ignored "badge", as the
// old normalizer did.
function rewardFilterFromFarmTypes(types: unknown, platform: string): Record<string, unknown> {
  if (!Array.isArray(types)) return {};
  const badge = platform === "twitch" && types.includes("badge");
  const skip = types.includes("no_subscription");
  const only = types.includes("subscription");
  if (skip && only) return {};
  if (badge && (skip || only)) return {};
  if (badge) return { kinds: ["badge"] };
  if (skip) return { subscriptions: "skip" };
  if (only) return { subscriptions: "only" };
  return {};
}

// The per-platform farmUnlinkedCampaigns switch becomes unlinkedCampaigns, a
// choice with a third option ("last"). true keeps farming them ("include"),
// false keeps skipping them ("skip"). A current key always wins. Any other
// legacy value moves across as it is, so normalization (or the CLI's
// validation) judges it, as renameProperty does.
function migrateToV9(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block || !Object.hasOwn(block, "farmUnlinkedCampaigns")) continue;
    const legacy = block.farmUnlinkedCampaigns;
    delete block.farmUnlinkedCampaigns;
    diagnose({
      code: "moved_property",
      path: `platform.${platform}.farmUnlinkedCampaigns`,
      replacement: `platform.${platform}.unlinkedCampaigns`,
      message: `platform.${platform}.farmUnlinkedCampaigns is now platform.${platform}.unlinkedCampaigns ("include", "skip" or "last")`,
    });
    if (Object.hasOwn(block, "unlinkedCampaigns")) continue;
    block.unlinkedCampaigns = legacy === true ? "include" : legacy === false ? "skip" : legacy;
  }
  return raw;
}

// The Idle Watchlist became the Watchlist: its channel keys lose the prefix and
// its watch-source id becomes "watchlist", keeping its place in the order. A
// current key always wins, as renameProperty does.
function migrateToV10(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block) continue;
    const prefix = `platform.${platform}.`;
    renameProperty(block, "idleWatchlistChannels", "watchlistChannels", prefix, diagnose);
    renameProperty(
      block,
      "idleWatchlistStreakChannels",
      "watchlistStreakChannels",
      prefix,
      diagnose,
    );
    const priority = block.watchSourcePriority;
    if (Array.isArray(priority) && priority.includes("idle_watchlist")) {
      block.watchSourcePriority = priority.map((source) =>
        source === "idle_watchlist" ? "watchlist" : source,
      );
    }
  }
  return raw;
}

// Creates a nested block only when it is safe to do so; a pre-existing malformed
// block is left untouched so validation can report it verbatim.
function ensureBlock(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(raw, key)) raw[key] = {};
  const block = raw[key];
  return isRecord(block) ? block : undefined;
}

// Drops the legacy key and reports it. The current key wins whenever it is
// present, whatever its value — including `false`, `[]`, or a wrong-typed
// value. Migrations reshape; they never inspect types. Normalization decides
// what a value means afterwards, so a wrong-typed current value falls to its
// default rather than resurrecting the deprecated one. That is a deliberate
// narrow change from the pre-registry inline fallbacks, which fell back to the
// legacy value when the current one failed a typeof check.
function renameProperty(
  owner: Record<string, unknown>,
  legacyKey: string,
  currentKey: string,
  pathPrefix: string,
  diagnose: Diagnose,
): void {
  if (!Object.hasOwn(owner, legacyKey)) return;
  const legacy = owner[legacyKey];
  delete owner[legacyKey];
  diagnose({
    code: "deprecated_property",
    path: `${pathPrefix}${legacyKey}`,
    replacement: `${pathPrefix}${currentKey}`,
    message: `${pathPrefix}${legacyKey} is deprecated; use ${pathPrefix}${currentKey}`,
  });
  if (!Object.hasOwn(owner, currentKey)) owner[currentKey] = legacy;
}

function platformBlock(
  raw: Record<string, unknown>,
  platform: string,
): Record<string, unknown> | undefined {
  const platforms = raw.platform;
  if (!isRecord(platforms)) return undefined;
  const block = platforms[platform];
  return isRecord(block) ? block : undefined;
}

// Creates `platform.<name>` only when it is safe to do so; a malformed block is
// left untouched so validation can report it verbatim.
function ensurePlatformBlock(
  raw: Record<string, unknown>,
  platform: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(raw, "platform")) raw.platform = {};
  const platforms = raw.platform;
  if (!isRecord(platforms)) return undefined;
  if (!Object.hasOwn(platforms, platform)) platforms[platform] = {};
  const block = platforms[platform];
  return isRecord(block) ? block : undefined;
}

if (
  MIGRATIONS.length !== CURRENT_SETTINGS_SCHEMA_VERSION
  || MIGRATIONS.some((migration, index) => migration.to !== index + 1)
) {
  throw new Error(
    "Settings migration registry is not a contiguous 1..CURRENT_SETTINGS_SCHEMA_VERSION sequence",
  );
}

// `version` exists for tests that need a document stored by an older build.
export function withSchemaVersion<T extends object>(
  settings: T,
  version: number = CURRENT_SETTINGS_SCHEMA_VERSION,
): T & { schemaVersion: number } {
  return { ...settings, [SETTINGS_SCHEMA_VERSION_KEY]: version } as T & { schemaVersion: number };
}

export function migrateSettings(raw: unknown): SettingsMigrationResult {
  const source = isRecord(raw) ? raw : {};
  const fromVersion = readVersion(source);
  const { [SETTINGS_SCHEMA_VERSION_KEY]: _version, ...rest } = source;

  const diagnostics: SettingsMigrationDiagnostic[] = [];
  const seen = new Set<string>();
  const diagnose: Diagnose = (diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  let settings = structuredClone(rest) as Record<string, unknown>;
  for (const migration of MIGRATIONS.slice(fromVersion)) {
    settings = migration.migrate(settings, diagnose);
  }

  return {
    settings,
    fromVersion,
    toVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    changed: fromVersion !== CURRENT_SETTINGS_SCHEMA_VERSION,
    // A migration can report a key an earlier one wrote in this same run, such
    // as migration 9 renaming the farmUnlinkedCampaigns migration 8 copied
    // onto each platform. That key was never in the document, so reporting it
    // would send a user looking for a line their file does not contain. The
    // earlier diagnostic names where the value ends up instead.
    diagnostics: finalReplacements(
      diagnostics.filter((diagnostic) => hasPath(rest, diagnostic.path)),
      diagnostics,
    ),
  };
}

// A rename a later migration renames again (watchQueueChannels became
// idleWatchlistChannels in migration 1, then watchlistChannels in migration
// 10) names the key the value ends up under, not the intermediate one.
function finalReplacements(
  kept: SettingsMigrationDiagnostic[],
  all: SettingsMigrationDiagnostic[],
): SettingsMigrationDiagnostic[] {
  const byPath = new Map(all.map((diagnostic) => [diagnostic.path, diagnostic]));
  return kept.map((diagnostic) => {
    let replacement = diagnostic.replacement;
    const visited = new Set<string>();
    while (replacement && !visited.has(replacement)) {
      visited.add(replacement);
      const next = byPath.get(replacement)?.replacement;
      if (!next) break;
      replacement = next;
    }
    if (!replacement || replacement === diagnostic.replacement) return diagnostic;
    return {
      ...diagnostic,
      replacement,
      message: diagnostic.message.split(diagnostic.replacement!).join(replacement),
    };
  });
}

function hasPath(source: Record<string, unknown>, path: string): boolean {
  let owner: unknown = source;
  for (const key of path.split(".")) {
    if (!isRecord(owner) || !Object.hasOwn(owner, key)) return false;
    owner = owner[key];
  }
  return true;
}

function readVersion(source: Record<string, unknown>): number {
  if (!Object.hasOwn(source, SETTINGS_SCHEMA_VERSION_KEY)) return 0;
  const version = source[SETTINGS_SCHEMA_VERSION_KEY];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new UnsupportedSettingsVersionError(version, "invalid");
  }
  if (version > CURRENT_SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSettingsVersionError(version, "future");
  }
  return version;
}
