# Architecture

Lurkloot is a WXT browser extension that farms Twitch and Kick drops through normal logged-in browser sessions. Tabless watching is the default (`tablessMode: true`): Twitch requests HLS media-segment headers, with the older minute-watched beacons still selectable, and Kick uses a viewer connection, with no stream video. After repeated unhealthy heartbeats, a browser host falls back to a visible muted tab, and that tab plays the stream, so platform ads can run there. The CLI cannot open tabs, so it always watches tabless and retries failed heartbeats in place. The extension does not ask for a password or bypass platform page detection. Session cookies leave the browser only through Settings → Export credentials, a user-confirmed action that writes a local file for the CLI.

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
- Browser tabs are an extension-only capability (#598). `packages/core/src/core/tabRegistry.ts` (`@lurkloot/core/tabRegistry`) is the engine's side: the tab state and the rules for it (the managed-tab breaker, page-context snapshots and the recovery threshold, integrity captures and waits), with no browser code. `packages/extension/src/core/browserTabs.ts` holds the mechanics (watch tabs, playback priming, ad focus, page-context tabs and in-page fetches, the twitch.tv boot that mints an integrity token) against an injected `BrowserTabApi`, `packages/extension/src/core/tabPorts.ts` (`createExtensionTabPorts`) builds the controller's `tabs` ports from them and the user's tab settings, and `packages/extension/src/core/tabs.ts` binds the rest to the live WXT/browser APIs. `coreBoundary.test.ts` keeps tab mechanics out of core. Tab state (page contexts, the managed-tab breaker, playback priming, ad focus, integrity captures and waiters) lives in a `TabRegistry`, one per controller, never at module level. The extension creates it, binds its tab functions to it with `createBrowserTabs`, and passes it to the controller as `tabRegistry`; a host without tabs gets an empty one from the controller. `tests/tabRegistry.test.ts` checks that two controllers share no tab state (#598). Every tab the engine closes goes through `closeTab` in `browserTabs.ts`, which records a closure origin (`extension-cleanup`, `extension-recovery` or `host-restart`) in the registry before the browser call. `handleTabRemoved` takes that origin, defaulting to `user`, and only a `user` close of the managed watch tab creates a manual-close pause. The tick closes its tab with no lock held, so the removal event can land before it commits. The record outlives the removal event (bounded, since browsers do not reuse tab ids), so a playback report still in flight from a tab the engine closed is dropped as a late result instead of reading as the user watching. The host forwards tab events through `TabEventsPort` (`handleTabRemoved`, `handleTabUpdated`).
- `packages/core/src/core/transport.ts` (`@lurkloot/core/transport`) holds the cookie-backed background fetchers for Twitch GQL and Kick's API, with no tab state. The Twitch fetcher takes an injected request identity (integrity token and client session id), so the extension replays the page-captured token and tabless hosts send none. The CLI imports only this module and no tab code; `packages/cli/tests/tabBoundary.test.ts` guards that (#598).
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
state and serializes its work since the v1.15.0 engine refactor (#583): the owned services, their
locks and commit hooks, and the effect handlers each one registers. "Engine ownership at a glance",
under "Settings Model", is the short version.

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
- `tickEffects.ts` and `tickCommit.ts` (#599) are the scheduler tick's effect executor, which the
  owning services fill, and the tick's three-way commit. See "Scheduler tick effects" below.
- `supplementalSources.ts` (#591) owns the supplemental-sources port and registers the
  `selectSupplementalTarget` handler, so the tick never touches that Twitch-only port.

The per-module slices and calls below are where #591's dependency check starts:

| Module | Slices | Calls into | Provides |
| --- | --- | --- | --- |
| `stateTransaction.ts` | its own lock queues and hooks | none | the transaction (#585) |
| `stateCommit.ts` | the transaction | `reporting` | 13 |
| `reporting.ts` | `reportingSlice` | `discovery` | 14 |
| `tickAdmission.ts` | `tickSlice` (with `tickRun`, the tick coordinator), `lifecycleSlice` (read), a commit hook | `claimService`, `discovery`, `discoverySignals`, `reporting`, `stateCommit`, `tickRun` | 18 |
| `tickRun.ts` | `tickSlice` (with `tickAdmission`) | `authHealth`, `channelPoints`, `claimService`, `discovery`, `discoverySignals`, `heartbeat`, `kickRuntime`, `manualWatch`, `reporting`, `stateCommit`, `tickAdmission`, `twitchIntegrity` | 1 |
| `discovery.ts` | its own `discoverySlice`, `lifecycleSlice` (read) | `reporting`, `stateCommit` | 17 |
| `heartbeat.ts` | its own watchers, heartbeat lanes, generation high-water marks and publication leases, and the watch job (#586), `lifecycleSlice` (read) | `discovery`, `reporting`, `stateCommit`, `tickAdmission` | 7 |
| `twitchIntegrity.ts` | its own state (lifecycle generation, persisted token, refresh due, the startup load; #589), `lifecycleSlice` (read), the tab registry's token | `reporting`, `settingsTransitions`, `stateCommit` | 12 |
| `channelPoints.ts` | its own push slot, claim gate and push-claim queue (#590), `lifecycleSlice` (read), a commit hook | `reporting`, `stateCommit`, `tickAdmission` | 12 |
| `kickRuntime.ts` | its own challenge claim gate, claim operations and job reschedule queue (#588), `lifecycleSlice` | `reporting`, `stateCommit` | 9 |
| `authHealth.ts` | its own refresh generations (#595) | `discovery`, `discoverySignals`, `reporting`, `stateCommit` | 5 |
| `manualWatch.ts` | the watch-tab effect handlers (#591), `lifecycleSlice` (read) | `discovery`, `reporting`, `stateCommit`, `tickAdmission` | 9 |
| `supplementalSources.ts` | the supplemental target effect handler (#591) | none | 1 |
| `claimService.ts` | its own handoffs, waiting reward ids, drop-claim operations, reward claim guards and job reschedule queue (#597), `lifecycleSlice` | `heartbeat`, `lifecycle`, `reporting`, `stateCommit`, `tickAdmission` | 13 |
| `discoverySignals.ts` | `signalSlice`, `lifecycleSlice` (read), a commit hook | `reporting`, `tickAdmission` | 13 |
| `settingsTransitions.ts` | the transaction, `settingsSlice` (the Twitch settings-transition generation), `lifecycleSlice` (read) | `channelPoints`, `claimService`, `discovery`, `discoverySignals`, `kickRuntime`, `lifecycle`, `stateCommit`, `tickAdmission` | 8 |
| `lifecycle.ts` | `lifecycleSlice` | `authHealth`, `channelPoints`, `claimService`, `discovery`, `discoverySignals`, `heartbeat`, `kickRuntime`, `reporting`, `settingsTransitions`, `stateCommit`, `tickAdmission`, `twitchIntegrity` | 9 |
| `messages.ts` | none: a routing table, one entry per runtime message (#591) | `claimService`, `discovery`, `manualWatch`, `reporting`, `settingsTransitions`, `tickAdmission` | 1 |

Each module changes only its own state (#591). Where another module needs to change it, the
owner provides a narrow method: tick admission's `trackBackgroundWork`, `suspendTickAdmission`
and `discardStalePendingTick`; discovery's `invalidateDiscoveryLane`, `recordDiscoveryEvent` and
`drainDiscoveryEvents`; discovery signals' `setDiscoverySignalPlatformBlocked` and
`takeAllowedDiscoverySignalRefresh`; settings transitions' `beginTwitchSettingsTransition`. Reads go
through queries too (`discoverySnapshot`, `selectionGeneration`, `platformTickRunning`,
`currentTwitchSettingsTransition`, `settleRouteReports`). The one slice still read directly is
`lifecycleSlice`, for its shutdown and observer flags. `tickSlice` belongs to the tick coordinator,
which is `tickAdmission.ts` and `tickRun.ts` together (#587).
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
| Selection (`selectionCache`, `selectionRuns`, `pendingSelections`, `selectionGeneration`) | In memory | `prepareSelection` (before the lock), `reselectUnderLock` (inside it, never through `selectionRuns`) | `invalidateSelection`: every settings save (including ranking-only), auth invalidation, heartbeat results, playback telemetry, reset, shutdown | Consumed inside `runTick`'s platform lock | Recomputed | Both |
| Tick admission (`tickAdmission`, `activeTicks`, `tickBatches`, `backgroundWork`) | In memory | `tick`, `tickInBackground`, `tickAndHandOff` | Disable, reset, shutdown | None | Empty | Both. Extension alarms and CLI intervals request ticks per platform |
| Heartbeat lanes, watchers and publication leases (`heartbeatLanes`, `tablessWatchers`, private to `heartbeat.ts` since #586) | In memory, with the heartbeat cadence persisted in the session | `requestPlatformHeartbeat`, `reserveTablessWatchers` (inside the tick lock) and its `publish` (after the commit), restart recovery, `commitHeartbeatResult` | Session changes, `clearHeartbeatOwnership`, shutdown | `withHeartbeatLane`, which never spans watcher I/O (#586), then a transaction commit **without** the platform lock | `reconcileStartup` releases ownership on both hosts | Both |
| Discovery-signal controllers (`discoverySignalSlots`, one `ObserverSlot` per platform, gated by `lifecycleSlice.observersOpen`; a failed start is stopped and cleared, and the next tick starts a fresh observer) | In memory | The discovery-signal service's `onTickConcluded` hook (after a tick commits, against the committed state; a stop since the commit bumps the slot's epoch, so the observer backs off) | Auth transitions, tab removal, settings, reset, shutdown | None | Recreated by the next tick | Both, when the adapter provides a factory |
| Auth health (`authHealth`; the service's refresh generations) | Health persisted, generations in memory | `probeAuthHealth`, `refreshAuthHealth`, `persistAuthHealth`, `invalidateAuthHealth` | A newer refresh generation | `persistAuthHealth` under the platform lock, then a transaction commit; dependents react from their commit hooks (#595) | Health reloaded, then re-probed | Both. Credentials come from cookies (extension) or the credential store (CLI) |
| Manual watch (`manualWatch`, `manualWatchTabs`, `manualClosePause`, playback telemetry) | Persisted | `recordPlaybackTelemetry`, `handleTabUpdated`, `handleTabRemoved`, `resumeAfterManualClose` | Tab events, resume, TTL | Platform lock; dependents react from their commit hooks (#596) | Reloaded | Extension only; the CLI has no tabs |
| Settings (`twitchSettingsTransitionGeneration`) | Settings persisted, transition generation in memory | `commitSettings` (every popup write, `updateIdleWatchlist`), `normalizeStartupSettings` | Each settings commit. Its per-platform effect decides: `selection` (ranking-only, `isRankingOnlyPatch`) keeps discovery, `discovery` invalidates both | The transaction's settings lock | Reloaded and migrated (schema v7) | Both. The CLI's `saveSettings` is a no-op |
| Page contexts and Kick recovery evidence | The controller's tab registry (`createTabRegistry`, one per controller; the extension host passes the one its tab mechanics write to), mirrored in persisted `managedPageContextTabs`. Recovery evidence in the extension host (`kickPageContextRecovery`) | The Kick runtime's `releasePageContexts` effect handler (#588), `registerManagedPageContextTabs`, host fetch fallbacks | Release, reset, restart without auto-start, removal of the context's tab (forgotten whoever closed it, without pausing; #588) | Copied into `SchedulerState` by the tick driver (`runSchedulerTickEffects`), never by the deciding code | Re-registered at startup when farming auto-starts | Extension only |
| Claim operations (the claim service's drop-claim operations, waiting reward ids and handoffs, the Kick runtime's challenge claim operations, the channel-points service's claim operations, push-claim queue and push observer) and claim guards (the claim service's `RewardClaimGuard`s, the Kick runtime's `KickChallengeClaimGate`, the channel-points `ChannelPointsClaimGate`) | In memory. Claimed rewards are persisted through `campaigns` | Ticks, claim jobs, `claimRewardNow`, `runClaimHandoff`, the push | Disable, auth loss, reset, shutdown, `abortClaimHandoffs` at startup | None for the request: the tick (#599), the drop-claim job and manual claims (#597), the channel-points job and push (#590) and the Kick challenge job (#588) claim with no lock, then commit their result onto the latest state under the platform lock. The guards keep one request per reward, one Kick challenge claim and one channel-points claim in flight across every path | In-flight work is lost; provider inventory is re-read | Both, but manual-watch claim jobs never fire on the CLI |
| Twitch integrity (the token, the persisted token, the lifecycle generation) | The integrity service's own state (#589). The token has one in-memory copy, in the tab registry, with the capture waiters and in-flight acquisition; the service is its only writer; the token is also persisted through `saveTwitchIntegrity` | Header capture, refresh, and Twitch's enabled flag from any settings save (#589): a save that disables Twitch cancels a mint in flight and holds off integrity work until it ends, and a serialized reconcile after it follows the stored flag, so a failed save needs no rollback | A newer lifecycle generation, and for persistence a host reset | The service's own lanes, no controller lock (#589): token bookkeeping, then the refresh alarm. A schedule re-checks it owns the lifecycle inside the alarm lane, where a disable's clear also runs | Token reloaded from storage | Extension only |
| Compatibility reporting (`reportedCompatibility`, route reports) and `campaignEvaluationFingerprints` | In memory | Adapter construction, ticks | Never, within a process | None | Reported again | Both |
| Host jobs | The job scheduler port: `browser.alarms` (extension), Node timers (CLI) | `ensureCadenceJobs`, `rescheduleTickJobs`, each service's reconcile and reschedule, integrity scheduling | Settings changes, disable | After the settings lock is released, from the latest stored settings; the integrity alarm has its own lane (#589) | Alarms survive a service-worker restart; the CLI re-ensures its cadence jobs on start | Both; jobs whose capability a host lacks are inert (#593) |
| Twitch Extensions host (`generation`, `knownComplete`, `completedUntil`, `unavailableUntil`, summaries) | In memory in `packages/extension/src/extensions/host.ts`; the completion and cooldown deadlines are also stored under `twitchExtensionLane` in local storage (#594) | The host's reconcile loop | The controller's accepted commits, through the lane's commit hook (`src/extensions/commitHook.ts`, #594): Twitch state commits and settings commits that are not ranking-only | Outside the controller | Deadlines restored from `twitchExtensionLane`, validated and with expired entries dropped; summaries and sessions are re-acquired | Extension only |

### Locks and queues

All of these are promise chains: `run = previous.then(operation, operation)`.

| Lock | Protects | Notes |
| --- | --- | --- |
| `withSettingsLock` | Settings read-modify-write | Jobs are rescheduled after it is released (#590, #597, #588) |
| `withStateLock(operation, platforms)` / `withPlatformLock` | One platform's scheduler state and in-memory lifecycle | Takes each requested platform in the fixed order Twitch → Kick |
| Commit lock (inside `commit`, `commitPlatformSnapshot`, `readState`) | The global load → merge → save of `SchedulerState` | Private to the transaction; only a storage load and save run under it |
| `withHeartbeatLane(platform)` | One platform's watcher, heartbeat reservations and publication leases | Independent of the platform lock. Holds only in-memory bookkeeping: watchers start and stop outside it (#586) |
| `withTwitchIntegrityAlarmLock` | Creating and clearing the integrity refresh alarm | Taken inside the settings and platform locks |
| Discovery lanes | One refresh per platform, with a coalesced follow-up | Not a lock on state |

Nested acquisition orders found in the code, and none in the reverse direction:
- settings → platform: `runTwitchIntegrityRefresh`, `prepareForHostReset`
- settings → commit: each discovery refresh reads settings and state together (`createDiscoveryLane`)
- platform → commit: `persistPlatformState` and `persistAuthHealth` under `withStateLock`
- platform → heartbeat lane: `runTick` → `reserveTablessWatchers`, in-memory bookkeeping only
- settings or platform → integrity alarm lock

Heartbeat results commit through the transaction without the platform lock. That is what keeps a
due heartbeat independent of a long tick.

### Work performed while a lock is held

None, since #586, and with no exceptions: #584's allowlist of v1.14.0 sites was emptied by the
v1.15.0 issues and deleted in #591. `lockedIo.test.ts` fails if a provider, tab or timer call
appears inside a lock, and the runtime lock tracker fails any guarded port called while one is held.

- **Scheduler tick:** none since #599. Its effects (claims, Kick challenges, channel points, watch
  tabs, page-context release, Twitch Extensions supplemental selection) run between `runTick`'s two
  platform-lock sections, with no lock held. See "Scheduler tick effects" below.
- **`runTick` itself**, before publishing: none. It reserves the tabless watchers inside the lock
  and publishes them first thing after the commit, with no lock held (#586; see "Tabless heartbeat
  coordinator" below). The discovery-signal observers (#587) and the channel-points push (#590) are
  reconciled after the commit, with no lock held. When the selection prepared before the lock
  no longer matches, the tick re-selects inside the lock with `reselectUnderLock`, which evaluates
  straight over the discovery snapshot: it never joins another tick's selection run or goes
  through the testing selection hook, so it is not locked I/O (#587).
- **Heartbeat lane:** none. Restart recovery reserves the lane, starts its watcher with no lane
  held, and publishes it only if the reservation is still the lane's (#586).
- **Claims outside the tick:** none. `claimRewardNow` and the drop-claim job (`runDropClaims`, which
  also refreshes campaigns) claim with no lock held and commit their result onto the latest state
  (#597). The Kick challenge job commits only its poll stamp (#588).
- **Timers under the settings or platform lock:** none. The tick jobs (#593), the channel-points job
  (#590), the drop-claim jobs (#597) and the Kick challenge job (#588) are rescheduled after the
  settings lock is released, from the latest stored settings. The Twitch
  integrity refresh alarm is scheduled on the integrity service's own lane (#589).

Event reporting (`reportBestEffort`, `persistAndReport`) and notifications still run inside the
platform locks, but only after the commit that carries them has been accepted (see below).

### Commits, locks and publication (#585)

`stateTransaction.ts` is the one owner of storage writes. The controller modules commit through it
and never take the commit lock or call `saveState` themselves.

- **Lock order:** settings → Twitch → Kick → heartbeat lane → commit. Acquire in this order only.
  Only a storage load and save run under the commit lock; no lock may be held across provider, tab or
  timer I/O, with no exceptions (#591).
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
  not rely on storage change events, which the CLI does not have. Hooks queue per platform: a state
  commit's hooks run in commit order behind earlier commits to the platforms it wrote, and a
  settings commit's behind every platform's, so a Twitch hook that is still stopping an observer
  never holds up Kick. `settleCommitHooks(platforms)` waits for them.
- **Auth transitions (#595)** are commits. The channel-points push (and its job and push claims)
  and the discovery-signal observers stop from their own commit hooks when the commit leaves the
  platform's auth unhealthy. A hook acts on the commit it observes even if auth was restored since,
  so an account change (invalidate, then a healthy recheck for the new viewer) always ends the old
  viewer's work; an observer restarted in between is started again by the next reconcile. No
  dependent needs a synchronous auth answer yet, so the service exposes no readiness query. The host's `invalidateAuthHealth` and `checkAuthHealth`, and a tick
  after its auth refresh, wait for the platform's hooks, so the stops still finish first. The
  auth service does not reference its dependents; it still closes discovery-signal admission
  synchronously on invalidation (`reserveDiscoverySignalAuthRefresh`), which must happen before its
  first await and so cannot wait for a hook. The Twitch Extensions lane (#594) moves onto hooks
  next; #594 replaces the extension host's `storage.onChanged` diffing, and
  its Twitch-cookie `forgetCompletion` wrapper, with a hook on its settings and Twitch state
  changes.
- **Manual watch (#596)** is a pure query, `recentManualWatch` / `hasRecentManualWatch` /
  `pausedForManualWatch` in `core/manualWatch.ts`, that the scheduler, the claim jobs, channel
  points and the Twitch Extensions host read; only the manual-watch service writes the records.
  The service refuses telemetry from a tab that was removed, whoever closed it, so a
  late report cannot bring back the manual watch the close ended. Its commits reach dependents through hooks: tick admission ticks a platform whose
  manual watch started or ended, judging both sides at the commit's `committedAt`, and the
  discovery-signal observer stops when a commit takes its session from watching to anything else
  (a manual tab close pausing it). Ad focus on telemetry follows the committed session after the
  lock is released, and is skipped once a host reset or shutdown has closed the observers. The tab
  events and playback telemetry resolve once the platform's hooks have run.
- **Settings reactions (#695)** are hooks too. A settings commit's `CommittedChange` carries the
  saved `patch`, each platform's effect and a `startup` flag. Each service reacts to the save from its
  own hook, after the save:
  - claims abort the claim-only work the settings made ineligible, and a patch that switches a
    platform off ends its post-claim handoff;
  - the Kick runtime and channel points abort their ineligible challenge and channel-points claims;
  - discovery signals follow a patch that switches a platform off or on: blocked and stopped, or
    unblocked.

  Hooks run in registration order, which `createBackgroundController` fixes: heartbeat, channel
  points, the Kick runtime, claims, discovery signals, tick admission, then the host's own hooks
  (the extension's Twitch Extensions hook). The startup reconcile's save (`normalizeStartupSettings`)
  is marked `startup`, and services ignore it: startup is a host event that `lifecycle.ts` brings up
  itself. Shutdown and reset are host events too, so `lifecycle.ts` still calls every service
  directly, as the facade's host-facing wiring.

  `commitSettings` does not wait for these hooks. A commit's hooks wait for every operation queued
  on the settings lock when it committed, so a save that waited for its own hooks would deadlock
  with a caller's next save. The platform switch waits for the platform's hooks once its own
  transition is known to be current, before its follow-up tick, so that tick reconciles the
  observer with the block already lifted.

  These calls stay in the settings lock, before the save is visible, on purpose:
  - **Discovery and selection invalidation** (`invalidateDiscoveryLane`, `invalidateSelection`): a
    tick that reads the new settings must never select from discovery or a selection made under the
    old ones. The same synchronous invalidation runs where auth is invalidated, where a heartbeat
    outcome changes selection (in its commit's `afterSave`) and where playback telemetry changes
    health.
  - **Pending-tick cancellation** (`cancelPendingTick`) for a platform the save left switched off: as
    a hook it could also discard a trigger requested after the save, such as the platform switch's
    own follow-up tick.
  - `markPlatformsStarting` stays with the platform switch, guarded by the switch's transition
    check (below).
- **Platform policy (#696).** Settings transitions and tick coordination are platform-neutral: no
  Twitch or Kick decision, which `engineBoundary.test.ts` enforces for `authHealth.ts`,
  `stateTransaction.ts`, `stateCommit.ts`, `tickAdmission.ts`, `tickRun.ts`, `tickCommit.ts`,
  `tickEffects.ts` and `settingsTransitions.ts`. Platform-keyed data (`PLATFORMS` loops, lock and
  lane tables) is allowed. A platform's own service registers its policy in the controller's
  `PlatformPolicySlice`, and only Twitch integrity registers any:
  - **Tick readiness:** before a tick farms Twitch, integrity prepares its token; a platform that
    is not ready is kept out of the tick.
  - **Switch transition:** integrity owns the Twitch switch's transition generation. A later switch,
    shutdown or reset supersedes it, and the switch stops before marking the platform starting or
    ticking once it is not current. A platform with no transition is always current.
  - **Settings-commit participant:** a service that must take part in a settings commit, not only
    react to it. Integrity joins every commit before the lock (holding off its work when the
    caller's intent disables Twitch), again in the lock before the save (holding off when the
    commit disables Twitch), and ends its turn after the settings jobs are rescheduled (or after
    the save failed). It then reconciles its lifecycle and schedule if Twitch's enabled flag
    changed, or if a held disable failed to save, and releases the hold. A hook would run too late
    for the hold, and could not tell which save's hold to release.
- **Tick conclusions (#695).** The discovery-signal observers and the Twitch channel-points push
  follow each tick from their own `onTickConcluded` hooks, not from calls in `tickRun.ts`. A tick
  that commits its decision (accepted, or found already stored) builds a `TickConclusion` under
  its platform lock, with the committed state, its settings and adapters, its signal and each
  observer's epoch as of the commit. It publishes the conclusion once its other follow-ups
  (heartbeat publication, ad focus, the cycle observation) are done. The hooks queue on the
  platform's lane behind every commit hook queued so far, so a stop committed in the meantime runs
  first and bumps the epoch the reconcile then backs off from. A superseded or failed tick
  concludes nothing. A hook starts its reconcile and hands the promise back
  (`TickConclusion.follow`) instead of awaiting it, because an observer opening its socket must not
  hold up later hooks on the lane. The tick waits for those promises, as it waited for the
  reconcilers it used to call itself. Conclusions are a separate registry from `onCommit`: a tick
  whose commit writes nothing still concludes, while an unchanged commit notifies no commit hook.

The test suite enforces the model. The characterization and contract harnesses give the controller
a lock tracker (`tests/helpers/lockTracker.ts`, backed by `AsyncLocalStorage`) and guard every
provider, tab and timer port. A test fails when a lock is taken out of order, a commit nests in a
commit, or a port is called while a lock is held. The lock queues are written with `await` and a
release promise rather than `.then()` chains, so the tracker's `AsyncLocalStorage` context and the
violation's async stack trace follow the operation. `stateTransaction.test.ts`
covers the rules themselves, including an unlisted call site failing and hook ordering.

### Scheduler tick effects (#599)

The scheduler tick decides; it performs nothing. `decidePlatformTick` (`core/scheduler.ts`) is an
async generator per platform. Its inputs are plain values: the state and settings, the committed
discovery (`complete`, or incomplete and possibly `discarded`), the prepared selection, an in-memory
view of the discovery snapshot to select channels from (`selectionAdapterFromDiscoverySnapshot`),
and declared capabilities (tabless, Kick challenges, channel points). It never calls an adapter, a
port or the tab module. Each side effect it needs is yielded as a typed `SchedulerEffect`:

| Effect | Owner and handler |
| --- | --- |
| `claimRewards` | The claim service (#597): `registerRewardClaimEffect`, which runs `claimReadyRewards` (`core/rewardClaims.ts`) with the `RewardClaimGuard`s it shares with the drop-claim job and manual claims |
| `claimChannelPoints` | The channel-points service (#590): `registerChannelPointsClaimEffect` |
| `claimChallenges` | The Kick runtime (#588): `registerKickRuntimeEffects`, which shares its `KickChallengeClaimGate` with the job |
| `openWatchTab`, `stopWatchTab` | Manual watch (#591): `registerWatchTabEffects`, through the host's `WatchTabPort` (`tabs.watch.open` / `stop`). Without the port, opening throws and stopping does nothing |
| `releasePageContexts` | The Kick runtime (#588): through the host's `PageContextPort` (`tabs.pageContexts.release`), or only forgetting the contexts without one |
| `selectSupplementalTarget` | `supplementalSources.ts` (#591): `registerSupplementalTargetEffect`, through the host's supplemental-sources port, for Twitch only |

The yielded effects in order are the tick's plan. It is produced incrementally rather than returned
at once, because later decisions depend on earlier results. A claim can satisfy the next reward's
precondition, which the same tick then selects. A new tab is closed again if the selection went
stale while it opened. A failed effect is thrown back at its `yield`, so the tick's own `catch`
still decides what it means: an authentication error suspends the platform and a watch-tab failure
is a `platform_error` with backoff. `EffectExecutor` (`core/effectExecutor.ts`) maps each effect
type to exactly one handler and throws when a second one registers. `createTickEffectExecutor`
starts empty: each owning service registers its handlers, binding the host ports they use, and the
tick composes them once per controller. No interim handler remains (#591).
`runSchedulerTickEffects` drives the platforms in order, running each yielded effect through the
executor, and mirrors the page contexts and managed-tab breaker of the controller's tab registry around them. The deciding
code never touches either.

`runTick` runs a tick in four steps:
1. **Under the platform lock:** read the settings and state, and settle the prepared selections.
2. **With no lock held:** run the tick and its effects. Telemetry, heartbeats, tab events, claims
   and auth transitions commit meanwhile rather than queueing behind the tick.
3. **Under the platform lock again:** rebase the result on the stored state (`rebaseTickState`,
   `tickCommit.ts`), then reconcile watchers and observers and publish, as before.
4. **With no lock held again (#598):** apply ad focus for the committed sessions, and hand the
   cycle's outcome (`TickCycleOutcome`: committed with the platforms whose discovery completed, or
   a persisted failure) to `observeTickCycle`. The Kick runtime (#588) runs page-context recovery
   from it: direct successes count only for a committed cycle whose discovery completed and whose
   session has no error checks. It re-reads the latest state under the platform lock before it
   persists a changed page context. Every tick ends with `endTickCycle`, which drops route evidence
   no committed cycle took, so the tick commit path has no Kick-specific branch. Host reset works the same way: it clears the registry and
   storage under its locks, then closes the tabs the old state held.

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
records the rewards the tick claimed, its Kick challenge poll stamp (newest wins, #588) and the
managed tab it closed. A tab only the dropped decision
opened is closed after the lock is released. A conflict also requests a `tick_superseded` follow-up
tick, which re-selects from the discovery already held. An aborted tick (reset, shutdown) records
nothing, as before.

With the tick unlocked, the claim jobs no longer queue behind it, so every claim path reserves first
and skips while another path holds the reservation: rewards per id (`RewardClaimGuard`: the tick, the
drop-claim job and `claimRewardNow`), and one Kick challenge claim and one channel-points claim at a
time. A channel-points push names one specific claim, so it waits for a running claim instead of
skipping, as it used to wait behind the tick's lock. The channel-points job and push claims take no
lock either (#590): one `ChannelPointsClaimGate` covers the tick, the job and the push, and push
claims run one at a time from their own queue, so a job fire during a tick's claim sends nothing and
Twitch farming never waits on a claim. An aborted tick starts no further effect:
`driveEffects` checks the tick's signal before each one. The in-tick `refreshCampaigns` fallback is gone: discovery reaches the tick only through the
committed snapshot lane.

### Claim failure model (#597)

There is no local claim journal: the provider's inventory is the source of truth. Recording a claim
intent before sending would not help, because after a crash the engine still could not tell whether
the request reached the provider.

- **Within one process**, the claim service's `RewardClaimGuard`s allow one request per reward
  across overlapping ticks, manual claims, the drop-claim job and the handoff loop. A reward whose
  claim succeeded stays reserved until its claimer's commit has landed, however that ends (the tick
  releases its rewards when it ends, committed, superseded or aborted), since until then storage
  still shows it claimable to everyone else. Every path sends with no lock held and then commits its
  result onto the latest state:
  `preserveClaimedRewards` keeps a claim another path committed meanwhile, and a manual claim marks
  only its own reward.
- **Cancellation:** disabling claims, a reset or a shutdown aborts the drop-claim job's runs and
  the post-claim handoff, and so does a commit that leaves the platform's authentication unhealthy
  (an after-commit hook). A claim cancelled before it was sent records nothing. A claim the provider
  had already accepted is still committed and published once, except on shutdown or reset, which
  write nothing; the inventory re-read then records it. Ticks are aborted only by shutdown and reset.
- **Across a restart**, the process may have stopped after the provider accepted a claim and before
  the state was saved. On restart the reward is still unclaimed locally and nothing was published
  for it. The next discovery re-reads the provider's inventory before any claim runs. A reward the
  provider reports as claimed is no longer claim-ready, so no request is sent, and it is recorded as
  claimed without publishing activity.
- **If a reward is sent again anyway** (inventory still stale), it depends on the platform:
  - **Twitch:** Twitch answers `DROP_INSTANCE_ALREADY_CLAIMED`, which `claimReward` treats as
    success, so the claim publishes its activity and notification once, from the new process.
  - **Kick:** Kick's answer to a duplicate claim has not been observed. Since #606 a definitive 4xx
    from `drops/claim` is rethrown from the background transport without a page-tab retry, and
    `claimReward` classifies it as `link_required` only when `campaign.accountLinked === false`;
    otherwise it is a claim failure. Record the observed response here once seen.

### Tabless heartbeat coordinator (#586)

`heartbeat.ts` owns each platform's tabless watcher, heartbeat lane, generation high-water mark and
publication lease, and the watch job both hosts fire. No lock is held while a watcher starts, stops
or sends a heartbeat.

- **The watch job's period follows the watchers.** It runs every minute, the health commit cadence.
  While a published watcher has a `sustain` poll (Twitch HLS) it runs every 30 seconds, so a
  suspended service worker still polls between commits; a wake that is not due for a commit runs
  only that poll. The period is re-ensured only when it changes, because ensuring restarts it.

- **Ticks reserve, then publish.** Inside its platform lock, a tick calls `reserveTablessWatchers`.
  That only does in-memory work: it allocates a new context's generation, stamps the cadence on the
  session the tick commits, constructs the watcher (no I/O) and takes a publication lease. After
  the commit, before any other follow-up, the tick publishes: it starts the new watcher, makes it
  the lane's context if the lease is still the lane's, and stops the one it replaced. A tick that
  does not commit, or is aborted, releases the reservation and starts nothing.
- **While a lease is pending**, heartbeats and restart recovery wait for it. A result for the
  context it replaces is stale at once, so it never waits on the tick's commit.
- **Restart recovery** reserves the lane, starts its watcher with no lane held, and publishes it
  only if nothing replaced the reservation meanwhile. A recovery that lost to a tick or to ownership
  cleanup stops its own watcher.
- **Tab fallback.** `fallsBackToTab` is the rule: a host with browser tabs, a session that is not
  tabless-only supplemental, and failures at `tablessFallbackFailureLimit`. When a watch-job
  heartbeat's failing result commits past it, the coordinator's commit hook checks that the context
  still owns the lane and the stored session, then ticks the platform in the background
  (`tabless_fallback`). The tick moves the watch to a tab through the watch-tab port. The job ends
  once the hook has run. A post-claim handoff's immediate heartbeat leaves the fallback to the next
  job or tick, as before.

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
| `tabs` (`watch`: `WatchTabPort`, `pageContexts`: `PageContextPort`, which also carries page-context recovery), `tabRegistry` | Browser tabs. Watch tabs are the host's, not `PlatformAdapter`'s (#598) | Absent: every watch is tabless |
| `twitch.integrity` | Page capture | Absent |
| `twitch.supplementalSources` | Twitch Extensions host (#587 adds `prepare`) | Absent |

Each host passes a static `capabilities` object (`EXTENSION_CAPABILITIES`, `CLI_CAPABILITIES`),
written by hand. `createBackgroundController` throws `HostCapabilityMismatchError` when a
capability's ports are present without the capability or the other way round, so a missing port
never switches a feature off silently. A setting that needs a capability the host lacks
(`tablessMode: false` or `pauseOnManualWatch` without browser tabs) is reported once per
controller as an English diagnostic, with no platform, and changes nothing else.

Without `browserTabs`, the watch surface is derived rather than configured: the tick passes
`watchTabs: false` in each platform's `PlatformTickCapabilities`, so the scheduler always watches
tabless, and heartbeat failures never fall back to a tab. Neither do a tabless-only supplemental
session's (Twitch Extensions), on any host: the heartbeat coordinator owns both rules
(`fallsBackToTab`), and the scheduler always watches such a session tabless. The scheduler's
no-progress check still rotates a channel whose watch accrues nothing. The CLI accepts a config
that sets `tablessMode` and ignores it with a warning.

The job scheduler port is the only way the engine schedules work. `jobs.ts` documents its
semantics, and both implementations keep them: a minimum period (`MIN_JOB_PERIOD_MINUTES`), ensure
replaces a job and restarts its period, cancel is idempotent, a one-shot job is gone once it fires,
a suspended host fires once on wake rather than once per missed period, and a job can fire again
while its last run is still going, so the services coalesce their own runs (tick admission,
heartbeat lanes). Alarms survive a service-worker restart; Node timers do not, so the CLI
re-ensures its jobs on every start, through the startup reconciliation below.

`BACKGROUND_JOBS` lists every job and the capability it needs. A job whose capability the host
lacks is inert: ensuring it schedules nothing and a fire of it does nothing. On the CLI that covers
the manual-watch claim jobs and Kick challenges (browser tabs) and the integrity refresh (integrity
capture). The one-minute channel-points job runs on both hosts (#590); the CLI used to claim channel
points only at poll cadence. The
host delivers fires to `controller.runJob(name)`. Since #591 that includes the CLI's tick jobs: it has
no tick driver of its own. A disabled platform's tick cleans up its state, as it always did on the
extension, and logs "Platform disabled" once, when it becomes disabled. The CLI logs subscription
waits from an after-commit hook, and once at startup for waits already stored.

Both hosts run one restart reconciliation, `reconcileStartup`, when their process starts: the
extension on browser startup (inside `handleStartup`), the CLI on every process start before its
first heartbeat and ticks. It aborts claim handoffs, re-ensures the jobs, releases the heartbeat
ownership the previous process held, pauses the sessions it left watching (`runtime_restart`),
releases its tabs, and normalizes the settings. It does not resume farming: the extension's
`handleStartup` then ticks (or refreshes auth health), and the CLI fires its tick jobs. The
CLI pins `autoStartDropFarming` to true, since it always resumes its enabled platforms and the
reconciliation would otherwise switch them off. Before #593, a CLI restart skipped all of this and
let heartbeat recovery resume the previous watch from its persisted cadence.

### Characterization coverage

v1.15.0 extractions must keep these tests passing without editing their assertions, except in a PR
labelled `behavior-change`. `controllerContract.test.ts` runs its cases once per declared host
capability set (`EXTENSION_CAPABILITIES` and `CLI_CAPABILITIES`, through
`tests/helpers/controllerContract.ts`), against fake ports. The extension set runs the extension's
real browser-tabs ports (`createExtensionTabPorts`) against a fake browser tab API
(`tests/helpers/fakeBrowser.ts`), so the wiring between the tab mechanics and the controller is
tested too (#598).

| Invariant | Where it is tested |
| --- | --- |
| One active tick and one shared follow-up per platform; Twitch and Kick progress independently | `controllerContract.test.ts` (both hosts); `backgroundController/tickAdmission.test.ts` ("coalesces same-platform ticks…", "admits one Twitch tick and one follow-up…"); `backgroundController/stateCommit.test.ts` (the "lets Kick … while Twitch …" cases) |
| `ranking_changed` re-selects without rediscovery and loses to any trigger that needs fresh discovery | `controllerContract.test.ts`; `backgroundController/settingsTransitions.test.ts` ("reordering what is farmed") |
| Cancelled work publishes no state or activity | `controllerContract.test.ts` (shutdown); `backgroundController/lifecycle.test.ts` ("aborts in-flight scheduler work…"); `backgroundController/reporting.test.ts` ("route evidence independent of state publication") |
| Stale discovery, selection and heartbeat work cannot overwrite newer state | `backgroundController/heartbeat.test.ts` ("rejects a stale heartbeat…", "persists discovery after a due heartbeat invalidates a blocked snapshot selection", "does not let a stale … removal …") |
| Heartbeat due time is independent of ticks | `backgroundController/heartbeat.test.ts` ("tabless heartbeat cadence", "lets Kick heartbeat and persist while Twitch heartbeat is still pending") |
| Tabless watchers start, beat and stop with no lock held; a tick commits before its watcher starts, and a reservation that does not commit, or a restart recovery that lost to one, starts nothing it keeps (#586) | `controllerContract.test.ts` ("starts, beats and stops tabless watchers with no lock held", both hosts); `backgroundController/heartbeat.test.ts` ("commits a tick while a restart recovery's watcher start is blocked…", "releases its reservation when the tick does not commit…", "starts nothing when shutdown lands…") |
| Manual managed-tab closure | `backgroundController/manualWatch.test.ts` ("manual-watch event transitions", "clears manual watch activity when the source tab is closed") |
| Service-worker restart | `backgroundController/lifecycle.test.ts` (the startup cleanup cases); `backgroundController/heartbeat.test.ts` ("serializes service-worker restart recovery…"); `controllerContract.test.ts` (extension host) |
| CLI process restart: the same reconciliation as the extension (#593) | `controllerContract.test.ts` (both hosts, "process restart"); `packages/cli/tests/run.test.ts` ("pauses the previous process's watch at startup…") |
| Job registration: the CLI registers its tick and heartbeat jobs and the one-minute channel-points job (#590); inert jobs are never scheduled or run | `controllerContract.test.ts` ("jobs") |
| Duplicate and late job fires coalesce; no job runs after shutdown | `controllerContract.test.ts` ("jobs") |
| Job scheduler semantics on each host | `hostPorts.test.ts` (`browser.alarms`); `packages/cli/tests/jobs.test.ts` (Node timers) |
| Declared capabilities match the ports; unsupported settings are reported once | `hostPorts.test.ts`; `controllerContract.test.ts` ("capabilities") |
| Without browser tabs every watch is tabless and heartbeat failures never fall back to a tab | `controllerContract.test.ts` ("watch surface") |
| Only a user close of the watch tab pauses; the extension's own closes (finished campaign, restart) do not, and late playback from a closed tab is ignored | `controllerContract.test.ts` ("browser tabs", extension host) |
| The CLI's `state.json` save is atomic | `packages/cli/tests/storage.test.ts` |
| The popup reads the stored settings and state verbatim | `controllerContract.test.ts` ("runtime snapshot") |
| Campaign ranking and #571's selection rules (mid-reward takeover, favourites, discarded refresh hold, just-armed watch) | `ranking.test.ts`, `rankingSettings.test.ts`, `scheduler.test.ts`, `watchSourceScheduler.test.ts` |
| `updateIdleWatchlist` keeps a concurrent popup change | `backgroundController/settingsTransitions.test.ts` ("Idle Watchlist changes from the page") |
| Supplemental lane: tabless only, released on completion or manual pause | `supplementalWatch.test.ts`, `twitchExtensionHost.test.ts` |
| Supplemental lane: completion forgotten on restart (current behavior; #594 changes it) | `twitchExtensionHost.test.ts` ("forgets completion when a new host starts…") |
| The scheduler tick decides from plain inputs and names its effects; one handler per effect type | `schedulerEffects.test.ts` |
| A tick's effects run with no lock held; concurrent telemetry is kept, a contradicting writer drops the decision but not the claims or tabs it produced, and an overlapping claim is requested once (#599) | `backgroundController/tickEffects.test.ts`; `tickCommit.test.ts` |
| No I/O while a lock is held, with no exceptions (#591) | `lockedIo.test.ts` (source scan); `tests/helpers/lockTracker.ts` (runtime, every harness) |
| No import cycles between engine modules, no Twitch/Kick branches in the facade, no browser-tab code outside the extension (#591) | `engineBoundary.test.ts` |
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

### Engine ownership at a glance

The background engine (`@lurkloot/core`, `background/`) is a set of owned services behind a thin
facade (#583, #591). "Background controller ownership and concurrency" above has the detail.

- **Ownership.** `controller.ts` only composes the services and routes host entry points. Each
  service (tick coordination, heartbeat, auth health, manual watch, claims, Twitch integrity,
  channel points, the Kick runtime, supplemental sources) changes only its own state. Others use
  its queries, or react to its commits and to tick conclusions through their own hooks (#695). The
  calls that must stay in the committing operation, such as selection invalidation before a
  settings save is visible, are listed under "Settings reactions". Host events (startup, shutdown,
  reset) are wired directly in `lifecycle.ts`. Each scheduler effect type has exactly one handler,
  registered by its owner.
- **Concurrency (#585).** One transaction owns every storage write. Locks are taken in the order
  settings → Twitch → Kick → heartbeat lane → commit, and no lock is ever held across provider,
  tab or timer I/O. Stale or cancelled work publishes neither state nor activity.
- **Claims (#597).** A claim is sent with no lock held and committed onto the latest state. A
  reward stays reserved until that commit lands. Sign-in loss ends claim work, and a claim the
  provider accepted before an abort is still recorded.
- **Hosts.** Both hosts construct the controller from the same host ports and run the same jobs and
  startup reconciliation. The extension declares every capability: browser tabs, Twitch
  integrity capture and supplemental sources. The CLI declares none of them, so it always watches
  tabless and its jobs that need those capabilities are inert.

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

In the extension, most platform calls go through the page-context fetch helpers in `packages/extension/src/core/browserTabs.ts`, bound to the browser by `packages/extension/src/core/tabs.ts`. They find or open a temporary tab on the platform origin, then execute `fetch` in the page `MAIN` world. This keeps requests inside the browser's normal logged-in session and any page clearance context.

For Kick, `pageFetchJson` reads `session_token` from the Kick page context and adds it as a bearer token for `web.kick.com` API calls. For Twitch, GraphQL requests use Twitch's public web client id and normal browser credentials unless a public channel check explicitly passes `credentials: "omit"`. Twitch claim mutations also replay a short-lived Client-Integrity bundle captured from page-origin Twitch GraphQL traffic.

Temporary page-context tabs are reference-counted per origin and removed after the fetches complete when the extension created them. Existing user tabs reused for page-context fetches are not closed.

Kick may retain an extension-owned page-context tab when its service-worker fetch is rejected. One extension-host tracker receives successful route callbacks from every Kick fetcher, including the controller-lifetime tabless watcher, and drains only after scheduler state persists; residual evidence is discarded on every uncommitted tick exit. A fallback always resets recovery immediately, including on an incomplete cycle; only a complete, error-free direct cycle advances it once, regardless of request count. After the configurable number of consecutive direct cycles (three by default, 1–10 in Advanced settings), the extension verifies and closes that exact managed tab. Unreadable or concurrently changed tab ownership is retained for a safe retry, while ownership is released synchronously immediately before removal so a new fallback acquires a separate context. The counter is persisted with scheduler state so service-worker restarts do not reset or resurrect ownership. The engine drives recovery through the host's `PageContextPort` (#598): `recover(platform, { countBackgroundSuccess }, emit)` after a committed cycle, and `discardRecoveryEvidence(platform)` on an uncommitted exit. The extension's port (`createExtensionTabPorts`) holds the tracker, applies the configured threshold and runs the registry's recovery rule. The CLI has no browser page-context tabs and does not expose this setting.

## Twitch Integration

`TwitchAdapter` uses Twitch GraphQL at `https://gql.twitch.tv/gql` with persisted query hashes and the public Twitch web client id.

- Campaign discovery calls `Inventory` and `ViewerDropsDashboard`, then fetches campaign details for active/upcoming connected campaigns.
- Progress refresh re-reads `Inventory`; while watching, it also queries `DropCurrentSessionContext` to update the current reward's watched minutes.
- Candidate discovery prefers campaign allowed-channel data. If none exists, it queries `GameDirectory` with the DropsEnabled tag and sorts by viewer count.
- Followed channels come from an inline `FollowedLiveChannels` query (`currentUser.followedLiveUsers`), cached for 5 minutes in `TwitchDiscoveryState` (injected, so the cache survives the extension reconstructing `TwitchAdapter` every tick). A tick never blocks on this: a cached value, even a stale one, is returned immediately and refreshed in the background; only the very first lookup ever (nothing cached yet) awaits the request. A signed-out session or a failed lookup answers with an empty list, and selection falls back to viewer count.
- Channel validation calls `StreamInfo` with an inline public query and anonymous credentials to avoid logged-in integrity-token failures. For live category matches, it briefly caches `DropsHighlightService_AvailableDrops` results to confirm the selected campaign; unavailable or malformed confirmation data falls back to the live/category result. If `StreamInfo` fails, validation falls back to parsing channel page HTML.
- Reward claiming calls `DropsPage_ClaimDropRewards`.
- Channel points claiming uses live Hermes `claim-available` when the advanced setting is on; `ChannelPointsContext` remains the alarm fallback.
- The same Hermes connection follows the watched channel's `video-playback-by-id.<channelId>` topic while LurkLoot watches a Twitch channel, whether or not live-event claiming is on (#759). Only `stream-down` and `stream-up` are read. A `stream-down` schedules a Twitch tick 60 s later, because Twitch's stream query still reports a just-ended stream as live for several seconds. Its offline check then carries `offlineConfirmed`, and the watch ends without waiting for `offlineRetryLimit`. A `stream-up` cancels both the scheduled tick and the confirmation.
- Tabless watching requests Twitch HLS playlist and media-segment headers while the selected stream is live. The watch alarm records health once a minute. Between those checks the watcher polls every 10 seconds with the broadcast and viewer the last check resolved, so the polls add no `StreamInfo` lookups. A failed `PlaybackAccessToken` request is retried after a minute, doubling up to ten minutes while it keeps failing, so neither the polls nor an integrity rejection can loop. The July 2026 profile and the Spade or GraphQL heartbeat remain selectable and send only their own minute-watched beacon.
- The video CDN (`https://*.ttvnw.net/*`) is an optional grant. The extension background is the one authority for it: it turns Twitch off, with a `permission_missing` activity entry, when Twitch would watch with HLS without the grant, after an update, a revoke, or a change that could not prompt (a settings import). The popup records a change that needs the grant before prompting, and only the background applies it once the host is granted, whether or not the prompt closed the popup.

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

Watch tabs are a host capability, not part of `PlatformAdapter` (#598). The controller calls the host's `WatchTabPort`, which the extension implements with the shared `openPinnedMutedTabWithBrowser` and `stopWatchTabWithBrowser` helpers; the CLI has none, so it only watches tabless.

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

Tabless watching is the default (`tablessMode: true`). When it is on, or the host has no browser tabs, supported adapters create a `TablessWatchController` instead of opening a watch tab. Twitch's default web heartbeat requests HLS segment headers. Older minute-watched heartbeats stay selectable. Kick maintains a viewer WebSocket and sends watch livestream events. The one-minute watch alarm records heartbeat health in the platform session. A browser host falls back to a visible muted tab after repeated failures, and that tab plays stream video. The headless CLI keeps retrying tabless heartbeats because it cannot open a tab.

## Chat Presence

Some rewards need the account in the watched channel's chat: NoPixelV credits daily watch time from the channel's chatter list (#683). `background/chatPresence.ts` keeps one `ChatPresenceClient` per platform in an `ObserverSlot` and reconciles it after each tick commit and settings save, against the committed session only (`chatPresenceDecision` in `core/chatPresence.ts`). Presence is wanted while a platform watches **tablessly** with healthy auth and no manual pause, and either `platform.<p>.alwaysEnterChat` is on or the watching Twitch Extension provider declares `needsChatPresence`. Tab watches never use it: the page joins chat itself. A commit that leaves auth unhealthy or ends the watch stops it before any await. Presence never affects heartbeat health, rotation or tab fallback; its status is attached to snapshots as `state.chatPresence` and never persisted.

The Twitch client (`platforms/twitch/chatPresence.ts`) speaks IRC exactly as the web client does: `CAP REQ :twitch.tv/tags twitch.tv/commands`, `PASS`, `NICK`, `USER`, `JOIN`, switching with `JOIN` then `PART` on one socket. It answers `PING`, follows `RECONNECT`, blocks on an auth `NOTICE` without retrying (a credential change, a settings save or a restart replaces a blocked client; a tick keeps it), drops and retries a connection whose room is not confirmed within 30 s or whose idle `PING` goes unanswered for 10 s, and sends an idle `PING` after 25 s so Chromium keeps the MV3 worker alive on quiet channels. It never sends a chat message. Only the extension declares the `chatPresence` capability; the CLI reports `alwaysEnterChat` as unsupported and the service's hooks return at once there. Kick has no client yet, so a Kick `alwaysEnterChat` warns once that it has no effect. See docs/superpowers/specs/2026-10-05-chat-presence-design.md.

## Playback Telemetry and Control

Content scripts run on all Twitch/Kick pages, but only the current watch tab is authorized to mutate video state or update farming playback health. Non-managed tabs send passive telemetry only so the background can detect manual watching when `pauseOnManualWatch` is enabled.

Every five seconds, and after visibility/focus/player mutations, the content script asks the background for `PlaybackControl`:

- If `managed` is false, it reports passive telemetry and does not change page video state.
- If `managed` is true and `keepVideosUnmuted` is true, it removes page-level video muting, sets nonzero video volume, attempts `video.play()`, and listens for later `volumechange`/`pause` events so platform player state changes can be corrected. The content script suppresses the `volumechange`/`pause` events its own mutations trigger to avoid a self-feeding control loop.
- Some browsers (notably Firefox) refuse to unmute media in a tab that has had no user gesture and pause the element instead. The content script only attempts to unmute once the document reports sticky user activation (`navigator.userActivation.hasBeenActive`), so a background watch tab stays muted-but-playing without logging warnings. As a safety net, if an unmute is still blocked it re-mutes and replays the video so playback keeps progressing (counted in blocked playback count); watch time is credited even while muted.
- It reports telemetry including video count, muted/unmuted video count, playing video count, blocked playback count, document visibility, ready state, current time, and duration.

The scheduler treats playback as healthy when recent telemetry shows at least one video and at least one playing video — muted or not, since the browser may keep a background video muted. The browser tab can still be muted; the platform-visible page video state is intentionally separate from browser tab audio output.

Repeated offline, category mismatch, unhealthy playback checks, or unhealthy tabless heartbeats cause the scheduler to switch channels or fall back according to `offlineRetryLimit`. An offline check that a Twitch `stream-down` push agrees with (`ChannelCheck.offlineConfirmed`) switches at once.

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

Supplemental sessions carry their own watch identity and `tablessOnly` marker. Their heartbeat does not require invented campaign/reward IDs, and neither heartbeat failures nor ambiguous ordinary campaign discovery may cause tab fallback. Instead, once a failing heartbeat result reaches `tablessFallbackFailureLimit`, the lane's commit hook cools that provider's channel for five minutes, like an unavailable report, so the next selection moves to another channel or source. A failed due reprobe consumes its turn, and further failures never renew an active cooldown (#594). Ordinary drop sessions retain their existing watch-mode policy.

Channel-scoped viewer authorization is acquired through the normal Twitch background transport. Privileged provider drivers send it directly to their own optional backends. JWTs and vendor session/device properties remain in memory; only validated bounded outcomes and counters reach transient popup snapshots. Provider sessions are not restored after a worker restart. The lane's completion and cooldown deadlines are (#594): the host stores them under `twitchExtensionLane` whenever they change, as provider ids, epoch deadlines and channel logins only, and restores them on the next start after validating each entry and dropping expired ones. Without that, an MV3 worker that is stopped between alarms would forget a finished provider and probe it again on every wake. The memory is tied to the signed-in Twitch login, read from Twitch's `login` cookie (a username, not a credential). It is restored only for the same login, and a change of Twitch's auth cookie stops the providers at once but forgets what the lane learned only if the login changed: Twitch re-sets that cookie on ordinary page loads. A restore never brings back what the host has already cleared (an account change, a disable, an ordinary invalidation), and reset clears the key with the rest of local storage. Disable, revocation, logout, channel changes and manual pause invalidate authority and cancel resources, including late results. Every report and every piece of driver activity (a pack opened, a giveaway joined, a sprite captured, a takeover started) is published through the provider's runtime session, which drops it once the session is no longer the provider's current one or was aborted. Each of those transitions stops or replaces the session first, so the lane meets #585's rule that stale work publishes nothing, without going through the controller's commits (#594). The lane follows the controller's accepted commits through an after-commit hook, not storage events or alarms. A change to its authority (Twitch enabled, a provider's settings, auth, the session's status or channel, a manual pause or watch) stops the providers synchronously, then a reconcile brings them back in line. The hook never waits on that reconcile, so a Twitch tick or auth refresh that settles its commit hooks never waits on provider session reads. Reconciles run one at a time. A tabless-only session commits a heartbeat result every minute, which keeps the driver refresh and session renewal cadence the every-alarm reconcile used to give.

NoPixelV uses its normal REST watchtime/giveaway protocol. Fortnite uses its normal socket handshake, versioned state reads and sprite capture commands; authoritative participant increments confirm captures, and actual server reward state determines completion. Optional takeovers require separate opt-in, server eligibility and ownership confirmation. See [provider details and live acceptance](twitch-extensions/foundation.md).
