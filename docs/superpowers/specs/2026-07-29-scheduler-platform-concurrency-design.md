# Scheduler Platform Concurrency Design

## Summary

Twitch and Kick scheduler work currently shares three serialization points:

1. `runSchedulerTick` loops over both platforms in one invocation.
2. `createBackgroundController` holds one process-global state lock across
   load, network and tab work, and persistence.
3. `tabs.ts` mirrors persisted page-context and breaker state through
   whole-state module registries.

As a result, slow Twitch discovery, integrity acquisition, or tab work delays
Kick even though the two platforms have no operational dependency.

This change makes every multi-platform refresh fan out into independent
per-platform operations, regardless of whether it was triggered by an alarm,
startup, installation, settings, or a manual action. It also replaces the
single scheduler alarm with platform-specific Twitch and Kick alarms.

## Goals

- Twitch network and tab work never blocks Kick network and tab work, and vice
  versa.
- All triggers that target both platforms start both platform operations
  independently.
- Same-platform operations remain ordered so telemetry, tab removal, auth
  changes, heartbeats, and scheduler work cannot overwrite one another.
- Concurrent platform completions merge into the existing persisted
  `SchedulerState` blob without lost updates.
- A failure on one platform is reported and persisted without cancelling or
  rolling back the other platform.
- Upgraded installations remove the legacy `lurkloot.tick` alarm.
- The extension and CLI continue to share the same controller and state model.

## Non-goals

- Splitting `SchedulerState` into separate storage keys or files.
- Giving Twitch and Kick separate polling interval settings.
- Parallelizing operations within one platform.
- Changing campaign selection, claiming, heartbeat cadence, or farming
  eligibility.
- Adding credentials, cookies, or permissions.

## Chosen Approach

Each platform operation owns one platform slice of scheduler state. Long work
runs under a per-platform operation queue, while persistence uses a separate,
short commit queue:

1. Acquire the target platform's operation queue.
2. Load settings and the latest state.
3. Run auth preparation and one single-platform scheduler tick outside the
   persistence queue.
4. Acquire the commit queue only long enough to reload the latest persisted
   state, merge the completed platform slice, and save.
5. Release the commit queue, then finish reporting and any platform-scoped
   handoff work.

The commit queue is not an execution lock. It protects only the physical
read-modify-write of the one storage blob. Slow discovery, integrity proof of
work, page-context waits, tab operations, notifications, and watcher
reconciliation never run inside it.

This preserves the current storage format while preventing stale full-state
saves. Splitting storage would provide stronger physical isolation but would
require a migration and wider host API changes. Optimistic revision retries
were rejected because browser storage does not provide an atomic
compare-and-swap primitive.

## State Ownership and Merging

Introduce explicit helpers that copy or merge the fields owned by one
`Platform`:

- `sessions[platform]`
- `authHealth[platform]`
- `criticalHealth[platform]`
- `managedWatchTabs[platform]`
- `managedPageContextTabs[platform]`
- `manualWatch[platform]`
- `manualClosePause[platform]`
- `gamification[platform]`
- `campaigns[platform]`
- `deadlineInfeasibleRewardIds[platform]`

Optional records must support both setting and deleting their platform entry.
The merge helper must preserve the other platform and every global field from
the freshly reloaded destination state.

`installedAt` remains globally owned. `lastTickAt` remains a compatibility
field and is updated to the newest successfully committed platform completion
time. It is not used as a lock or platform freshness boundary.

Handlers that mutate exactly one platform use that platform's operation queue
and commit through the same slice merge. Whole-host operations such as factory
reset acquire both platform queues in stable Twitch-then-Kick order before
replacing global state. Stable ordering prevents deadlocks.

Settings retain their existing settings mutation queue because settings are a
separate persisted object. A settings change may dispatch independent
platform ticks after its settings write completes.

## Scheduler Execution

`runSchedulerTick` becomes a single-platform operation. Its public input
identifies one `platform`, and its result contains the updated full working
snapshot plus decisions and events for that platform only. Keeping a full
working snapshot minimizes churn inside scheduler logic; only the explicit
platform slice is allowed through the persistence boundary.

Controller methods accepting `Platform[] | undefined` normalize the target
list and fan out one operation per platform. Multi-platform calls use settled
aggregation:

- both operations begin without waiting for the other;
- each operation owns its own event collector and claimed-reward result;
- one rejection does not cancel its sibling;
- after both settle, failures are reported with platform context;
- callers receive the union of successful per-platform claimed reward IDs.

Twitch integrity preparation and auth refresh move inside the Twitch operation.
Kick auth refresh runs independently. A Twitch integrity timeout or setup
failure therefore excludes only Twitch and cannot delay Kick.

Same-platform preemption introduced by issue #299 is retained. Aborting a
Twitch tick does not abort Kick. Controller shutdown and host reset abort both.

## Side Registries

Whole-state mirror functions in `tabs.ts` become platform-scoped:

- retained managed page contexts are registered, read, or cleared by platform;
- managed-tab breaker synchronization updates only the requested platform;
- an in-flight page-context entry is associated with its platform rather than
  relying only on the origin key.

The in-flight page-context registry may still deduplicate requests for the same
platform origin, but a Twitch registration cannot clear or replace Kick state.
Kick registration cannot touch Twitch integrity state. Twitch integrity remains
an explicitly Twitch-owned registry and lifecycle.

Whole-registry reset helpers remain available only for controller shutdown,
test cleanup, and factory reset after both platform queues have been acquired.

## Alarm Model

Define:

- `TWITCH_ALARM_NAME = "lurkloot.tick.twitch"`
- `KICK_ALARM_NAME = "lurkloot.tick.kick"`
- legacy `ALARM_NAME = "lurkloot.tick"` only for upgrade cleanup

`ensureAlarm`, installation setup, startup setup, and poll-interval changes
create both platform alarms with the existing `pollIntervalMinutes`. They also
clear the legacy alarm. Alarm creation is independent of whether a platform is
currently enabled, matching the existing periodic reconciliation behavior;
the scoped tick exits cheaply when its platform is disabled.

The alarm listener routes each name to
`tickAndHandOff([platform], "alarm")`. Watch-heartbeat and Twitch-integrity
alarms keep their current names and behavior.

Startup, installation, manual refresh, settings changes, platform toggles, and
critical-failure dismissal continue using their current target selection, but
any target list containing both platforms fans out concurrently.

## Events, Notifications, and Failures

Each platform operation collects and persists its own events. Lifecycle
comparison, notification generation, ad focus, tabless watcher reconciliation,
critical-health transitions, and claimed-reward observation use the
single-platform before/after snapshots.

If scheduler work fails:

- its partial platform slice is discarded;
- partial claim IDs are discarded;
- operational activity from the failed attempt is cleared;
- a platform-scoped interruption and English diagnostic are persisted;
- the sibling platform continues and may commit successfully.

If the short commit itself fails, the platform operation reports the storage
failure through the existing caller path. The commit queue remains usable for
later operations.

Post-claim handoffs remain one per platform. Handoffs spawned by concurrently
successful ticks may run concurrently with one another but remain serialized
against other work for their own platform.

## Testing

Focused deterministic tests will cover:

1. Deferred Twitch discovery does not prevent Kick discovery or completion.
2. Deferred Kick discovery does not prevent Twitch completion.
3. A Twitch failure persists a Twitch interruption while Kick state commits.
4. Concurrent platform commits preserve both slices and unrelated global
   fields.
5. Same-platform telemetry, tab removal, heartbeat, auth, and tick mutations
   remain ordered without lost updates.
6. A scoped page-context or breaker synchronization leaves the sibling
   platform registry unchanged.
7. A Kick tick cannot replace or clear Twitch integrity.
8. Both platform alarms are created with the configured interval.
9. The legacy alarm is cleared during initialization and interval changes.
10. Each alarm routes only its platform.
11. Startup and manual all-platform triggers overlap both platform operations.
12. Post-claim handoffs still receive claimed IDs from concurrent successful
    ticks.
13. Controller shutdown and factory reset safely abort or drain both platform
    queues.

The implementation will run focused Vitest files during development, followed
by `pnpm typecheck`, `pnpm test`, and the repository's broader verification
appropriate to the final change.

## Rollout and Compatibility

No persisted-state migration is required. Existing `SchedulerState` values
remain valid. On first initialization after upgrade, the controller clears the
legacy combined alarm and creates the two scoped alarms. Repeating this setup is
idempotent.

The CLI has no browser alarm host, but its default all-platform run uses the
same concurrent fan-out. Public controller methods retain platform-list inputs
where practical so existing extension and CLI call sites need only alarm-name
updates.
