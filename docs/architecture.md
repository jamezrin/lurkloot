# Architecture

Lurkloot is a WXT browser extension that farms Twitch and Kick drops through normal logged-in browser sessions. Visible muted tabs are the default watch path; optional tabless low-resource mode sends platform watch heartbeats and falls back to tabs when unhealthy. The extension avoids asking for credentials, exporting cookies, or bypassing platform page detection.

## Repository Layout

The repository is a pnpm workspace whose root `package.json` is a pure orchestrator (delegating `dev`/`build`/`test`/`typecheck`/`verify` scripts to packages via `pnpm --filter`). All code lives under `packages/`:

- `packages/extension` — the WXT extension shell (`entrypoints/`, browser-specific `src/`, `wxt.config.ts`, `public/`, `tests/`). Builds to `packages/extension/.output/{chrome-mv3,firefox-mv2}`.
- `packages/core` — the browser-free farming engine (`@lurkloot/core`): scheduler, background controller, platform adapters/parsers, tab/watch abstractions, tabless watch logic, and Twitch integrity helpers. It is consumed by both the extension and CLI.
- `packages/cli` — the headless Node/Docker runtime (`@lurkloot/cli`) with auth, config, storage, and HTTP/impersonation transports around `@lurkloot/core`.
- `packages/locales` — the localized message catalogs and async catalog loader (`@lurkloot/locales`), used by extension code and shared UI.
- `packages/popup-ui` — the shared React popup UI (`@lurkloot/popup-ui`), consumed by both the extension and the site.
- `packages/shared` — framework-agnostic models, messages, settings, i18n, and logging (`@lurkloot/shared`).
- `packages/site` — the Astro marketing/landing page, which imports the real popup UI for its demo.

Package-qualified paths below are written as `packages/<package>/...` when ownership matters. Bare extension paths such as `entrypoints/...` are relative to `packages/extension/`.

## Runtime Components

- `entrypoints/background.ts` registers extension lifecycle hooks, alarms, tab-removal handling, runtime message handling, and browser-specific adapters around `@lurkloot/core`.
- `packages/core/src/background/controller.ts` assembles the controller from its owner modules in the same directory, which coordinate settings/state persistence, scheduler ticks, popup messages, notifications, manual reward claims, and playback-control authorization.
- `packages/core/src/core/scheduler.ts` owns platform-independent campaign selection, Idle Watchlist fallback selection, auto-claiming, retry/backoff, session state, manual-watch pauses, and watch-mode lifecycle decisions.
- `packages/core/src/platforms/adapter.ts` defines the `PlatformAdapter` contract. `packages/core/src/platforms/twitch/index.ts` and `packages/core/src/platforms/kick/index.ts` implement platform-specific discovery, progress, candidate, validation, claim, and tab preparation behavior.
- `packages/core/src/core/tabs.ts` contains shared tab-management and page-context-fetch abstractions; `packages/extension/src/core/tabs.ts` binds those abstractions to live WXT/browser tab and cookie APIs.
- `entrypoints/twitch.content.ts` and `entrypoints/kick.content.ts` start shared playback telemetry/control on platform pages.
- `entrypoints/popup/` adapts WXT/browser APIs to the shared React popup UI in `packages/popup-ui`, which talks only to the background controller through runtime messages.

State and normalized settings are loaded and saved through `packages/extension/src/core/storage.ts` in the extension and through `packages/cli/src/storage.ts` in the CLI. The scheduler stores independent `WatchSession`, campaign, manual-watch, and managed-tab state for `twitch` and `kick`; diagnostics and activity events are emitted through the reporter outside `SchedulerState`. A short-lived Twitch Client-Integrity bundle is stored separately so claim mutations can replay page-issued Twitch headers while the token is valid.

### Scheduler admission

The shared controller reserves one active scheduler tick and at most one pending
follow-up per platform, before loading settings or beginning tick diagnostics.
Overlapping callers share the pending result promise. Twitch and Kick have
independent lanes; extension alarms and CLI intervals request each platform
separately. The CLI also shares result observers so repeated intervals cannot
accumulate reporting continuations behind the same pending tick.

Pending triggers merge by their existing selection semantics: `manual_tick`,
`manual_resume`, and `claim_handoff` force selection and bypass backoff; `startup`
forces selection without bypassing backoff. Other user actions, including
settings and automation toggles, retain their persisted mutations through fresh
settings/state loads. Ordinary alarms and discovery signals do not override a
higher-priority trigger. Equal-priority triggers retain the first reason, while
diagnostics count every merged reason. Valid discovery signals share an already
pending scheduler follow-up instead of requesting another cycle afterward.

Each executed follow-up reloads current settings/state and selects from the
latest committed discovery revision. Disablement discards obsolete pending work;
shutdown and host reset cancel it and abort active ticks. Reset also closes
admission until cleanup finishes. Discovery signal controller/generation checks
remain in force. Tick start/finish timing covers executed work only; separate
diagnostics report merged or discarded trigger counts. Heartbeat admission and
its fixed cadence remain independent of scheduler admission.

### Discovery work

The shared collector evaluates campaign farmability using the refresh's settings
and one timestamp before listing channels. Completed, expired, excluded,
infeasible and statically disallowed campaigns stay in the inventory with empty
channel observations. Claimable rewards and uncertain channel eligibility retain
their existing behavior. This gate uses the same evaluator as selection.

Kick checks eligible campaigns through an optional adapter batch contract. Three
workers process independent campaigns; each campaign checks candidates in order
and stops at its first valid channel. This avoids speculative requests after an
early match. Idle Watchlist checks are independent jobs and all remain observed.
Raw API/page responses are shared by URL only within that discovery revision;
each candidate retains its own campaign, ACL metadata and category expectation.
The next revision fetches fresh evidence. A single campaign's candidate chain
remains sequential, trading its latency for the existing early-match request
budget. Campaign and candidate result ordering never depends on completion order.

Missing Kick inventory/progress, malformed general-channel directories, missing
required category evidence, cancellation or failed checks do not replace the
last coherent snapshot. On failure, workers stop taking new work and drain active
requests before returning. The collector also drains paired inventory and
followed-channel operations. Strict Kick discovery awaits stale followed-cache
refreshes, including an existing refresh, before cycle-level fetch observation is
consumed. This adds the followed lookup's latency once per five-minute cache
expiry, while fresh-cache reads remain immediate. HTTP 429 never retries through a different
execution context. Discovery diagnostics report duration, inventory count,
campaigns skipped before channel work, candidate observations and unique channel
checks. Failed attempts without counters report that work metrics are unavailable
rather than reporting zero work. The attribution fields contain only counts;
strict missing-evidence failures use fixed messages. Both extension and CLI run
this collector and the same Kick adapter.

## Background controller ownership and concurrency

This section records how `createBackgroundController` (`packages/core/src/background/`) owns its
state and serializes its work **as of v1.14.0**. It is the baseline for the v1.15.0 refactor
(#583): each extraction issue updates the rows it moves, and #591 replaces this section with the
final module ownership.

### Module layout

#592 split the controller by owner without changing behavior. `controller.ts` keeps the public
exports and assembles the modules. Every function body moved unchanged, apart from state accesses,
which now read `<slice>.<field>`.

- `context.ts` defines the mutable state as one slice per owner. `createBackgroundController`
  creates each slice once and passes a module only the slices it uses. The discovery slice is the
  exception: `createDiscovery` builds it, because its lanes refresh through that module.
- `types.ts` declares `ControllerCalls`, every function one module calls in another (or that the
  controller returns). Each module's parameters pick the calls it makes, and its return type picks
  the calls it provides. Modules resolve their calls through `lateBound` once every module exists.
- `constants.ts`, `helpers.ts` and `errors.ts` hold the module-level values that more than one module uses.
  None of them imports a module, and the modules import no sibling except `stateTransaction.ts`
  (for its types and `isRankingOnlyPatch`), `platformState.ts`, and the tick's own helpers
  `tickEffects.ts` and `tickCommit.ts`, so there are no import cycles.
- `stateTransaction.ts` (#585) is the state transaction: it owns the settings, platform and commit
  locks, every settings and scheduler-state commit, and the after-commit hooks. It depends only on
  the storage ports, and `createBackgroundController` creates it before any module.
- `hostPorts.ts` and `jobs.ts` (#593) are the host contract: the grouped ports and declared
  capabilities every module takes instead of flat deps, and the job scheduler port with the job
  table. See "Host ports and jobs" below.
- `tickEffects.ts` and `tickCommit.ts` (#599) are the scheduler tick's effect executor with its
  interim handlers, and the tick's three-way commit. See "Scheduler tick effects" below.

The per-module slices and calls below are where #591's dependency check starts:

| Module | Slices | Calls into | Provides |
| --- | --- | --- | --- |
| `stateTransaction.ts` | its own lock queues and hooks | none | the transaction (#585) |
| `stateCommit.ts` | the transaction | `reporting` | 12 |
| `reporting.ts` | `reportingSlice` | `discovery` | 13 |
| `tickAdmission.ts` | `reportingSlice`, `integritySlice`, `signalSlice`, `tickSlice`, `lifecycleSlice` | `claims`, `discovery`, `discoverySignals`, `reporting`, `stateCommit`, `tickRun` | 11 |
| `tickRun.ts` | `claimSlice`, `discoverySlice`, `tickSlice`, `kickChallengeSlice`, `channelPointsSlice` (their claim guards) | `authHealth`, `channelPoints`, `discovery`, `discoverySignals`, `heartbeat`, `kickChallenges`, `manualWatch`, `reporting`, `stateCommit`, `tickAdmission`, `twitchIntegrity` | 1 |
| `discovery.ts` | its own `discoverySlice`, `lifecycleSlice` | `reporting`, `stateCommit` | 10 |
| `heartbeat.ts` | `heartbeatSlice`, `tickSlice`, `lifecycleSlice` | `discovery`, `reporting`, `stateCommit`, `tickAdmission` | 7 |
| `twitchIntegrity.ts` | `integritySlice`, `settingsSlice`, `lifecycleSlice` | `reporting`, `stateCommit` | 8 |
| `channelPoints.ts` | `channelPointsSlice`, `signalSlice`, `tickSlice`, `lifecycleSlice` | `reporting`, `stateCommit` | 7 |
| `kickChallenges.ts` | `kickChallengeSlice`, `lifecycleSlice` | `reporting`, `stateCommit` | 2 |
| `authHealth.ts` | `authSlice`, `discoverySlice` | `channelPoints`, `discovery`, `discoverySignals`, `reporting`, `stateCommit` | 5 |
| `manualWatch.ts` | none | `discovery`, `discoverySignals`, `reporting`, `stateCommit`, `tickAdmission` | 6 |
| `claims.ts` | `kickChallengeSlice`, `claimSlice`, `lifecycleSlice` | `heartbeat`, `lifecycle`, `reporting`, `stateCommit`, `tickAdmission` | 8 |
| `discoverySignals.ts` | `signalSlice`, `tickSlice`, `lifecycleSlice` | `reporting`, `tickAdmission` | 9 |
| `settingsTransitions.ts` | the transaction, `discoverySlice` | `channelPoints`, `claims`, `discovery`, `lifecycle`, `stateCommit`, `tickAdmission` | 2 |
| `lifecycle.ts` | `integritySlice`, `signalSlice`, `discoverySlice`, `tickSlice`, `settingsSlice`, `lifecycleSlice` | `authHealth`, `channelPoints`, `claims`, `discovery`, `discoverySignals`, `heartbeat`, `reporting`, `settingsTransitions`, `stateCommit`, `tickAdmission`, `twitchIntegrity` | 8 |
| `messages.ts` | `integritySlice`, `signalSlice`, `tickSlice`, `settingsSlice`, `lifecycleSlice` | `claims`, `discoverySignals`, `lifecycle`, `manualWatch`, `reporting`, `settingsTransitions`, `stateCommit`, `tickAdmission`, `twitchIntegrity` | 1 |

Slices read outside their owner are the coupling the later issues remove: `lifecycleSlice`
(`controllerShutdown`) in nine modules, `tickSlice` in seven, `discoverySlice` in five.
`campaignEvaluationFingerprints` sits in `tickSlice` because only a tick reads it.

The characterization suite is split the same way, into `packages/extension/tests/backgroundController/<owner>.test.ts`,
with shared fixtures in `tests/helpers/backgroundController.ts`. Every test keeps its full name.

### State ownership

Everything below is created once per controller instance. "In memory" means it is lost on an MV3
service-worker restart or a CLI process restart. "Persisted" means it is part of `SchedulerState`
or settings, loaded and saved through the host's storage port (`storage.local` on the extension,
`state.json` on the CLI).

| State group | Where it lives | Written by | Invalidated by | Commit boundary | Restart | Hosts |
| --- | --- | --- | --- | --- | --- | --- |
| Scheduler state (`sessions`, `authHealth`, `campaigns`, `criticalHealth`, backoffs, `lastTickAt`) | Persisted | Ticks, heartbeats, auth, claims, message handlers | Newer commits for the same platform | The transaction's `commit` / `commitPlatformSnapshot`, merged per platform by `mergePlatformState` (derived from `SCHEDULER_STATE_MERGE`) | Reloaded. `reconcileStartup` runs `staleStartupCleanup` on both hosts | Both |
| Discovery lanes (`discoveryLanes`, `discoveryEvents`) | In memory, one `DiscoverySnapshotLane` per platform | `refreshDiscovery` | Settings saves that are not ranking-only, auth invalidation, `refreshDiscovery` itself, reset and shutdown | None: a snapshot is published by revision, not stored | Rediscovered on the first tick | Both |
| Selection (`selectionCache`, `selectionRuns`, `pendingSelections`, `selectionGeneration`) | In memory | `prepareSelection` | `invalidateSelection`: every settings save (including ranking-only), auth invalidation, heartbeat results, playback telemetry, reset, shutdown | Consumed inside `runTick`'s platform lock | Recomputed | Both |
| Tick admission (`tickAdmission`, `activeTicks`, `tickBatches`, `backgroundWork`) | In memory | `tick`, `tickInBackground`, `tickAndHandOff` | Disable, reset, shutdown | None | Empty | Both. Extension alarms and CLI intervals request ticks per platform |
| Heartbeat lanes, watchers and publication leases (`heartbeatLanes`, `tablessWatchers`) | In memory, with the heartbeat cadence persisted in the session | `requestPlatformHeartbeat`, `reconcileTablessWatchers`, `commitHeartbeatResult` | Session changes, `clearHeartbeatOwnership`, shutdown | `withHeartbeatLane`, then a transaction commit **without** the platform lock | `reconcileStartup` releases ownership on both hosts | Both |
| Discovery-signal controllers (`discoverySignalControllers`, `discoverySignalLifecycleOpen`) | In memory | `reconcileDiscoverySignalControllers` (from `runTick`) | Auth transitions, tab removal, settings, reset, shutdown | None | Recreated by the next tick | Both, when the adapter provides a factory |
| Auth health (`authHealth`, `authRefreshGeneration`) | Health persisted, generations in memory | `probeAuthHealth`, `refreshAuthHealth`, `persistAuthHealth`, `invalidateAuthHealth` | A newer refresh generation | `persistAuthHealth` under the platform lock, then a transaction commit | Health reloaded, then re-probed | Both. Credentials come from cookies (extension) or the credential store (CLI) |
| Manual watch (`manualWatch`, `manualWatchTabs`, `manualClosePause`, playback telemetry) | Persisted | `recordPlaybackTelemetry`, `handleTabUpdated`, `handleTabRemoved`, `resumeAfterManualClose` | Tab events, resume, TTL | Platform lock | Reloaded | Extension only; the CLI has no tabs |
| Settings (`twitchSettingsTransitionGeneration`) | Settings persisted, transition generation in memory | `commitSettings` (every popup write, `updateIdleWatchlist`), `normalizeStartupSettings` | Each settings commit. Its per-platform effect decides: `selection` (ranking-only, `isRankingOnlyPatch`) keeps discovery, `discovery` invalidates both | The transaction's settings lock | Reloaded and migrated (schema v7) | Both. The CLI's `saveSettings` is a no-op |
| Page contexts and Kick recovery evidence | `core/tabs.ts` module globals, mirrored in persisted `managedPageContextTabs`. Recovery evidence in the extension host (`kickPageContextRecovery`) | The tick's `releasePageContexts` effect, `registerManagedPageContextTabs`, host fetch fallbacks | Release, reset, restart without auto-start | Copied into `SchedulerState` by the tick driver (`runSchedulerTickEffects`), never by the deciding code | Re-registered at startup when farming auto-starts | Extension only |
| Claim operations (`dropClaimOperations`, `waitingClaimRewardIds`, `claimHandoffs`, `kickChallengeClaimOperations`, `twitchChannelPointsClaimInFlight`, channel-points push) and claim guards (`rewardClaimGuards`, `kickChallengeClaimRunning`, `twitchChannelPointsClaim`) | In memory. Claimed rewards are persisted through `campaigns` | Ticks, claim jobs, `claimRewardNow`, `runClaimHandoff`, the push | Disable, auth loss, reset, shutdown, `abortClaimHandoffs` at startup | Platform lock for the jobs; the tick claims with no lock and commits after (#599). The guards keep one request per reward, one Kick challenge claim and one channel-points claim in flight across every path | In-flight work is lost; provider inventory is re-read | Both, but manual-watch claim jobs never fire on the CLI |
| Twitch integrity (`installedTwitchIntegrity`, `persistedIntegrityToken`, `integrityLifecycleGeneration`) | In memory in the controller and in `core/tabs.ts` globals; the token is also persisted through `saveTwitchIntegrity` | Header capture, refresh, enable/disable transitions | A newer lifecycle generation | Settings lock, then the platform lock | Token reloaded from storage | Extension only |
| Compatibility reporting (`reportedCompatibility`, route reports) and `campaignEvaluationFingerprints` | In memory | Adapter construction, ticks | Never, within a process | None | Reported again | Both |
| Host jobs | The job scheduler port: `browser.alarms` (extension), Node timers (CLI) | `ensureCadenceJobs`, `rescheduleTickJobs`, `reconcile*Alarm`, integrity scheduling | Settings changes, disable | Settings lock, except the tick jobs (rescheduled after it) | Alarms survive a service-worker restart; the CLI re-ensures its cadence jobs on start | Both; jobs whose capability a host lacks are inert (#593) |
| Twitch Extensions host (`generation`, `knownComplete`, `completedUntil`, `unavailableUntil`, summaries) | In memory in `packages/extension/src/extensions/host.ts` | The host's reconcile loop | `storage.onChanged` diffs of settings and scheduler state, every alarm | Outside the controller | Forgotten; providers are re-probed | Extension only |

### Locks and queues

All of these are promise chains: `run = previous.then(operation, operation)`.

| Lock | Protects | Notes |
| --- | --- | --- |
| `withSettingsLock` | Settings read-modify-write | Also reschedules jobs while held (see below) |
| `withStateLock(operation, platforms)` / `withPlatformLock` | One platform's scheduler state and in-memory lifecycle | Takes each requested platform in the fixed order Twitch → Kick |
| Commit lock (inside `commit`, `commitPlatformSnapshot`, `readState`) | The global load → merge → save of `SchedulerState` | Private to the transaction; only a storage load and save run under it |
| `withHeartbeatLane(platform)` | One platform's watcher, heartbeat reservations and publication leases | Independent of the platform lock |
| `withTwitchIntegrityAlarmLock` | Creating and clearing the integrity refresh alarm | Taken inside the settings and platform locks |
| Discovery lanes | One refresh per platform, with a coalesced follow-up | Not a lock on state |

Nested acquisition orders found in the code, and none in the reverse direction:
- settings → platform: `runTwitchIntegrityRefresh`, `prepareForHostReset`
- settings → commit: each discovery refresh reads settings and state together (`createDiscoveryLane`)
- platform → commit: `persistPlatformState` and `persistAuthHealth` under `withStateLock`
- platform → heartbeat lane → commit: `runTick` → `reconcileTablessWatchers`, and heartbeat result commits
- platform → heartbeat lane: `runTick` → `reconcileTablessWatchers`
- settings or platform → integrity alarm lock

Heartbeat results commit through the transaction without the platform lock. That is what keeps a
due heartbeat independent of a long tick.

### Work performed while a lock is held

These are the v1.15.0 targets. The authoritative list is
`packages/extension/tests/helpers/lockedIo.ts` (`LOCKED_IO_ALLOWLIST`), with the issue that removes
each entry. `lockedIoAllowlist.test.ts` fails if a provider, tab or timer call appears inside a lock
without being listed, or if a listed call has left its lock without the entry being deleted.

- **Scheduler tick:** none since #599. Its effects (claims, Kick challenges, channel points, watch
  tabs, page-context release, Twitch Extensions supplemental selection) run between `runTick`'s two
  platform-lock sections, with no lock held. See "Scheduler tick effects" below.
- **`runTick` itself**, before and after the tick: the fallback `prepareSelection`, which can wait on
  another tick's selection run (#587), and, before publishing, tabless watcher reconciliation (#586),
  discovery-signal and channel-points push reconciliation (#587, #590) and ad focus (#587).
- **Heartbeat lane:** `watcher.start` (#586).
- **Auth transitions** stop the discovery-signal observer and the channel-points push directly
  (#595).
- **Tab events and playback:** stopping discovery signals on tab removal, ad focus on telemetry
  (#596).
- **Host reset** closes watch tabs and page contexts under the settings and platform locks (#598).
- **Claims outside the tick:** `claimRewardNow`, `runDropClaims` (which also refreshes campaigns) and
  `runKickChallengeClaims` (#597, #588).
- **Timers under the settings or platform lock:** integrity refresh scheduling (#589), claim and
  channel-points alarms on settings writes and at startup (#597, #590). The tick jobs are
  rescheduled after the settings lock is released (#593).

Event reporting (`reportBestEffort`, `persistAndReport`) and notifications still run inside the
platform locks, but only after the commit that carries them has been accepted (see below).

### Commits, locks and publication (#585)

`stateTransaction.ts` is the one owner of storage writes. The controller modules commit through it
and never take the commit lock or call `saveState` themselves.

- **Lock order:** settings → Twitch → Kick → heartbeat lane → commit. Acquire in this order only.
  Only a storage load and save run under the commit lock; no lock may be held across provider, tab or
  timer I/O except at the call sites listed in `LOCKED_IO_ALLOWLIST`.
- **Commit:** `commit(platforms, guard, mutate)` loads the stored state, checks the guard, applies
  the synchronous `mutate`, and returns `accepted`, `unchanged` (nothing to write, or an equivalent
  state) or `stale`. The guard is the operation's expected generation, as an `AbortSignal` or a
  predicate, so an aborted operation is stale. `commitPlatformSnapshot` merges one platform's part of
  a snapshot the same way, keeping the live page-context registry and a still-current heartbeat
  cadence; `persistPlatformState` and `persistPlatformAndReport` are built on it.
- **Per-platform merge:** `SCHEDULER_STATE_MERGE` (`platformState.ts`) classifies every
  `SchedulerState` key as `platform`, `optionalPlatform`, `newestTimestamp` or `global`, and
  `mergePlatformState` is derived from it. A new key does not compile until it is classified.
- **Things that already happened (#599):** a claim or a tab change is recorded even after its
  operation was superseded. A watch decision commits only while its selection is current and nothing
  it depended on changed; see "Scheduler tick effects".
- **Settings:** every write is `commitSettings(update)`. `update` computes the patch from the
  settings read once inside the settings lock, and the result carries each touched platform's effect:
  `discovery` or `selection`. Discovery-lane and selection invalidation follow the effect, anything
  unclassified counts as `discovery`, and `saveSettings` and `updateIdleWatchlist` pick their tick
  trigger from it (`settingsTickTrigger`).
- **Publication:** operational activity and notifications are collected with the operation and
  reported only once its commit is accepted or found already stored. A stale commit, a storage failure
  or a cancelled operation publishes none of it (`backgroundController/reporting.test.ts`,
  `claims.test.ts`). Kick transport diagnostics (`kick_fetch_route`, `kick_fetch_summary`,
  `kick_fetch_lifecycle_failed`) are the documented exception: `routeDiagnosticEmitter` reports them
  as they happen, because they describe transport work that happened whether or not its operation
  commits ("route evidence independent of state publication").
- **After-commit hooks:** `controller.onCommit(hook)` registers a hook called once per accepted
  settings or state commit, in registration order, with the committed change (`CommittedChange`).
  Hooks run after the locks guarding the commit are released. A hook that changes state makes its
  own commit, which is queued, never nested. They are a plain ordered list, not an event bus, and do
  not rely on storage change events, which the CLI does not have. The tick (#587), auth (#595),
  manual watch (#596) and the Twitch Extensions lane (#594) move onto them; #594 replaces the
  extension host's `storage.onChanged` diffing with a hook on its settings and Twitch state changes.

The test suite enforces the model. The characterization and contract harnesses give the controller
a lock tracker (`tests/helpers/lockTracker.ts`, backed by `AsyncLocalStorage`) and guard every
provider, tab and timer port. A test fails when a lock is taken out of order, a commit nests in a
commit, or a port is called under a lock from a call site missing from `LOCKED_IO_ALLOWLIST`. The
site check reads the async stack trace, so the lock queues are written with `await` and a release
promise rather than `.then()` chains, which V8 cannot see through. `stateTransaction.test.ts`
covers the rules themselves, including an unlisted call site failing and hook ordering.

### Scheduler tick effects (#599)

The scheduler tick decides; it performs nothing. `decidePlatformTick` (`core/scheduler.ts`) is an
async generator per platform. Its inputs are plain values: the state and settings, the committed
discovery (`complete`, or incomplete and possibly `discarded`), the prepared selection, an in-memory
view of the discovery snapshot to select channels from (`selectionAdapterFromDiscoverySnapshot`),
and declared capabilities (tabless, Kick challenges, channel points). It never calls an adapter, a
port or the tab module. Each side effect it needs is yielded as a typed `SchedulerEffect`:

| Effect | Interim handler (`background/tickEffects.ts`) | Final owner |
| --- | --- | --- |
| `claimRewards` | `claimReadyRewards` (`core/rewardClaims.ts`) | #597 |
| `claimChannelPoints` | `adapter.claimChannelPoints` | #590 |
| `claimChallenges` | `adapter.claimChallenges` | #588 |
| `openWatchTab`, `stopWatchTab` | `adapter.prepareWatchTab` / `stopWatchTab` | #598, #587 |
| `releasePageContexts` | the host's `stopPageContextTabs` | #588 |
| `selectSupplementalTarget` | the Twitch Extensions host's `select` | #587 |

The yielded effects in order are the tick's plan. It is produced incrementally rather than returned
at once, because later decisions depend on earlier results. A claim can satisfy the next reward's
precondition, which the same tick then selects. A new tab is closed again if the selection went
stale while it opened. A failed effect is thrown back at its `yield`, so the tick's own `catch`
still decides what it means: an authentication error suspends the platform and a watch-tab failure
is a `platform_error` with backoff. `EffectExecutor` (`core/effectExecutor.ts`) maps each effect
type to exactly one handler and throws when a second one registers. An owner issue replaces the
interim registration with its service's handler; the tick itself never changes.
`runSchedulerTickEffects` drives the platforms in order, running each yielded effect through the
executor, and mirrors the page-context registry and managed-tab breaker around them. The deciding
code never touches either.

`runTick` runs a tick in three steps:
1. **Under the platform lock:** read the settings and state, and settle the prepared selections.
2. **With no lock held:** run the tick and its effects. Telemetry, heartbeats, tab events, claims
   and auth transitions commit meanwhile rather than queueing behind the tick.
3. **Under the platform lock again:** rebase the result on the stored state (`rebaseTickState`,
   `tickCommit.ts`), then reconcile watchers, ad focus and observers and publish, as before.

The rebase is a three-way merge per platform-owned key:
- a key only another writer changed keeps that writer's value, as if it had run after the tick;
- a key only the tick changed takes the tick's;
- when both changed a key:
  - playback telemetry is re-applied on top of the tick's session when the tick still watches the
    same tab;
  - heartbeat fields stay with the heartbeat's commit;
  - the other writer's claims carry into the tick's inventory;
  - anything else is a conflict.

On a conflict, or when the selection went stale, the decision is dropped. `tickEffectFacts` still
records the rewards the tick claimed and the managed tab it closed. A tab only the dropped decision
opened is closed after the lock is released. A conflict also requests a `tick_superseded` follow-up
tick, which re-selects from the discovery already held. An aborted tick (reset, shutdown) records
nothing, as before.

With the tick unlocked, the claim jobs no longer queue behind it, so every claim path reserves first
and skips while another path holds the reservation: rewards per id (`RewardClaimGuard`: the tick, the
drop-claim job and `claimRewardNow`), and one Kick challenge claim and one channel-points claim at a
time. A channel-points push names one specific claim, so it waits for a running claim instead of
skipping, as it used to wait behind the tick's lock. An aborted tick starts no further effect:
`driveEffects` checks the tick's signal before each one. The in-tick `refreshCampaigns` fallback is gone: discovery reaches the tick only through the
committed snapshot lane.

### Host ports and jobs (#593)

Both hosts build the controller from `BackgroundHostPorts` (`hostPorts.ts`), not from a flat list
of optional hooks:

| Port | Extension | CLI |
| --- | --- | --- |
| `storage` | `browser.storage.local` | `state.json` (saved atomically: temporary file, then rename); settings from the config file, never written |
| `events` | Activity store, OS notifications, locale catalogs | The logger |
| `jobs` | `browser.alarms` (`src/core/jobs.ts`) | Node timers (`src/runtime/jobs.ts`) |
| `adapters` | Browser transports and compatibility resolution | Node transports |
| `credentials` | Cookie observation | The file/env credential store |
| `tabs`, `kick.pageContextRecovery` | Browser tabs (#598 splits them into role ports) | Absent |
| `twitch.integrity` | Page capture | Absent |
| `twitch.supplementalSources` | Twitch Extensions host (#587 adds `prepare`) | Absent |

Each host passes a static `capabilities` object (`EXTENSION_CAPABILITIES`, `CLI_CAPABILITIES`),
written by hand. `createBackgroundController` throws `HostCapabilityMismatchError` when a
capability's ports are present without the capability or the other way round, so a missing port
never switches a feature off silently. A setting that needs a capability the host lacks
(`tablessMode: false` or `pauseOnManualWatch` without browser tabs) is reported once per
controller as an English diagnostic, with no platform, and changes nothing else.

The job scheduler port is the only way the engine schedules work. `jobs.ts` documents its
semantics, and both implementations keep them: a minimum period (`MIN_JOB_PERIOD_MINUTES`), ensure
replaces a job and restarts its period, cancel is idempotent, a one-shot job is gone once it fires,
a suspended host fires once on wake rather than once per missed period, and a job can fire again
while its last run is still going, so the services coalesce their own runs (tick admission,
heartbeat lanes). Alarms survive a service-worker restart; Node timers do not, so the CLI
re-ensures its jobs on every start, through the startup reconciliation below.

`BACKGROUND_JOBS` lists every job and the capability it needs. A job whose capability the host
lacks is inert: ensuring it schedules nothing and a fire of it does nothing. On the CLI that covers
the manual-watch claim jobs and Kick challenges (browser tabs), the integrity refresh (integrity
capture) and the one-minute channel-points job (`twitchChannelPointsJob`, which #590 enables). The
host delivers fires to `controller.runJob(name)`. The CLI routes its tick jobs through its own tick
driver, which adds disabled-platform cleanup and subscription reporting, and runs each at
`pollIntervalMinutes` with the heartbeat job every minute, as before.

Both hosts run one restart reconciliation, `reconcileStartup`, when their process starts: the
extension on browser startup (inside `handleStartup`), the CLI on every process start before its
first heartbeat and ticks. It aborts claim handoffs, re-ensures the jobs, releases the heartbeat
ownership the previous process held, pauses the sessions it left watching (`runtime_restart`),
releases its tabs, and normalizes the settings. It does not resume farming: the extension's
`handleStartup` then ticks (or refreshes auth health), and the CLI's own tick driver resumes. The
CLI pins `autoStartDropFarming` to true, since it always resumes its enabled platforms and the
reconciliation would otherwise switch them off. Before #593, a CLI restart skipped all of this and
let heartbeat recovery resume the previous watch from its persisted cadence.

### Characterization coverage

v1.15.0 extractions must keep these tests passing without editing their assertions, except in a PR
labelled `behavior-change`. `controllerContract.test.ts` runs its cases once per declared host
capability set (`EXTENSION_CAPABILITIES` and `CLI_CAPABILITIES`, through
`tests/helpers/controllerContract.ts`), against fake ports.

| Invariant | Where it is tested |
| --- | --- |
| One active tick and one shared follow-up per platform; Twitch and Kick progress independently | `controllerContract.test.ts` (both hosts); `backgroundController/tickAdmission.test.ts` ("coalesces same-platform ticks…", "admits one Twitch tick and one follow-up…"); `backgroundController/stateCommit.test.ts` (the "lets Kick … while Twitch …" cases) |
| `ranking_changed` re-selects without rediscovery and loses to any trigger that needs fresh discovery | `controllerContract.test.ts`; `backgroundController/settingsTransitions.test.ts` ("reordering what is farmed") |
| Cancelled work publishes no state or activity | `controllerContract.test.ts` (shutdown); `backgroundController/lifecycle.test.ts` ("aborts in-flight scheduler work…"); `backgroundController/reporting.test.ts` ("route evidence independent of state publication") |
| Stale discovery, selection and heartbeat work cannot overwrite newer state | `backgroundController/heartbeat.test.ts` ("rejects a stale heartbeat…", "persists discovery after a due heartbeat invalidates a blocked snapshot selection", "does not let a stale … removal …") |
| Heartbeat due time is independent of ticks | `backgroundController/heartbeat.test.ts` ("tabless heartbeat cadence", "lets Kick heartbeat and persist while Twitch heartbeat is still pending") |
| Manual managed-tab closure | `backgroundController/manualWatch.test.ts` ("manual-watch event transitions", "clears manual watch activity when the source tab is closed") |
| Service-worker restart | `backgroundController/lifecycle.test.ts` (the startup cleanup cases); `backgroundController/heartbeat.test.ts` ("serializes service-worker restart recovery…"); `controllerContract.test.ts` (extension host) |
| CLI process restart: the same reconciliation as the extension (#593) | `controllerContract.test.ts` (both hosts, "process restart"); `packages/cli/tests/run.test.ts` ("pauses the previous process's watch at startup…") |
| Job registration: the CLI registers only its tick and heartbeat jobs (#590 adds channel points); inert jobs are never scheduled or run | `controllerContract.test.ts` ("jobs") |
| Duplicate and late job fires coalesce; no job runs after shutdown | `controllerContract.test.ts` ("jobs") |
| Job scheduler semantics on each host | `hostPorts.test.ts` (`browser.alarms`); `packages/cli/tests/jobs.test.ts` (Node timers) |
| Declared capabilities match the ports; unsupported settings are reported once | `hostPorts.test.ts`; `controllerContract.test.ts` ("capabilities") |
| The CLI's `state.json` save is atomic | `packages/cli/tests/storage.test.ts` |
| The popup reads the stored settings and state verbatim | `controllerContract.test.ts` ("runtime snapshot") |
| Campaign ranking and #571's selection rules (mid-reward takeover, favourites, discarded refresh hold, just-armed watch) | `ranking.test.ts`, `rankingSettings.test.ts`, `scheduler.test.ts`, `watchSourceScheduler.test.ts` |
| `updateIdleWatchlist` keeps a concurrent popup change | `backgroundController/settingsTransitions.test.ts` ("Idle Watchlist changes from the page") |
| Supplemental lane: tabless only, released on completion or manual pause | `supplementalWatch.test.ts`, `twitchExtensionHost.test.ts` |
| Supplemental lane: completion forgotten on restart (current behavior; #594 changes it) | `twitchExtensionHost.test.ts` ("forgets completion when a new host starts…") |
| The scheduler tick decides from plain inputs and names its effects; one handler per effect type | `schedulerEffects.test.ts` |
| A tick's effects run with no lock held; concurrent telemetry is kept, a contradicting writer drops the decision but not the claims or tabs it produced, and an overlapping claim is requested once (#599) | `backgroundController/tickEffects.test.ts`; `tickCommit.test.ts` |
| Locked I/O can only shrink | `lockedIoAllowlist.test.ts` (source scan); `tests/helpers/lockTracker.ts` (runtime, every harness) |
| Lock order, nested commits, commit results, hooks and settings effects | `stateTransaction.test.ts`; `backgroundController/stateCommit.test.ts` ("calls after-commit hooks…") |
| Every `SchedulerState` key merges per platform or is global | `platformState.test.ts` |

## Runtime Messages

The popup and content scripts do not call adapters directly. They send typed runtime messages from `@lurkloot/shared/messages`:

- Popup messages: `getSnapshot`, `saveSettings`, `setRunning`, `setPlatformEnabled`, `setAutomation`, `tickNow`, and `claimReward`.
- Content-script messages: `getPlaybackControl` and `playbackTelemetry`.

`getPlaybackControl` is intentionally gated in the background controller. A content script may only control page video elements when its sender tab is the current watch tab for that platform. This prevents normal user-opened Twitch/Kick tabs from being modified.

## Settings Model

`mergeSettings` in `@lurkloot/shared/settings` is the source of truth for defaults and persisted-setting normalization. It fills missing keys from `DEFAULT_SETTINGS`, clamps numeric values, normalizes channel/category/campaign lists, and removes duplicate list entries. It reads only current property names; legacy shapes are handled beforehand by the migration registry (see [Settings Migrations](#settings-migrations)).

Important setting groups:

- Global automation: `running`, `autoStartDropFarming`, per-platform `enabled`.
- Farming behavior: `autoClaim`, `autoClaimChannelPoints`, `priorityMode`, `campaignPins`, `farmPinnedOnly`, `excludedCampaignIds`, `farmingEligibility`.
- Platform preferences: `platform[platform].watchSourcePriority`, `platform[platform].idleWatchlistChannels`, `platform[platform].excludedChannels`, `platform[platform].categoryMode`, `platform[platform].categories`, `platform[platform].favouriteCategories`, and `platform[platform].blockedCategories`.

`categoryMode` is `"all"` or `"include"`, and one stored `categories` list serves
both: `all` farms everything and leaves the list inactive, `include` farms only
the listed categories (an empty list farms nothing). Neither mode ranks —
position in the list has no scheduling meaning — and switching mode never
rewrites the array, so returning to `include` restores the selection the user
had. `blockedCategories` is the single denylist and applies in both modes;
`favouriteCategories` is the only way a category affects order, and it ranks
rather than filters. `campaignPassesCategoryFilter`, `isCampaignCategoryBlocked`
and `favouriteCategoryIndex` in `@lurkloot/shared/categories` answer all three
questions, so farming eligibility, the popup's sections, scheduler rejection
reasons and ranking cannot disagree.

### Campaign ranking

`rankCampaigns` in `@lurkloot/shared/ranking` is the only campaign order in the
product. The scheduler picks from it, the keep-watching comparison reads it, and
the popup's Queue renders it, so the rank on a card is the position the engine
acts on. Three tiers, in order:

1. `campaignPins` — an ordered, sparse list of campaign ids the user placed by
   hand. Dragging a card, or typing a rank, pins that one campaign; everything
   else keeps the tier it had.
2. `platform[platform].favouriteCategories` — campaigns of starred games, in the
   order they were starred. A standing preference that survives campaign churn,
   so next season's campaign of a starred game is already high.
3. `priorityMode` — one live strategy (`ending_soonest` or
   `lowest_availability`), then name, then id.

Eligibility is always decided before ranking (`evaluateCampaignFarming`), so a
pin can never rescue a campaign an exclusion, a block or a class filter refused.
`farmPinnedOnly` is an eligibility switch, not a mode: a strategy is always in
effect. Only a pin counts as an explicit override for keep-watching — a
favourite ranks what is picked next but never abandons earned progress.
- Tab/playback behavior: `tablessMode`, `muteFarmingTabs`, `keepFarmingVideosUnmuted`, `pauseOnManualWatch`, `autoCloseFinishedDrops`, `offlineRetryLimit`.
- Notifications: `notifyRewardEarned`, `notifyNoDropsLeft`.

The popup normalizes snapshots before rendering and normalizes patches before saving, so older stored settings get current defaults before they drive UI toggles.

## Settings Migrations

`packages/shared/src/settingsSchema.ts` is the only place legacy settings shapes
are transformed. Both hosts call `migrateSettings(raw)` on the raw persisted
payload and pass the result to normalization (`mergeSettings` in the extension,
`parseCliSettings` in the CLI). Migration and normalization are deliberately
separate: clamping and defaulting would erase the raw property information the
deprecation diagnostics depend on.

A stored document carries a reserved `schemaVersion`; an unversioned document is
version 0. `migrateSettings` applies every migration from the stored version up
to `CURRENT_SETTINGS_SCHEMA_VERSION`, returning the migrated payload, a `changed`
flag, and structured diagnostics. A version newer than this build supports throws
`UnsupportedSettingsVersionError`, and neither host writes after that error.

Extension storage is upgraded automatically: `loadSettings` writes the canonical
envelope once when `changed` is true, under the settings lock. The CLI's JSONC
file is never rewritten, so its diagnostics surface as startup warnings that
repeat until the user edits the file.

To add version N+1:

1. Increment `CURRENT_SETTINGS_SCHEMA_VERSION`.
2. Add exactly one pure `N` → `N+1` entry to `MIGRATIONS`. It receives a deep
   clone it owns outright, so it may mutate that object freely, but it must not
   reach outside it or log.
3. Emit a diagnostic for every deprecated or removed property it recognizes,
   with the full dotted path and the replacement path when one exists.
4. When an old and a current representation coexist, the current one wins and
   the deprecated one still produces a diagnostic. Migrations never inspect
   value types, so a wrong-typed current value is left for normalization to
   default rather than falling back to the legacy value.
5. Add fixtures to `packages/extension/tests/settingsMigrations.test.ts` for
   version N input, mixed old/current input, and the fully migrated output.
6. Update `defaultConfigJsonc()` in `packages/cli/src/config.ts` when public
   property names change.

Released migrations are never edited except to fix a data-loss defect. A later
semantic change gets a new version and a new migration.

Migration 1 consolidates every legacy shape that predates the registry: the Idle
Watchlist rename, the pre-split top-level channel-points toggle, and the
`verboseLogging` rename.

Migration 2 replaces the old `campaignVisibility` record, which in every shipped
release was display-only — it decided what the popup's Drops list showed and
never affected farming. The new split puts two settings on opposite sides of the
engine/extension boundary: `EngineSettings.farmingEligibility`
(`farmUnlinkedCampaigns`, `farmSubscriptionCampaigns`), which the scheduler and
CLI honour, and `ExtensionSettings.dropsListFilter`
(`showUpcoming`/`showExpired`/`showFinished`/`showExcluded`), a popup-only view
preference the CLI rejects as extension-only. Farming eligibility and list
visibility are independent: hiding a campaign from the Drops list never stops it
being farmed, and skipping a campaign class never hides it.

The migration carries over only the four lifecycle display keys into
`dropsListFilter`. It deliberately does NOT derive `farmingEligibility` from the
old record: `campaignVisibility.notLinked` and `.subscription` were list-display
preferences that never meant anything about farming, so mapping them into the new
farming gates would silently reduce farming for anyone who had merely hidden
those campaigns. Both farming flags therefore default to on and are never derived
from the old setting, so farming behaviour is unchanged for every profile. A
profile that had hidden unlinked or subscription campaigns from its list will see
them reappear in the Drops list, because those campaigns are farmed and the tool
guarantees anything it farms is visible.

Migration 7 collapses the old ranking stack into the pins/favourites/strategy
model and retires the display filter it grew alongside. `campaignPriorities`
(a dense id→number map) becomes the ordered `campaignPins` list, highest value
first; `priorityMode: "priority_list_only"` becomes the `farmPinnedOnly` switch
with the mode falling back to `ending_soonest`; a platform's
`categoryMode: "exclude"` becomes `"all"` plus `blockedCategories`, the single
denylist; and `dropsListFilter` is dropped, because the popup now groups
campaigns into Queue, Skipped, Upcoming and Completed rather than hiding classes
of them. Nothing here narrows farming: the same campaigns stay eligible, in the
order the user's own placements imply.

## Scheduler Flow

Each scheduler tick runs enabled platforms independently:

1. Pause and clean up the platform if recent manual watch activity is detected, global automation is disabled, or that platform is disabled.
2. Skip the platform while it is in exponential backoff after repeated platform errors.
3. Take the campaigns from the committed discovery snapshot and merge progress. The tick never discovers campaigns itself.
4. Auto-claim claimable rewards when enabled.
5. Select the first eligible source in the platform's normalized `watchSourcePriority`, preserving campaign and channel ranking within each source. See [watch-source selection policy](watch-source-priority.md).
6. Decide whether to keep the current target by checking channel liveness/category and recent playback or heartbeat telemetry.
7. Use tabless watching when enabled and supported, or open, reuse, retarget, or stop the watch tab through the adapter.
8. Claim channel points when enabled and supported by the adapter.
9. Persist sessions, campaigns, managed-tab registrations, and backoff state, then publish activity records through the host event sink.

Steps 1–8 decide and name their side effects; the tick's effect executor performs them with no lock held, and step 9 rebases the result on whatever else committed meanwhile. See [Scheduler tick effects](#scheduler-tick-effects-599).

Campaign ordering is shared across platforms and lives in one function,
`rankCampaigns` (see [Campaign ranking](#campaign-ranking)): pinned campaigns in
pin order, then campaigns of favourite games in star order, then the single live
strategy, then name and id. Channel ordering within the selected campaign is also shared: allow-listed channels first, then channels the user has a relationship with (an Idle Watchlist entry ahead of a followed channel, via the adapter's optional `listFollowedChannels`), then viewer count. That preference only picks between channels that already qualify for the campaign, so it never changes what is farmed. `preferKnownChannels` (on by default) gates the whole thing; off, ordering is allow-list then viewer count only, and `listFollowedChannels` is never called. Per-platform excluded drop channels filter campaign and supplemental provider candidates; they do not suppress explicitly listed Idle Watchlist channels. `farmingEligibility` also narrows eligibility, through its two farming flags (`farmUnlinkedCampaigns`, `farmSubscriptionCampaigns`), as do `blockedCategories` and `farmPinnedOnly` — all of them before ranking, never through it.

For exactly how a campaign's farmability (`campaignFarmable`, feeding `isEligible`) and the popup list it lands in (`campaignSection`) are decided — and why they deliberately diverge on reward timing — see [`campaign-farmability-visibility.md`](campaign-farmability-visibility.md).

## Same-Origin Fetching

In the extension, most platform calls go through the page-context fetch helpers wired by `packages/extension/src/core/tabs.ts` onto abstractions from `@lurkloot/core/tabs`. They find or open a temporary tab on the platform origin, then execute `fetch` in the page `MAIN` world. This keeps requests inside the browser's normal logged-in session and any page clearance context.

For Kick, `pageFetchJson` reads `session_token` from the Kick page context and adds it as a bearer token for `web.kick.com` API calls. For Twitch, GraphQL requests use Twitch's public web client id and normal browser credentials unless a public channel check explicitly passes `credentials: "omit"`. Twitch claim mutations also replay a short-lived Client-Integrity bundle captured from page-origin Twitch GraphQL traffic.

Temporary page-context tabs are reference-counted per origin and removed after the fetches complete when the extension created them. Existing user tabs reused for page-context fetches are not closed.

Kick may retain an extension-owned page-context tab when its service-worker fetch is rejected. One extension-host tracker receives successful route callbacks from every Kick fetcher, including the controller-lifetime tabless watcher, and drains only after scheduler state persists; residual evidence is discarded on every uncommitted tick exit. A fallback always resets recovery immediately, including on an incomplete cycle; only a complete, error-free direct cycle advances it once, regardless of request count. After the configurable number of consecutive direct cycles (three by default, 1–10 in Advanced settings), the extension verifies and closes that exact managed tab. Unreadable or concurrently changed tab ownership is retained for a safe retry, while ownership is released synchronously immediately before removal so a new fallback acquires a separate context. The counter is persisted with scheduler state so service-worker restarts do not reset or resurrect ownership. The CLI has no browser page-context tabs and does not expose this setting.

## Twitch Integration

`TwitchAdapter` uses Twitch GraphQL at `https://gql.twitch.tv/gql` with persisted query hashes and the public Twitch web client id.

- Campaign discovery calls `Inventory` and `ViewerDropsDashboard`, then fetches campaign details for active/upcoming connected campaigns.
- Progress refresh re-reads `Inventory`; while watching, it also queries `DropCurrentSessionContext` to update the current reward's watched minutes.
- Candidate discovery prefers campaign allowed-channel data. If none exists, it queries `GameDirectory` with the DropsEnabled tag and sorts by viewer count.
- Followed channels come from an inline `FollowedLiveChannels` query (`currentUser.followedLiveUsers`), cached for 5 minutes in `TwitchDiscoveryState` (injected, so the cache survives the extension reconstructing `TwitchAdapter` every tick). A tick never blocks on this: a cached value, even a stale one, is returned immediately and refreshed in the background; only the very first lookup ever (nothing cached yet) awaits the request. A signed-out session or a failed lookup answers with an empty list, and selection falls back to viewer count.
- Channel validation calls `StreamInfo` with an inline public query and anonymous credentials to avoid logged-in integrity-token failures. For live category matches, it briefly caches `DropsHighlightService_AvailableDrops` results to confirm the selected campaign; unavailable or malformed confirmation data falls back to the live/category result. If `StreamInfo` fails, validation falls back to parsing channel page HTML.
- Reward claiming calls `DropsPage_ClaimDropRewards`.
- Channel points claiming uses live Hermes `claim-available` when the advanced setting is on; `ChannelPointsContext` remains the alarm fallback.
- Tabless watching sends Twitch's `sendSpadeEvents` minute-watched mutation once per watch alarm while the selected stream is live.

## Kick Integration

`KickAdapter` uses Kick JSON APIs from the Kick page context.

- Campaign discovery fetches `https://web.kick.com/api/v1/drops/campaigns`.
- Progress refresh fetches `https://web.kick.com/api/v1/drops/progress`.
- Candidate discovery prefers campaign allowed-channel data. Otherwise it queries `https://web.kick.com/api/v1/livestreams` with `category_id`, sorted by viewer count.
- Followed channels come from `https://kick.com/api/v1/user/livestreams`, which Kick itself filters to the account's live follows (no pagination of the full follow list), cached for five minutes in `KickDiscoveryState`. Strict discovery awaits stale refreshes to keep fetch lifecycle observation inside its cycle; standalone callers can still read stale values immediately. A signed-out session or a failed lookup answers with an empty list, and selection falls back to viewer count.
- Channel validation calls `https://kick.com/api/v2/channels/{username}` and checks live state plus category id. If that fails, it falls back to parsing channel page HTML.
- Reward claiming posts to `https://web.kick.com/api/v1/drops/claim` with campaign, reward, and claim identifiers.
- Tabless watching exchanges the Kick session for a viewer WebSocket token, opens Kick's viewer socket, and sends watch livestream events while the channel remains live and in the expected category.

## Watch Tabs

Both adapters use the shared `openPinnedMutedTab` and `stopWatchTab` helpers.

Watch-tab preparation:

- Reuses a registered extension-managed tab when possible.
- Reuses a user tab only when the current session was already using a non-managed user tab.
- Retargets stale/wrong URLs to the selected channel.
- Pins the tab and applies browser-level tab muting according to `muteFarmingTabs`.
- Briefly activates newly created, retargeted, missing-telemetry, stale-telemetry, or unhealthy-playback tabs when `keepFarmingVideosUnmuted` is enabled, then restores the previously active tab. This primes players that defer loading until foregrounded.
- Stores extension-managed tab ids in scheduler state so stale managed tabs can be cleaned up without closing arbitrary matching user tabs.

When a managed watch tab is manually closed, `background.ts` notifies the controller, which triggers a fresh scheduler tick if automation is running.

Stopping behavior depends on ownership and settings:

- Extension-managed watch tabs are closed when `autoCloseFinishedDrops` allows it.
- Reused user tabs are unmuted, unpinned, and left open.

## Tabless Watch

When `tablessMode` is enabled, supported adapters create a `TablessWatchController` instead of opening a watch tab. Twitch sends minute-watched GraphQL events. Kick maintains a viewer WebSocket and sends watch livestream events. The one-minute watch alarm records heartbeat health in the platform session; repeated failures mark the target for fallback to a visible muted tab.

## Playback Telemetry and Control

Content scripts run on all Twitch/Kick pages, but only the current watch tab is authorized to mutate video state or update farming playback health. Non-managed tabs send passive telemetry only so the background can detect manual watching when `pauseOnManualWatch` is enabled.

Every five seconds, and after visibility/focus/player mutations, the content script asks the background for `PlaybackControl`:

- If `managed` is false, it reports passive telemetry and does not change page video state.
- If `managed` is true and `keepVideosUnmuted` is true, it removes page-level video muting, sets nonzero video volume, attempts `video.play()`, and listens for later `volumechange`/`pause` events so platform player state changes can be corrected. The content script suppresses the `volumechange`/`pause` events its own mutations trigger to avoid a self-feeding control loop.
- Some browsers (notably Firefox) refuse to unmute media in a tab that has had no user gesture and pause the element instead. The content script only attempts to unmute once the document reports sticky user activation (`navigator.userActivation.hasBeenActive`), so a background watch tab stays muted-but-playing without logging warnings. As a safety net, if an unmute is still blocked it re-mutes and replays the video so playback keeps progressing (counted in blocked playback count); watch time is credited even while muted.
- It reports telemetry including video count, muted/unmuted video count, playing video count, blocked playback count, document visibility, ready state, current time, and duration.

The scheduler treats playback as healthy when recent telemetry shows at least one video and at least one playing video — muted or not, since the browser may keep a background video muted. The browser tab can still be muted; the platform-visible page video state is intentionally separate from browser tab audio output.

Repeated offline, category mismatch, unhealthy playback checks, or unhealthy tabless heartbeats cause the scheduler to switch channels or fall back according to `offlineRetryLimit`.

## Popup and Manual Actions

The popup is a controller UI, not a platform client. It requests snapshots and sends setting/action messages to the background controller. Manual reward claims are routed through the platform adapter so state updates, notifications, and event logging stay consistent with automated claims.

The popup is a workspace: a rail carries the platform switch and one entry per
destination — Queue, Completed, Games, Idle watchlist, Extensions (Twitch only),
Activity, Settings — with the now-farming strip above all of them. Platform and
destination are independent axes; a destination that exists on one platform only
falls back to the Queue when the platform changes under it.

`campaignSection` in `@lurkloot/shared/campaignFilters` puts every campaign in
exactly one list — queue, skipped, upcoming, completed or expired — so a campaign
is never missing from the popup and never in two places. The Queue groups its
rows by ranking tier, and Skipped rows carry the reason the engine gave plus the
single action that resolves it. Changes that can affect the active scheduler
target can request a targeted tick for the affected platform.

## Activity and diagnostics

The controller emits causally ordered batches of typed activity and diagnostic records through a host-provided reporter. Farming starts, stops with a stable reason, successful claims, and actionable interruptions are activity; request, playback, tab, and scheduler detail is diagnostic. Unchanged periodic decisions are not emitted repeatedly. Hosts format and retain these records at that reporter boundary rather than reconstructing prose from scheduler state.

Activity records are structured (`code` plus `data`) and localized by the host at render time. Diagnostic records carry a literal English `message` and are never translated, in any locale, because they are the surface a user pastes into a bug report and a maintainer greps: `packages/core` imports no message catalog, and the popup renders a diagnostic body verbatim. Only activity entries and OS notification copy are localized, the latter through the `translate` callback the host injects into the controller.

Every activity event therefore also emits a diagnostic mirror. `packages/core/src/core/activityDiagnostics.ts` wraps the controller's event collector — the one choke point all engine emitters funnel through — and restates each activity event in English with the context the localized sentence drops: campaign and reward ids, raw reason codes, claim method, session detail. Emit sites do not hand-write a matching diagnostic.

The extension stores activity in a bounded IndexedDB database owned by the background and queries it from the popup through runtime messages. Normal activity is always retained; diagnostic persistence is extension-only and opt-in, so hosts with diagnostics disabled drop the mirrors when they filter by category. Each category has its own record budget, so mirrors never evict activity history. Activity database failures are isolated from farming state mutations.

The popup shows one category at a time. The activity/diagnostics switch selects a view rather than interleaving both, since the mirror means a merged list would state everything twice.

The CLI has no activity store. Its output is already English, so it logs mirrored diagnostics at `debug` — their ids and reason codes stay available under `--log debug` without repeating each activity line at its own level. It formats each activity variant directly, passes diagnostic messages through, and routes each batch in its original order through the existing `--log`-filtered stderr logger. Retention belongs to Docker, systemd, Loki, or another external collector; `state.json` never contains new event data, and legacy event fields disappear after the state is loaded and saved.

Kick fetch diagnostics keep individual initial-route, fallback, recovery, and
lifecycle-update-failure evidence. Unchanged successes use fixed counters for
`kick.com`, `web.kick.com`, `websockets.kick.com`, and one unknown-host bucket,
split into background/page routes. Drained auth, discovery, scheduler, manual
action, and watcher operations flush a `kick_fetch_summary` diagnostic with
numeric counts and an English message usable in exports and CLI debug logs.
No URL path, query value, arbitrary host, header, credential, or payload is kept.
The last announced route lives in host-owned `KickDiscoveryState`, so adapter
reconstruction does not repeat it; restarting the runtime begins a new history.
Counters are fetcher-local; a flush requested while a request or lifecycle
callback is active defers one summary until all active work settles. They never
consume page-context recovery observations:
successful HTTP counts also describe failed scheduler operations and must not be
interpreted as committed recovery cycles. The controller reports these transport
diagnostics independently of auth-generation and scheduler-publication gates,
including late completions after an auth deadline. Closed operational collectors
and tick handles discard late activity. Each collector or tick adapter handle
settles only its own diagnostic reporting promises, so a stalled Kick report
cannot block Twitch discovery or heartbeat transmission. A controller-wide
registry is drained only by explicit background-work settling. These report sets
track emitted diagnostics, not unfinished transport requests. Activity-event mirroring
and operational publication rules remain unchanged. CLI `discover --log debug`
also constructs its adapters with an emitter and flushes/reports its discovery
diagnostics before disposing the transport.

## Tabless Twitch Extension rewards

The extension host injects a browser-free supplemental target selector into the scheduler. After platform, authentication, exclusion and manual-pause gates, an enabled/granted provider can select a live channel independently of drop campaigns. Directory scans and active-installation reads are bounded, batched and cached. The platform's configured watch-source order controls selection and preemption; completion or unavailability releases the lane with bounded reprobes. See [source-priority decisions](watch-source-priority.md).

Supplemental sessions carry their own watch identity and `tablessOnly` marker. Their heartbeat does not require invented campaign/reward IDs, and neither heartbeat failures nor ambiguous ordinary campaign discovery may cause tab fallback. Ordinary drop sessions retain their existing watch-mode policy.

Channel-scoped viewer authorization is acquired through the normal Twitch background transport. Privileged provider drivers send it directly to their own optional backends. JWTs and vendor session/device properties remain in memory; only validated bounded outcomes and counters reach transient popup snapshots. Provider state is not restored from storage after worker restart. Disable, revocation, logout, channel changes and manual pause invalidate authority and cancel resources, including late results.

NoPixelV uses its normal REST watchtime/giveaway protocol. Fortnite uses its normal socket handshake, versioned state reads and sprite capture commands; authoritative participant increments confirm captures, and actual server reward state determines completion. Optional takeovers require separate opt-in, server eligibility and ownership confirmation. See [provider details and live acceptance](twitch-extensions/foundation.md).
