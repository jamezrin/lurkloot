# Versioned Settings Migration Design

## Context

LurkLoot currently normalizes persisted settings through `mergeSettings` and
`mergeEngineSettings`. Historical property names are handled as inline
fallbacks, while each host separately decides whether and how to persist a
normalized result. PR #177 adds another compatibility bridge for the Watch
Queue to Idle Watchlist rename.

That approach is safe for an individual rename but does not provide an ordered,
auditable migration history. A future migration currently requires coordinated
special cases in shared normalization, extension storage, CLI validation, and
host-specific warning or persistence code.

This work will be implemented separately from PR #177. The rename PR remains a
focused compatibility change; the migration PR will convert its aliases into
the first explicit schema migration.

## Goals

- Give extension and CLI settings one authoritative, versioned migration path.
- Keep migrations pure, ordered, deterministic, and independently testable.
- Preserve the same canonical settings semantics across every host.
- Automatically persist migrated browser-managed extension settings.
- Never rewrite the user's CLI JSONC file.
- Warn CLI users about deprecated properties on every startup until they edit
  their configuration.
- Refuse unknown future schema versions without overwriting their data.
- Make adding the next migration a local, documented operation.

## Non-goals

- Rewriting, reformatting, or backing up CLI configuration files.
- Migrating CLI-only top-level properties such as `transport` or `authDir` in
  the initial implementation.
- Changing setting defaults or runtime farming behavior.
- Providing a standalone migration command.
- Removing support for unversioned settings.

## Architecture

### Shared migration authority

`@lurkloot/shared` will expose a settings schema module containing:

- `CURRENT_SETTINGS_SCHEMA_VERSION`, an integer incremented for every semantic
  settings-shape migration.
- A stored settings document containing `schemaVersion` alongside the persisted
  settings properties. The reserved metadata property is removed before
  producing runtime `EngineSettings` or `ExtensionSettings` values.
- An ordered registry in which migration N accepts the raw payload for version
  N and returns the raw payload for version N+1.
- `migrateSettings(raw)`, which detects the source version, applies every
  required migration, and returns a structured result.

The result will include the migrated raw payload, `fromVersion`, `toVersion`, a
`changed` flag, and structured diagnostics. Diagnostics identify a stable code,
the deprecated property path, its replacement when one exists, and a
human-readable message. Hosts format or route diagnostics; migration functions
do not log.

Unversioned input is version 0. Version 0 represents every supported historical
shape that predates the migration framework. The first migration consolidates
existing legacy behavior, including the Idle Watchlist aliases introduced by
PR #177. When both deprecated and current properties exist, the current
property wins and the deprecated property still produces a diagnostic.

Migration and normalization remain separate phases:

1. Read `schemaVersion` from the stored document or classify an unversioned
   object as version 0.
2. Apply ordered raw-shape migrations.
3. Normalize and validate the current payload into canonical runtime settings.
4. Return canonical storage data and diagnostics to the host.

This separation prevents defaulting or clamping from accidentally hiding the
raw property information needed to issue accurate deprecation warnings.

### Version safety

Versions must be non-negative integers. A version greater than
`CURRENT_SETTINGS_SCHEMA_VERSION` produces a typed unsupported-version error.
Neither host may normalize, save, or otherwise replace settings after this
error. Missing intermediate migrations are programmer errors covered by tests
and fail before any write.

Every migration must be pure and must not mutate its input. Running the complete
pipeline on current canonical storage is a no-op. A migration may be retried
after an interrupted or failed write without changing the result.

## Host behavior

### Extension

Extension `loadSettings`, `saveSettings`, and reset operations will share one
serialized settings-storage authority. Loading will read, migrate, normalize,
and, only when necessary, persist the current envelope while holding that
authority. Ordinary saves always write a current-version settings document.
This prevents a
migration write from overwriting a newer concurrent save.

If migration succeeds in memory but its write-back fails, startup continues
with the canonical settings and the migration is retried on the next load. If
the stored schema version is from the future, loading fails explicitly and does
not write. Reset remains an intentional user action and writes current defaults.

Extension diagnostics are not shown to users in the initial implementation
because browser storage is upgraded automatically. They remain available for
tests and diagnostic logging.

### CLI

CLI `loadConfig` will parse JSONC exactly as it does today, pass `settings` to
the shared migration pipeline, and use the canonical result in memory. It will
not modify the configuration file.

Every deprecation diagnostic becomes an actionable warning on every startup
until the source file is edited. Warnings name the complete deprecated path and
replacement, for example:

`settings.watchQueueFallbackOnly is deprecated; use settings.idleWatchlistFallbackOnly`

Unknown properties that have never been declared migration aliases remain
validation errors. Deprecated aliases are accepted only through registered
migrations, eliminating duplicate legacy-key allowlists in CLI parsing.

Because the CLI file is not rewritten, its settings object may remain
unversioned indefinitely. It will continue to enter at version 0 and receive
the same deterministic warnings. An optional `settings.schemaVersion` can avoid
replaying earlier migrations for manually updated configs, and the default
generated JSONC will include the current version so new files begin in the
current schema. The metadata property is accepted only at the root of the
`settings` object and is not part of `CliSettings`.

## Adding a migration

A contributor adding version N+1 must:

1. Increment `CURRENT_SETTINGS_SCHEMA_VERSION`.
2. Add exactly one pure N-to-N+1 migration to the registry.
3. Define diagnostics for every deprecated or removed property it recognizes.
4. Preserve current-property precedence when old and new representations
   coexist, unless the migration specification explicitly says otherwise.
5. Add fixtures for version N, mixed old/current input, and the fully migrated
   output.
6. Update the generated CLI config template when its public property names
   change.

Migrations are never edited after release except to fix a data-loss defect.
Later semantic changes receive a new version and migration.

## Testing

Shared tests will cover:

- every historical-version fixture upgrading to the current canonical shape;
- sequential application across more than one migration;
- unversioned input as version 0;
- current-property precedence over deprecated aliases;
- stable and deduplicated diagnostics;
- idempotence and input immutability;
- current-version no-op behavior;
- invalid, missing-step, and future-version failures.

Extension tests will cover:

- one-time canonical write-back;
- no write for current storage;
- failed write-back returning usable settings and retrying later;
- concurrent load/save ordering without lost updates;
- future-version rejection without writes;
- reset and ordinary saves emitting the current-version settings document.

CLI tests will cover:

- in-memory migration without changing file bytes or timestamps;
- warnings on every independent load while deprecated properties remain;
- full deprecated and replacement property paths in warnings;
- current config loading without migration warnings;
- deprecated aliases accepted while unrelated unknown keys still fail;
- future-version rejection.

The implementation must pass `pnpm verify`.

## Delivery boundary

This design will be tracked by a dedicated GitHub issue and implemented from
`origin/develop` in `refactor/settings-schema-migrations`. PR #177 remains
unchanged except that the follow-up issue may reference it as the source of the
Idle Watchlist migration case. The implementation PR will link and close the
new issue, include migration examples in its summary, and call out that CLI
files are intentionally read-only.

## Acceptance criteria

- A single shared ordered migration registry is the only place where legacy
  settings shapes are transformed.
- Extension and CLI consume the same migration result before host-specific
  normalization or use.
- Extension storage is upgraded automatically and safely under serialized
  writes.
- CLI JSONC is never rewritten and emits actionable deprecation warnings on
  every startup while deprecated properties remain.
- Current names win over legacy aliases without data loss.
- Unknown future versions fail without persistence.
- Existing inline Watch Queue/Idle Watchlist and other settings migration
  fallbacks are represented by the versioned mechanism rather than scattered
  host-specific checks.
- Documentation explains how to add a migration.
- `pnpm verify` passes.
