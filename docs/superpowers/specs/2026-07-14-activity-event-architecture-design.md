# Activity Event Architecture Design

## Purpose

The extension activity view must retain useful farming lifecycle records by default: farming started, farming stopped with a stable reason, successful reward claims, and actionable interruptions. Lower-level diagnostics remain opt-in in the extension. The CLI does not persist events and sends both activity and diagnostics through its existing leveled stderr logger so external systems such as Loki can own retention.

This refactor replaces the current hybrid design in which events are temporarily embedded in scheduler state, some producers use a process-global logger, and extension presentation depends on stored English messages.

## Event contract

Core exposes a closed, discriminated `EngineEvent` union. Every variant has a required `category`, `level`, and platform where applicable.

Activity variants have required stable codes and code-specific payloads:

- `farming_started`: campaign, reward, and optional channel identity.
- `farming_stopped`: campaign and reward identity plus a typed stop reason.
- `reward_claimed`: campaign and reward identity plus automatic or manual claim method.
- `interruption`: a typed reason and optional user-relevant context.

Diagnostics carry a level, message, optional platform, and optional diagnostic code/context. Free-form messages are diagnostic presentation, not the storage schema for normal activity.

Persistence metadata is separate from the engine event. The extension adds `id` and `at` when it stores an event. Legacy records with optional fields are accepted only by migration code and are not part of the live producer contract.

Selection reasons, continuing-session reasons, and farming-stop reasons are distinct types. A target change is classified from explicit campaign, reward, channel, eligibility, progress, and health transitions rather than inferred from display text or from a reward ID mismatch alone.

## Core event flow

`SchedulerState` contains operational farming state only. It has no event array and no rolling log limit.

Scheduler operations return ordered event batches alongside their next state and decisions. Controller-owned transitions add to the same operation-local batch. The controller publishes that batch through an injected, per-controller `EngineEventReporter` after operational state persistence succeeds. Event publication is best-effort: a reporter failure does not stop farming or roll back operational state.

Adapters, tab management, and tabless watchers receive a scoped reporter through their dependencies instead of calling a module-global `setActivityLogger`. This prevents one controller or test runtime from stealing another runtime's output and ensures every event follows the same host policy.

Unchanged periodic state emits no repeated decision diagnostics. Diagnostics describe actual inventory, target, status, retry, health, or error transitions. Browser-startup cleanup emits `farming_stopped` with `runtime_restart` before removing a previously active target.

Core has no history query, clear, pagination, IndexedDB, or popup-facing activity API. It only produces events.

## Extension storage and runtime routing

The extension background wrapper owns activity runtime messages. It publishes engine events into an IndexedDB repository and handles `getActivity` and `clearActivity` without routing those messages through the generic core controller.

The repository uses one event object store with category-aware compound indexes and independent retention passes. Activity is retained for 30 days with a 2,000-record cap. Diagnostics use a shorter seven-day retention and their own 2,000-record cap. Diagnostic volume therefore cannot evict activity.

Pruning is deterministic and does not count records before expiry deletions complete. Expired records are excluded on read even when no later append triggers maintenance. Pruning is amortized rather than running after every individual append.

Ordering and pagination use a stable compound cursor containing timestamp and ID. The repository returns an opaque cursor rather than a timestamp-only `before` value, so records created in the same millisecond cannot be skipped. Closing a database because of `versionchange` clears the cached connection, and failed opens remain retryable.

The popup requests activity records by category by default. Enabling the diagnostic display triggers a separate diagnostic query/stream; hidden diagnostics cannot consume the activity page or inflate its error count. Pagination is exposed through a load-more action. Clear-history uses an inline two-click confirmation in the activity view and clears both categories.

## Migration

Legacy `SchedulerState.events` records are imported from browser storage into IndexedDB once. The browser-storage source is removed only after the IndexedDB transaction commits. If import fails, operational state still loads, but the legacy source remains available for a later retry.

Legacy unstructured records render through their stored message as a fallback. Newly created activity records render from code and payload only.

## Localization and presentation

The popup maps each activity code and typed payload to localized catalog messages. Stored history therefore follows the user's current language and can adopt revised wording without rewriting IndexedDB records. Diagnostics and migrated legacy records continue to display their free-form message.

## CLI behavior

The CLI injects an event reporter that writes directly through its existing logger in causal order. It never stores events in `state.json`; no defensive event scrubbing is necessary once `SchedulerState` no longer contains them.

Existing CLI configurations containing `enabledLogLevels` remain loadable but emit one actionable deprecation warning per process telling the user to use `--log`; the legacy value does not alter the logger threshold. `diagnosticLogging` is rejected as extension-only. The process logger remains the sole runtime output filter, and Docker, systemd, Loki, or another external collector owns persistence and retention.

## Failure handling

- Operational state persistence occurs before best-effort event publication.
- IndexedDB failures do not stop farming and do not erase unimported legacy history.
- Controller-fatal failures emit an always-on interruption when enough context exists, plus an optional diagnostic containing technical detail.
- Reporter failures are isolated per published batch and do not reinsert events into scheduler state.
- Unknown legacy activity codes render their stored message; unknown live activity codes are compile-time errors.

## Testing and verification

Tests cover:

- Exhaustive activity variants and required payloads.
- Ordered event batches that are absent from scheduler state.
- No repeated diagnostics during an unchanged healthy tick.
- Startup `runtime_restart` stop emission.
- Correct stop classification for completion, eligibility, target, channel, and health transitions.
- Isolation between multiple controller reporters.
- IndexedDB append, category queries, compound pagination, retention caps, expiry, pruning order, connection recovery, clearing, and failure handling using `fake-indexeddb` or an equivalent deterministic test implementation.
- Legacy migration success and retry after failure.
- Popup localization, category-specific loading, error counts, load-more, and clearing.
- CLI causal ordering, logger thresholds, legacy configuration behavior, and log-free state files.

Root `check` and `verify` run CLI tests in addition to extension tests, workspace typechecks, the site build, and both extension browser builds.

## Non-goals

- The CLI will not gain an event database or log-file persistence.
- The core package will not depend on browser APIs, IndexedDB, WXT, React, or extension runtime messages.
- This work will not add remote telemetry, credential storage, cookie export, or platform-detection bypasses.
- This work will not introduce a general-purpose application event bus beyond the scoped reporter needed by the farming engine.
