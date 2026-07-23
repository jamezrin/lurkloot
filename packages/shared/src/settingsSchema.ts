// The single authority for versioned settings-shape migrations. Both hosts run
// `migrateSettings` on their raw persisted payload *before* normalization: the
// raw property information is what makes accurate deprecation diagnostics
// possible, and defaulting or clamping would erase it.
//
// See docs/architecture.md ("Settings Migrations") before adding one.

// Incremented for every semantic settings-shape migration.
export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;

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
    super(reason === "future"
      ? `Settings schema version ${String(version)} is newer than this build supports (${CURRENT_SETTINGS_SCHEMA_VERSION})`
      : `Settings schema version ${String(version)} is not a non-negative integer`);
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
    renameProperty(block, "watchQueueChannels", "idleWatchlistChannels", `platform.${platform}.`, diagnose);
  }

  return raw;
}

// Migration 2 renames campaignVisibility to campaignFilters. The setting stopped
// being display-only: FarmingFilterKey entries now gate eligibility, so the name
// had to stop saying "visibility". Values carry over untouched — no user's
// farming changes, because the only keys defaulting to false (expired, excluded)
// are not farming keys.
function migrateToV2(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  renameProperty(raw, "campaignVisibility", "campaignFilters", "", diagnose);
  return raw;
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

function platformBlock(raw: Record<string, unknown>, platform: string): Record<string, unknown> | undefined {
  const platforms = raw.platform;
  if (!isPlainObject(platforms)) return undefined;
  const block = platforms[platform];
  return isPlainObject(block) ? block : undefined;
}

// Creates `platform.<name>` only when it is safe to do so; a malformed block is
// left untouched so validation can report it verbatim.
function ensurePlatformBlock(raw: Record<string, unknown>, platform: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(raw, "platform")) raw.platform = {};
  const platforms = raw.platform;
  if (!isPlainObject(platforms)) return undefined;
  if (!Object.hasOwn(platforms, platform)) platforms[platform] = {};
  const block = platforms[platform];
  return isPlainObject(block) ? block : undefined;
}

if (MIGRATIONS.length !== CURRENT_SETTINGS_SCHEMA_VERSION
  || MIGRATIONS.some((migration, index) => migration.to !== index + 1)) {
  throw new Error("Settings migration registry is not a contiguous 1..CURRENT_SETTINGS_SCHEMA_VERSION sequence");
}

export function withSchemaVersion<T extends object>(settings: T): T & { schemaVersion: number } {
  return { ...settings, [SETTINGS_SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION } as T & { schemaVersion: number };
}

export function migrateSettings(raw: unknown): SettingsMigrationResult {
  const source = isPlainObject(raw) ? raw : {};
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
    diagnostics,
  };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
