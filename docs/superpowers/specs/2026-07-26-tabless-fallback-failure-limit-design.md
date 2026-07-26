# Configurable Tabless Fallback Failure Limit

## Context

Tabless farming currently falls back to a watch tab after
`offlineRetryLimit` consecutive heartbeat failures. That setting is intended to
decide when a channel is offline, so using it for tabless transport reliability
couples two unrelated policies. A transient heartbeat failure can therefore
open a sticky watch tab earlier than the user wants.

Client-Integrity capture is a separate page-context mechanism. When Twitch has
no valid integrity token, an authenticated mutation cannot succeed until a
Twitch page mints one. That path must continue opening or reusing a Twitch tab
on the first token miss.

## Goals

- Give tabless fallback its own persisted, user-configurable threshold.
- Default to five consecutive failures and accept values from one through ten.
- Keep channel-offline detection controlled exclusively by
  `offlineRetryLimit`.
- Preserve immediate Client-Integrity page-context acquisition.
- Cover engine behavior, settings normalization and UI exposure with
  deterministic tests.

## Non-goals

- Changing heartbeat cadence or health semantics.
- Changing when a channel is considered offline.
- Retrying or otherwise altering Client-Integrity token capture.
- Adding a settings migration for existing users.
- Generalizing all scheduler retry limits behind a new policy abstraction.

## Settings Contract

Add `tablessFallbackFailureLimit: number` to `EngineSettings`, because both the
extension and CLI-hosted engine use tabless watchers. Add it to
`DEFAULT_ENGINE_SETTINGS` with a value of `5`.

`mergeEngineSettings` clamps the setting to an integer from `1` through `10`,
using the default when the stored value is missing or invalid. Existing stored
settings therefore gain the new value through the normal merge path without a
schema migration. The existing settings patch and persistence paths already
carry scalar engine fields, so no special persistence logic is required.

## Runtime Behavior

The setting replaces `offlineRetryLimit` at both tabless fallback decision
points:

1. `runWatchHeartbeat` increments consecutive failed heartbeat checks and
   requests a scheduler tick once the new threshold is reached.
2. `chooseTablessWatch` uses the same threshold to decide that the tick must
   select a watch tab for the current channel.

Using the same value at both points keeps the trigger and scheduler decision
consistent. A successful heartbeat continues resetting the consecutive failure
count to zero. Once fallback occurs, the existing `tablessFallback` flag keeps
the session on its watch tab until the target changes.

All other reads of `offlineRetryLimit`, including channel-offline and playback
health checks, remain unchanged. Comments in shared models, the scheduler, and
the controller will name the new setting where they describe tabless fallback.

## Popup UI and Localization

Add a `NumberSettingRow` to the existing Advanced settings group:

- title: “Tabless fallback threshold”
- description: explain that this is the number of consecutive failed watch
  signals allowed before opening a video tab
- value: `settings.tablessFallbackFailureLimit`
- minimum/maximum: `1` and `10`
- suffix: localized “failures”
- disabled while tabless mode is off, with a localized reason
- save through `onSettingsChange` with `tickAfterSave: true`, so lowering the
  threshold can take effect against an already unhealthy tabless session

Add the title, description, suffix, and disabled-reason message keys to every
catalog in `packages/locales/messages/`, preserving catalog key parity. The
entry also participates in the settings registry and search like the existing
advanced numeric settings.

## Client-Integrity Exception

Do not change `ensureTwitchIntegrityWithBrowser` or route it through tabless
fallback policy. It remains an immediate call to acquire a Twitch page-context
tab when no valid token exists.

Add an explicit regression test that starts without a valid token or existing
Twitch tab and asserts `browser.tabs.create` is called immediately on the first
invocation. The test documents that no heartbeat or settings retry budget gates
this acquisition.

## Testing

Add or update focused tests for:

- defaulting missing `tablessFallbackFailureLimit` to `5`
- clamping low, high, fractional, and invalid values to the `1`–`10` integer
  contract
- preserving the value through the existing settings save/load path
- remaining tabless below the configured threshold
- falling back exactly at the configured threshold
- honoring a non-default threshold independently of `offlineRetryLimit`
- triggering controller fallback according to the new setting
- rendering, searching, and changing the popup setting
- maintaining localization catalog parity
- opening the Client-Integrity page-context tab on the first missing-token
  invocation

Run targeted Vitest files during development, then `pnpm verify` before
completion.

## Risks and Mitigations

- **Mismatched thresholds:** update both the controller trigger and scheduler
  decision, with tests spanning both layers.
- **Accidental offline-policy change:** leave all non-tabless
  `offlineRetryLimit` reads intact and assert independence with non-default
  values.
- **Locale drift:** update every message catalog and rely on existing locale
  parity/type checks.
- **Integrity regression:** keep the implementation untouched and add a
  first-miss tab-creation regression test.
