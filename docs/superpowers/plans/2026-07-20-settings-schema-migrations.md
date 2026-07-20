# Versioned Settings Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered inline legacy-settings fallbacks with one ordered, versioned migration registry in `@lurkloot/shared` that both the extension and the CLI run before normalization.

**Architecture:** A new `packages/shared/src/settingsSchema.ts` owns `CURRENT_SETTINGS_SCHEMA_VERSION`, an ordered migration registry, and `migrateSettings(raw)`. Migration and normalization are separate phases: hosts call `migrateSettings` on the raw persisted payload, then pass the migrated payload to the existing `mergeSettings` / `parseCliSettings`. The extension stores a flat settings document with a reserved `schemaVersion` property and writes back once when a migration ran; the CLI migrates in memory only and re-warns on every startup.

**Tech Stack:** TypeScript 7 (strict, ESM), pnpm workspaces, Vitest (node environment, globals enabled), WXT, jsonc-parser.

## Global Constraints

- Migrations are pure: they must not mutate their input and must be deterministic.
- Running the full pipeline on a current-version document is a no-op that writes nothing.
- The CLI configuration file is never rewritten, reformatted, or backed up.
- Current property names always win over deprecated aliases; the deprecated alias still produces a diagnostic.
- Migration functions never log. Hosts format and route diagnostics.
- No defaults, clamps, or farming behavior change in this work.
- `schemaVersion` is reserved metadata: it is stripped before producing `ExtensionSettings` / `CliSettings` and is not a member of either type.

## Design Decisions (resolved before planning)

- Migration 1 absorbs **every** existing inline legacy fallback, not just the Idle Watchlist aliases: `watchQueueFallbackOnly`, `platform.<p>.watchQueueChannels`, top-level `autoClaimChannelPoints`, and `verboseLogging`.
- Because top-level `autoClaimChannelPoints` becomes a registered alias, the CLI **accepts it with a deprecation warning** instead of hard-erroring. `MOVED_SETTING_KEYS` is deleted.
- `enabledLogLevels` is out of scope. It is a deprecated-and-ignored CLI knob with no replacement, not a shape migration; it keeps its existing dedicated warning in `packages/cli/src/config.ts`.
- The legacy `gamePriority` key stays intentionally un-migrated (see the comment above `normalizeCategorySelections`).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/settingsSchema.ts` (new) | Version constant, diagnostic/result types, error type, ordered registry, `migrateSettings`, `withSchemaVersion`. |
| `packages/shared/package.json` | Add the `./settingsSchema` export. |
| `packages/shared/src/settings.ts` | Drop `currentOrLegacy` and all inline legacy reads; normalize only current names. |
| `packages/extension/src/core/storage.ts` | Migrate → normalize → conditional write-back under the settings lock; stamp `schemaVersion` on every write. |
| `packages/cli/src/settings.ts` | Migrate before validation; drop legacy allowlist entries and `MOVED_SETTING_KEYS`; return diagnostics. |
| `packages/cli/src/config.ts` | Format diagnostics into `warnings`; add `schemaVersion` to the generated template. |
| `docs/architecture.md` | "Adding a settings migration" section. |

---

### Task 1: Shared schema module — versions, types, and errors

**Files:**
- Create: `packages/shared/src/settingsSchema.ts`
- Modify: `packages/shared/package.json`
- Test: `packages/extension/tests/settingsMigrations.test.ts` (new)

**Interfaces:**
- Consumes: an arbitrary persisted value (`unknown`).
- Produces: `SettingsMigrationResult`, `UnsupportedSettingsVersionError`, `CURRENT_SETTINGS_SCHEMA_VERSION`.

- [ ] **Step 1: Add the package export**

In `packages/shared/package.json`, add to `exports` after the `"./settings"` line:

```json
    "./settingsSchema": "./src/settingsSchema.ts",
```

- [ ] **Step 2: Write the failing version-handling tests**

Create `packages/extension/tests/settingsMigrations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  UnsupportedSettingsVersionError,
  migrateSettings,
  withSchemaVersion,
} from "@lurkloot/shared/settingsSchema";

describe("settings schema versions", () => {
  it("treats an unversioned object as version 0", () => {
    const result = migrateSettings({ autoClaim: false });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.changed).toBe(true);
  });

  it("treats a missing or non-object payload as an empty version 0 document", () => {
    for (const raw of [undefined, null, "nope", 42, ["a"]]) {
      const result = migrateSettings(raw);
      expect(result.settings).toEqual({});
      expect(result.fromVersion).toBe(0);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("is a no-op for a current-version document", () => {
    const stored = withSchemaVersion({ autoClaim: false });
    const result = migrateSettings(stored);
    expect(result.changed).toBe(false);
    expect(result.fromVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.diagnostics).toEqual([]);
    expect(result.settings).toEqual({ autoClaim: false });
  });

  it("strips the reserved schemaVersion property from the migrated payload", () => {
    const result = migrateSettings(withSchemaVersion({ autoClaim: true }));
    expect(result.settings).not.toHaveProperty(SETTINGS_SCHEMA_VERSION_KEY);
  });

  it("never mutates its input", () => {
    const stored = { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["A"] } } };
    const snapshot = structuredClone(stored);
    migrateSettings(stored);
    expect(stored).toEqual(snapshot);
  });

  it("is idempotent when re-run on its own output", () => {
    const first = migrateSettings({ watchQueueFallbackOnly: false });
    const second = migrateSettings(withSchemaVersion(first.settings));
    expect(second.settings).toEqual(first.settings);
    expect(second.changed).toBe(false);
  });

  it("rejects a future schema version", () => {
    const future = CURRENT_SETTINGS_SCHEMA_VERSION + 1;
    expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future }))
      .toThrow(UnsupportedSettingsVersionError);
    try {
      migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future });
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSettingsVersionError);
      expect((error as UnsupportedSettingsVersionError).version).toBe(future);
      expect((error as UnsupportedSettingsVersionError).reason).toBe("future");
    }
  });

  it("rejects a malformed schema version", () => {
    for (const version of [-1, 1.5, Number.NaN, "1", null]) {
      expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: version }))
        .toThrow(UnsupportedSettingsVersionError);
    }
  });

  it("stamps the current version with withSchemaVersion", () => {
    expect(withSchemaVersion({ autoClaim: true })).toEqual({
      autoClaim: true,
      [SETTINGS_SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION,
    });
  });

  it("upgrades a version 0 document all the way to the current version", () => {
    // Guards sequential application: whatever CURRENT_SETTINGS_SCHEMA_VERSION
    // becomes, entering at 0 must land on it. The contiguity of the registry
    // itself is asserted at module load, so a missing step throws on import
    // rather than letting a host write a half-migrated document.
    expect(migrateSettings({}).toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(migrateSettings({}).fromVersion).toBe(0);
  });

  it("enters at every intermediate version without skipping steps", () => {
    // Re-migrating from each supported version must converge on the same
    // document as migrating the whole way from 0.
    const target = migrateSettings({ autoClaim: false }).settings;
    for (let version = 0; version <= CURRENT_SETTINGS_SCHEMA_VERSION; version += 1) {
      const result = migrateSettings({ ...target, [SETTINGS_SCHEMA_VERSION_KEY]: version });
      expect(result.settings).toEqual(target);
      expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test -- settingsMigrations`
Expected: FAIL — `Failed to resolve import "@lurkloot/shared/settingsSchema"`.

- [ ] **Step 4: Implement the schema module skeleton**

Create `packages/shared/src/settingsSchema.ts`. Migration 1's body is a stub here; Task 2 fills it in.

```ts
// The single authority for versioned settings-shape migrations. Both hosts run
// `migrateSettings` on their raw persisted payload *before* normalization: the
// raw property information is what makes accurate deprecation diagnostics
// possible, and defaulting or clamping would erase it.
//
// See docs/architecture.md ("Adding a settings migration") before adding one.

// Incremented for every semantic settings-shape migration.
export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;

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
  { to: 1, migrate: (raw) => raw },
];

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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test -- settingsMigrations`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/settingsSchema.ts packages/shared/package.json packages/extension/tests/settingsMigrations.test.ts
git commit -m "feat(shared): add versioned settings schema module"
```

---

### Task 2: Migration 1 — consolidate every legacy alias

**Files:**
- Modify: `packages/shared/src/settingsSchema.ts` (the `MIGRATIONS` entry added in Task 1)
- Test: `packages/extension/tests/settingsMigrations.test.ts`

**Interfaces:**
- Consumes: a version 0 raw payload.
- Produces: a version 1 raw payload plus `deprecated_property` / `moved_property` diagnostics.

Migration 1 recognizes exactly five legacy shapes:

| Legacy path | Current path | Code |
| --- | --- | --- |
| `watchQueueFallbackOnly` | `idleWatchlistFallbackOnly` | `deprecated_property` |
| `platform.twitch.watchQueueChannels` | `platform.twitch.idleWatchlistChannels` | `deprecated_property` |
| `platform.kick.watchQueueChannels` | `platform.kick.idleWatchlistChannels` | `deprecated_property` |
| `verboseLogging` | `diagnosticLogging` | `deprecated_property` |
| `autoClaimChannelPoints` | `platform.twitch.autoClaimChannelPoints` | `moved_property` |

- [ ] **Step 1: Write the failing migration tests**

Append to `packages/extension/tests/settingsMigrations.test.ts`:

```ts
describe("migration 1: legacy aliases", () => {
  it("renames the Watch Queue properties", () => {
    const result = migrateSettings({
      watchQueueFallbackOnly: false,
      platform: {
        twitch: { watchQueueChannels: ["Legacy"] },
        kick: { watchQueueChannels: ["KickLegacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: false,
      platform: {
        twitch: { idleWatchlistChannels: ["Legacy"] },
        kick: { idleWatchlistChannels: ["KickLegacy"] },
      },
    });
    expect(result.settings).not.toHaveProperty("watchQueueFallbackOnly");
  });

  it("moves a top-level autoClaimChannelPoints onto platform.twitch", () => {
    const result = migrateSettings({ autoClaimChannelPoints: false });
    expect(result.settings).toEqual({ platform: { twitch: { autoClaimChannelPoints: false } } });
    expect(result.diagnostics).toContainEqual({
      code: "moved_property",
      path: "autoClaimChannelPoints",
      replacement: "platform.twitch.autoClaimChannelPoints",
      message: "autoClaimChannelPoints moved to platform.twitch.autoClaimChannelPoints",
    });
  });

  it("renames verboseLogging to diagnosticLogging", () => {
    expect(migrateSettings({ verboseLogging: true }).settings).toEqual({ diagnosticLogging: true });
    expect(migrateSettings({ verboseLogging: false }).settings).toEqual({ diagnosticLogging: false });
  });

  it("keeps a non-boolean legacy value verbatim so normalization decides", () => {
    // mergeSettings applies booleanOr afterwards; the migration only reshapes.
    expect(migrateSettings({ autoClaimChannelPoints: "yes" }).settings)
      .toEqual({ platform: { twitch: { autoClaimChannelPoints: "yes" } } });
  });

  it("lets the current property win while still reporting the deprecated one", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      watchQueueFallbackOnly: false,
      diagnosticLogging: false,
      verboseLogging: true,
      autoClaimChannelPoints: false,
      platform: {
        twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"], autoClaimChannelPoints: true },
        kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: true,
      diagnosticLogging: false,
      platform: {
        twitch: { idleWatchlistChannels: [], autoClaimChannelPoints: true },
        kick: { idleWatchlistChannels: ["new"] },
      },
    });
    expect(result.diagnostics.map((d) => d.path)).toEqual([
      "watchQueueFallbackOnly",
      "verboseLogging",
      "autoClaimChannelPoints",
      "platform.twitch.watchQueueChannels",
      "platform.kick.watchQueueChannels",
    ]);
  });

  it("emits a stable, deduplicated diagnostic per deprecated property", () => {
    const result = migrateSettings({ watchQueueFallbackOnly: false });
    expect(result.diagnostics).toEqual([{
      code: "deprecated_property",
      path: "watchQueueFallbackOnly",
      replacement: "idleWatchlistFallbackOnly",
      message: "watchQueueFallbackOnly is deprecated; use idleWatchlistFallbackOnly",
    }]);
  });

  it("reports nothing for a payload that only uses current names", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      platform: { twitch: { idleWatchlistChannels: ["a"] } },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.changed).toBe(true); // unversioned input still gets stamped
  });

  it("leaves unrelated and malformed platform blocks alone", () => {
    expect(migrateSettings({ platform: "nope", other: 1 }).settings).toEqual({ platform: "nope", other: 1 });
    expect(migrateSettings({ platform: { twitch: null } }).settings).toEqual({ platform: { twitch: null } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test -- settingsMigrations`
Expected: FAIL — the stub migration returns its input, so the rename assertions fail.

- [ ] **Step 3: Implement migration 1**

In `packages/shared/src/settingsSchema.ts`, replace the stub registry with the real one and add the helpers below it:

```ts
// Migration 1 consolidates every legacy shape that predates the registry: the
// Idle Watchlist rename (PR #177), the pre-split top-level channel-points
// toggle, and the verboseLogging rename. Diagnostics are emitted in a fixed
// order so host warnings are stable across runs.
const MIGRATIONS: SettingsMigration[] = [
  { to: 1, migrate: migrateToV1 },
];

function migrateToV1(raw: Record<string, unknown>, diagnose: Diagnose): Record<string, unknown> {
  renameProperty(raw, "watchQueueFallbackOnly", "idleWatchlistFallbackOnly", "", diagnose);
  renameProperty(raw, "verboseLogging", "diagnosticLogging", "", diagnose);

  if (Object.hasOwn(raw, "autoClaimChannelPoints")) {
    const legacy = raw.autoClaimChannelPoints;
    delete raw.autoClaimChannelPoints;
    diagnose({
      code: "moved_property",
      path: "autoClaimChannelPoints",
      replacement: "platform.twitch.autoClaimChannelPoints",
      message: "autoClaimChannelPoints moved to platform.twitch.autoClaimChannelPoints",
    });
    const twitch = ensurePlatformBlock(raw, "twitch");
    if (twitch && !Object.hasOwn(twitch, "autoClaimChannelPoints")) {
      twitch.autoClaimChannelPoints = legacy;
    }
  }

  for (const platform of ["twitch", "kick"] as const) {
    const block = platformBlock(raw, platform);
    if (!block) continue;
    renameProperty(block, "watchQueueChannels", "idleWatchlistChannels", `platform.${platform}.`, diagnose);
  }

  return raw;
}

// Drops the legacy key and reports it. The current key wins when both exist,
// including when its value is `false` or an empty array.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test -- settingsMigrations`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/settingsSchema.ts packages/extension/tests/settingsMigrations.test.ts
git commit -m "feat(shared): add the first settings schema migration"
```

---

### Task 3: Strip inline legacy handling from normalization

**Files:**
- Modify: `packages/shared/src/settings.ts:100-206` (`mergeEngineSettings`, `currentOrLegacy`, `mergeSettings`)
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- `mergeEngineSettings` / `mergeSettings` keep their signatures but now only read current property names.

- [ ] **Step 1: Move the legacy assertions out of the normalization tests**

In `packages/extension/tests/settings.test.ts`, delete the four legacy cases now covered by `settingsMigrations.test.ts`:
- the `watchQueueFallbackOnly` / `watchQueueChannels` migration and precedence tests around lines 37-60,
- `"migrates the legacy verboseLogging flag"` (lines 186-189),
- `"migrates a legacy top-level autoClaimChannelPoints onto platform.twitch"` and the precedence/strip/non-boolean cases (lines 302-326).

Keep `"defaults autoClaimChannelPoints on for Twitch"` (line 298) and the `enabledLogLevels` cases (lines 182-183) — those assert normalization, not migration.

Replace them with one test proving normalization no longer reads legacy names:

```ts
it("ignores legacy property names, which the migration registry handles first", () => {
  const merged = mergeSettings({
    watchQueueFallbackOnly: false,
    verboseLogging: true,
    autoClaimChannelPoints: false,
    platform: { ...DEFAULT_SETTINGS.platform, twitch: { ...DEFAULT_SETTINGS.platform.twitch, watchQueueChannels: ["legacy"] } },
  } as never);
  expect(merged.idleWatchlistFallbackOnly).toBe(DEFAULT_SETTINGS.idleWatchlistFallbackOnly);
  expect(merged.diagnosticLogging).toBe(false);
  expect(merged.platform.twitch.autoClaimChannelPoints).toBe(true);
  expect(merged.platform.twitch.idleWatchlistChannels).toEqual([]);
  expect(merged).not.toHaveProperty("watchQueueFallbackOnly");
});
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `pnpm --filter @lurkloot/extension test -- settings.test`
Expected: FAIL — `mergeSettings` still honors the legacy names, so `idleWatchlistFallbackOnly` is `false` and `diagnosticLogging` is `true`.

- [ ] **Step 3: Remove the inline fallbacks**

In `packages/shared/src/settings.ts`:

Delete the `legacyChannelPoints` line (105) and its comment (103-104), and delete the entire `currentOrLegacy` helper (175-181).

Replace the `idleWatchlistFallbackOnly` entry (114-117) with:

```ts
    idleWatchlistFallbackOnly: booleanOr(value?.idleWatchlistFallbackOnly, DEFAULT_ENGINE_SETTINGS.idleWatchlistFallbackOnly),
```

Replace both `idleWatchlistChannels` entries (124-126 and 137-139) with the direct reads:

```ts
        idleWatchlistChannels: normalizeChannelList(platform?.twitch?.idleWatchlistChannels),
```

```ts
        idleWatchlistChannels: normalizeChannelList(platform?.kick?.idleWatchlistChannels),
```

Replace the `autoClaimChannelPoints` entry (130-133) with:

```ts
        autoClaimChannelPoints: booleanOr(platform?.twitch?.autoClaimChannelPoints, DEFAULT_ENGINE_SETTINGS.platform.twitch.autoClaimChannelPoints),
```

Replace the `mergeSettings` preamble (186-189) with nothing, and change the `diagnosticLogging` entry (204) to:

```ts
    diagnosticLogging: booleanOr(value?.diagnosticLogging, DEFAULT_SETTINGS.diagnosticLogging),
```

Add this comment directly above `mergeEngineSettings` (before line 98's existing comment block):

```ts
// Legacy property names are not read here. Hosts run migrateSettings() from
// @lurkloot/shared/settingsSchema on the raw payload first; by the time a value
// reaches normalization it only carries current names.
```

- [ ] **Step 4: Run the full extension suite**

Run: `pnpm --filter @lurkloot/extension test`
Expected: `settings.test.ts` PASSes. `storageSettingsMigration.test.ts` FAILs — that is expected and fixed in Task 4.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "refactor(shared): read only current names during settings normalization"
```

---

### Task 4: Extension storage runs migration under the settings lock

**Files:**
- Modify: `packages/extension/src/core/storage.ts:32-67` and `:117-130`
- Test: `packages/extension/tests/storageSettingsMigration.test.ts`

**Interfaces:**
- Consumes: `browser.storage.local` key `settings`, holding a flat document of settings properties plus `schemaVersion`.
- Produces: `ExtensionSettings` from `loadSettings`; every write emits `withSchemaVersion(settings)`.

`loadSettings` reads, migrates, normalizes and — only when `changed` — writes back, all while holding `withSettingsStorageLock`, so a migration write can never clobber a concurrent save. A future version throws out of `loadSettings` without writing.

- [ ] **Step 1: Rewrite the storage migration tests**

Replace the body of `packages/extension/tests/storageSettingsMigration.test.ts` after the `vi.mock` block with:

```ts
import { loadSettings, resetStorage, saveSettings } from "../src/core/storage";
import { CURRENT_SETTINGS_SCHEMA_VERSION, UnsupportedSettingsVersionError, withSchemaVersion } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";

describe("settings storage migration", () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    set.mockResolvedValue(undefined);
  });

  it("writes a legacy document back once, using current keys and the current version", async () => {
    get.mockResolvedValue({
      settings: {
        watchQueueFallbackOnly: false,
        platform: {
          twitch: { watchQueueChannels: ["Legacy"] },
          kick: { watchQueueChannels: ["KickLegacy"] },
        },
      },
    });

    const settings = await loadSettings();

    expect(settings.idleWatchlistFallbackOnly).toBe(false);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacy"]);
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0]?.[0].settings;
    expect(written).toEqual(withSchemaVersion(settings));
    expect(written.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(written).not.toHaveProperty("watchQueueFallbackOnly");
    expect(written.platform.twitch).not.toHaveProperty("watchQueueChannels");
  });

  it("stamps an unversioned document that already uses current keys", async () => {
    get.mockResolvedValue({
      settings: { idleWatchlistFallbackOnly: true, platform: { twitch: { idleWatchlistChannels: ["current"] } } },
    });

    await loadSettings();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0].settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  it("does not write when storage is already at the current version", async () => {
    get.mockResolvedValue({ settings: withSchemaVersion(DEFAULT_SETTINGS) });

    await loadSettings();

    expect(set).not.toHaveBeenCalled();
  });

  it("still returns usable settings when the write-back fails, and retries on the next load", async () => {
    get.mockResolvedValue({
      settings: { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["Legacy"] } } },
    });
    set.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(loadSettings()).resolves.toMatchObject({
      idleWatchlistFallbackOnly: false,
      platform: { twitch: { idleWatchlistChannels: ["legacy"] } },
    });
    expect(set).toHaveBeenCalledTimes(1);

    set.mockResolvedValue(undefined);
    await loadSettings();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("rejects a future schema version without writing", async () => {
    get.mockResolvedValue({ settings: { schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION + 1, autoClaim: false } });

    await expect(loadSettings()).rejects.toThrow(UnsupportedSettingsVersionError);
    expect(set).not.toHaveBeenCalled();
  });

  it("emits the current version on an ordinary save", async () => {
    await saveSettings(DEFAULT_SETTINGS);
    expect(set).toHaveBeenCalledWith({ settings: withSchemaVersion(DEFAULT_SETTINGS) });
  });

  it("emits the current version on reset", async () => {
    await resetStorage();
    expect(set.mock.calls[0]?.[0].settings).toEqual(withSchemaVersion(DEFAULT_SETTINGS));
  });

  it("serializes a migration write with a concurrent settings save", async () => {
    let finishMigration: (() => void) | undefined;
    const migrationPending = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    get.mockResolvedValue({
      settings: { watchQueueFallbackOnly: false, platform: { twitch: { watchQueueChannels: ["Legacy"] } } },
    });
    set.mockImplementationOnce(() => migrationPending).mockResolvedValue(undefined);

    const migration = loadSettings();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    const current = mergeSettings({ idleWatchlistFallbackOnly: true });
    const save = saveSettings(current);

    expect(set).toHaveBeenCalledTimes(1);
    finishMigration?.();
    await migration;
    await save;
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]?.[0]).toEqual({ settings: withSchemaVersion(current) });
  });
});
```

Note the `resetStorage` test needs `clearActivityEvents` mocked. Add this alongside the existing `vi.mock("wxt/browser", ...)` at the top of the file:

```ts
vi.mock("../src/core/activityStorage", () => ({
  clearActivityEvents: vi.fn().mockResolvedValue(undefined),
  importLegacyActivityEvents: vi.fn().mockResolvedValue(undefined),
}));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension test -- storageSettingsMigration`
Expected: FAIL — writes carry no `schemaVersion` and the future-version case resolves instead of rejecting.

- [ ] **Step 3: Rewire storage.ts**

In `packages/extension/src/core/storage.ts`:

Add to the imports:

```ts
import { migrateSettings, withSchemaVersion } from "@lurkloot/shared/settingsSchema";
```

Replace `loadSettings` and delete `hasLegacyWatchQueueSettings` entirely (lines 32-61):

```ts
// Reads, migrates, normalizes and — only when the stored document was not
// already at the current schema version — persists the canonical envelope, all
// under the settings lock so a migration write can never overwrite a newer
// concurrent save. A future schema version throws without writing rather than
// replacing data this build does not understand.
export async function loadSettings(): Promise<ExtensionSettings> {
  return withSettingsStorageLock(async () => {
    const data = await browser.storage.local.get(SETTINGS_KEY);
    const migration = migrateSettings(data[SETTINGS_KEY]);
    const settings = mergeSettings(migration.settings as Partial<ExtensionSettings>);
    if (migration.changed) {
      try {
        await browser.storage.local.set({ [SETTINGS_KEY]: withSchemaVersion(settings) });
      } catch {
        // Startup continues on the canonical in-memory settings. The stored
        // document is untouched, so the next load retries the same migration.
      }
    }
    return settings;
  });
}
```

Replace `saveSettings` (63-67):

```ts
export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await withSettingsStorageLock(async () => {
    await browser.storage.local.set({ [SETTINGS_KEY]: withSchemaVersion(settings) });
  });
}
```

In `resetStorage` (117-123), the settings write must take the settings lock too — today it only takes the state lock. Replace the first block with:

```ts
  await withSettingsStorageLock(async () => {
    await browser.storage.local.set({ [SETTINGS_KEY]: withSchemaVersion(DEFAULT_SETTINGS) });
  });
  await withStateStorageLock(async () => {
    await browser.storage.local.set({ [STATE_KEY]: DEFAULT_STATE });
  });
```

- [ ] **Step 4: Run the full extension suite**

Run: `pnpm --filter @lurkloot/extension test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/core/storage.ts packages/extension/tests/storageSettingsMigration.test.ts
git commit -m "feat(extension): migrate stored settings through the shared registry"
```

---

### Task 5: CLI migrates in memory and warns every startup

**Files:**
- Modify: `packages/cli/src/settings.ts:74-100`, `:110-138`, `:144-231`, `:249-286`
- Modify: `packages/cli/src/config.ts:32-115`, `:136-158`
- Test: `packages/cli/tests/settings.test.ts`, `packages/cli/tests/config.test.ts`

**Interfaces:**
- `parseCliSettings(raw)` keeps returning `CliSettings`. A new `parseCliSettingsWithDiagnostics(raw)` returns `{ settings: CliSettings; diagnostics: SettingsMigrationDiagnostic[] }`; `parseCliSettings` delegates to it and discards the diagnostics so existing call sites and tests keep working.
- `parseConfig` formats each diagnostic into `CliConfig.warnings` as `settings.<path> is deprecated; use settings.<replacement>`.

- [ ] **Step 1: Write the failing CLI tests**

In `packages/cli/tests/settings.test.ts`, replace the two legacy Watch Queue tests (lines 5-25) and the `autoClaimChannelPoints` moved-key test (lines 121-124) with:

```ts
import { parseCliSettingsWithDiagnostics } from "../src/settings";

it("migrates legacy Watch Queue settings and reports them", () => {
  const { settings, diagnostics } = parseCliSettingsWithDiagnostics({
    watchQueueFallbackOnly: false,
    platform: { twitch: { watchQueueChannels: [" Legacy ", "legacy"] } },
  });
  expect(settings.idleWatchlistFallbackOnly).toBe(false);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacy"]);
  expect(settings).not.toHaveProperty("watchQueueFallbackOnly");
  expect(diagnostics.map((d) => d.path)).toEqual(["watchQueueFallbackOnly", "platform.twitch.watchQueueChannels"]);
});

it("prefers current keys over legacy ones", () => {
  const settings = parseCliSettings({
    idleWatchlistFallbackOnly: true,
    watchQueueFallbackOnly: false,
    platform: {
      twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"] },
      kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
    },
  });
  expect(settings.idleWatchlistFallbackOnly).toBe(true);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual([]);
  expect(settings.platform.kick.idleWatchlistChannels).toEqual(["new"]);
});

it("accepts a deprecated top-level autoClaimChannelPoints instead of erroring", () => {
  const { settings, diagnostics } = parseCliSettingsWithDiagnostics({ autoClaimChannelPoints: false });
  expect(settings.platform.twitch.autoClaimChannelPoints).toBe(false);
  expect(diagnostics.map((d) => d.path)).toEqual(["autoClaimChannelPoints"]);
});

it("still rejects unknown keys that are not registered aliases", () => {
  expect(() => parseCliSettings({ nonsense: 1 })).toThrow(/unknown CLI setting "nonsense"/);
});

it("still rejects extension-only keys", () => {
  expect(() => parseCliSettings({ muteFarmingTabs: true }))
    .toThrow(/"muteFarmingTabs" is an extension-only setting/);
});

it("accepts schemaVersion at the root of settings without exposing it", () => {
  const settings = parseCliSettings({ schemaVersion: 1, autoClaim: false });
  expect(settings.autoClaim).toBe(false);
  expect(settings).not.toHaveProperty("schemaVersion");
});

it("rejects a future schema version", () => {
  expect(() => parseCliSettings({ schemaVersion: 999 })).toThrow(/newer than this build supports/);
});
```

In `packages/cli/tests/config.test.ts`, add:

```ts
it("warns with the full deprecated and replacement paths", () => {
  const config = parseConfig({
    settings: { watchQueueFallbackOnly: false, platform: { kick: { watchQueueChannels: ["a"] } } },
  }, CONFIG_PATH);
  expect(config.warnings).toContain("settings.watchQueueFallbackOnly is deprecated; use settings.idleWatchlistFallbackOnly");
  expect(config.warnings).toContain("settings.platform.kick.watchQueueChannels is deprecated; use settings.platform.kick.idleWatchlistChannels");
});

it("warns about a moved property with its destination path", () => {
  const config = parseConfig({ settings: { autoClaimChannelPoints: false } }, CONFIG_PATH);
  expect(config.warnings).toContain("settings.autoClaimChannelPoints moved to settings.platform.twitch.autoClaimChannelPoints");
});

it("repeats the warnings on every independent load", () => {
  const raw = { settings: { watchQueueFallbackOnly: false } };
  expect(parseConfig(raw, CONFIG_PATH).warnings).toEqual(parseConfig(raw, CONFIG_PATH).warnings);
});

it("emits no migration warnings for a current config", () => {
  expect(parseConfig({ settings: { schemaVersion: 1, autoClaim: true } }, CONFIG_PATH).warnings).toEqual([]);
});

it("generates a template that carries the current schema version", () => {
  expect(defaultConfigJsonc()).toContain(`"schemaVersion": ${CURRENT_SETTINGS_SCHEMA_VERSION}`);
  expect(parseConfig(parseJsonc(defaultConfigJsonc()), CONFIG_PATH).warnings).toEqual([]);
});
```

Add the imports that test file needs: `defaultConfigJsonc` from `../src/config`, `CURRENT_SETTINGS_SCHEMA_VERSION` from `@lurkloot/shared/settingsSchema`, and `parse as parseJsonc` from `jsonc-parser`.

Also add a test proving the file is never touched:

```ts
it("never rewrites the config file while migrating", () => {
  const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
  const path = join(dir, "config.jsonc");
  writeFileSync(path, '{ "settings": { "watchQueueFallbackOnly": false } }\n');
  const before = readFileSync(path, "utf8");
  const beforeStat = statSync(path).mtimeMs;

  const config = loadConfig(path);

  expect(config.settings.idleWatchlistFallbackOnly).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(statSync(path).mtimeMs).toBe(beforeStat);
  rmSync(dir, { recursive: true, force: true });
});
```

with `mkdtempSync, readFileSync, rmSync, statSync, writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `loadConfig` from `../src/config`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/cli test`
Expected: FAIL — `parseCliSettingsWithDiagnostics` does not exist.

- [ ] **Step 3: Rewire the CLI settings parser**

In `packages/cli/src/settings.ts`:

Add the import:

```ts
import { migrateSettings, type SettingsMigrationDiagnostic } from "@lurkloot/shared/settingsSchema";
```

Remove the legacy aliases from `CLI_SETTING_KEYS` — delete the `"watchQueueFallbackOnly",` line (80). Remove `"watchQueueChannels"` from both `CLI_PLATFORM_KEYS` sets (98-99). The migration deletes those names before validation runs, so allowlisting them here would be dead code.

Delete `MOVED_SETTING_KEYS` (126-130) and simplify `describeOffender` (132-138) to:

```ts
function describeOffender(key: string): string {
  return EXTENSION_ONLY_KEYS.has(key)
    ? `"${key}" is an extension-only setting with no effect in the CLI; remove it`
    : `unknown CLI setting "${key}"`;
}
```

Delete the local `currentOrLegacy` helper (280-286).

Change the `idleWatchlistFallbackOnly` entry (210-213) to:

```ts
    idleWatchlistFallbackOnly: booleanOr(v.idleWatchlistFallbackOnly, DEFAULT_CLI_SETTINGS.idleWatchlistFallbackOnly),
```

Change the `idleWatchlistChannels` entry inside `normalizePlatform` (257-259) to:

```ts
        idleWatchlistChannels: normalizeChannelList(ps.idleWatchlistChannels),
```

Rename the existing `parseCliSettings` body into a new exported function and add a thin wrapper. Replace the signature at line 144 with:

```ts
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
  return { settings: parseMigratedCliSettings(migration.settings), diagnostics: migration.diagnostics };
}

export function parseCliSettings(raw: unknown): CliSettings {
  return parseCliSettingsWithDiagnostics(raw).settings;
}

function parseMigratedCliSettings(value: Record<string, unknown>): CliSettings {
  const offenders: string[] = [];
```

Then delete the four now-redundant lines that opened the old function body (the `if (raw === undefined)` guard, the `if (raw === null …)` guard, the `const value = raw as Record<string, unknown>;` line, and the old `const offenders` line) so `parseMigratedCliSettings` continues straight into the existing `for (const key of Object.keys(value))` loop.

- [ ] **Step 4: Surface the diagnostics as config warnings**

In `packages/cli/src/config.ts`:

Add the imports:

```ts
import { CURRENT_SETTINGS_SCHEMA_VERSION, type SettingsMigrationDiagnostic } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_CLI_SETTINGS, parseCliSettingsWithDiagnostics, type CliSettings } from "./settings";
```

(replacing the existing `./settings` import line 6).

In `defaultConfigJsonc`, add the version as the first property of the `settings` block, directly after `"settings": {` (line 44):

```
    // Schema version of this settings block. Leave it alone unless a release
    // note tells you otherwise; it lets LurkLoot skip replaying old migrations.
    "schemaVersion": ${CURRENT_SETTINGS_SCHEMA_VERSION},

```

In `parseConfig`, replace lines 142 and the warning assembly so migration diagnostics join the existing warnings. Replace line 142:

```ts
  const parsed = parseCliSettingsWithDiagnostics(data.settings);
  const settings = parsed.settings;
  warnings.push(...parsed.diagnostics.map(formatMigrationWarning));
```

and add this helper next to `formatCompatibilityWarning`:

```ts
// Warnings name the complete deprecated path and its replacement so the user
// can find and fix the exact line. The CLI config file is intentionally never
// rewritten, so these repeat on every startup until the file is edited.
function formatMigrationWarning(diagnostic: SettingsMigrationDiagnostic): string {
  const verb = diagnostic.code === "moved_property" ? "moved to" : "is deprecated; use";
  return `settings.${diagnostic.path} ${verb} settings.${diagnostic.replacement}`;
}
```

- [ ] **Step 5: Run the CLI suite**

Run: `pnpm --filter @lurkloot/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/settings.ts packages/cli/src/config.ts packages/cli/tests/settings.test.ts packages/cli/tests/config.test.ts
git commit -m "feat(cli): migrate config settings in memory and warn on deprecations"
```

---

### Task 6: Document how to add a migration

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add the section**

`docs/architecture.md` uses `##` for top-level sections. Insert this new section between the existing `## Settings Model` section (line 40) and `## Scheduler Flow` (line 54):

```markdown
## Settings Migrations

`packages/shared/src/settingsSchema.ts` is the only place legacy settings shapes
are transformed. Both hosts call `migrateSettings(raw)` on the raw persisted
payload and pass the result to normalization (`mergeSettings` in the extension,
`parseCliSettings` in the CLI). Migration and normalization are deliberately
separate: clamping and defaulting would erase the raw property information the
deprecation diagnostics depend on.

To add version N+1:

1. Increment `CURRENT_SETTINGS_SCHEMA_VERSION`.
2. Add exactly one pure `N` → `N+1` entry to `MIGRATIONS`. It receives a deep
   clone it owns outright, so it may mutate that object freely, but it must not
   reach outside it or log.
3. Emit a diagnostic for every deprecated or removed property it recognizes,
   with the full dotted path and the replacement path when one exists.
4. When an old and a current representation coexist, the current one wins and
   the deprecated one still produces a diagnostic.
5. Add fixtures to `packages/extension/tests/settingsMigrations.test.ts` for
   version N input, mixed old/current input, and the fully migrated output.
6. Update `defaultConfigJsonc()` in `packages/cli/src/config.ts` when public
   property names change.

Extension storage is upgraded automatically: `loadSettings` writes the canonical
envelope once when `changed` is true, under the settings lock. The CLI's JSONC
file is never rewritten, so its warnings repeat on every startup until the user
edits it.

Released migrations are never edited except to fix a data-loss defect. A later
semantic change gets a new version and a new migration.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: explain how to add a settings schema migration"
```

---

### Task 7: Full verification

- [ ] **Step 1: Confirm no legacy names survive outside the registry and tests**

Run: `grep -rn "watchQueue\|verboseLogging" packages/*/src packages/*/entrypoints`
Expected: matches only in `packages/shared/src/settingsSchema.ts`.

- [ ] **Step 2: Run the full verification**

Run: `pnpm verify`
Expected: PASS — script tests, workspace typechecks, both test suites, the Astro site build, and both browser builds.

- [ ] **Step 3: Commit any fixes and open the PR**

The PR body must link and close issue #179, show a before/after migration example, and call out explicitly that CLI config files are intentionally read-only.
