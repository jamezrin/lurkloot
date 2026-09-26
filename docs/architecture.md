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
- `packages/core/src/background/controller.ts` coordinates settings/state persistence, scheduler ticks, popup messages, notifications, manual reward claims, and playback-control authorization.
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

This section records how `createBackgroundController` (`packages/core/src/background/controller.ts`)
owns its state and serializes its work **as of v1.14.0**. It is the baseline for the v1.15.0
refactor (#583): each extraction issue updates the rows it moves, and #591 replaces this section
with the final module ownership.

### State ownership

Everything below is created once per controller instance. "In memory" means it is lost on an MV3
service-worker restart or a CLI process restart. "Persisted" means it is part of `SchedulerState`
or settings, loaded and saved through the host's storage port (`storage.local` on the extension,
`state.json` on the CLI).

| State group | Where it lives | Written by | Invalidated by | Commit boundary | Restart | Hosts |
| --- | --- | --- | --- | --- | --- | --- |
| Scheduler state (`sessions`, `authHealth`, `campaigns`, `criticalHealth`, backoffs, `lastTickAt`) | Persisted | Ticks, heartbeats, auth, claims, message handlers | Newer commits for the same platform | `persistPlatformState` → `withStateCommit`, merged per platform by `mergePlatformState` | Reloaded. `handleStartup` runs `staleStartupCleanup` on the extension | Both |
| Discovery lanes (`discoveryLanes`, `discoveryEvents`) | In memory, one `DiscoverySnapshotLane` per platform | `refreshDiscovery` | Settings saves that are not ranking-only, auth invalidation, `refreshDiscovery` itself, reset and shutdown | None: a snapshot is published by revision, not stored | Rediscovered on the first tick | Both |
| Selection (`selectionCache`, `selectionRuns`, `pendingSelections`, `selectionGeneration`) | In memory | `prepareSelection` | `invalidateSelection`: every settings save (including ranking-only), auth invalidation, heartbeat results, playback telemetry, reset, shutdown | Consumed inside `runTick`'s platform lock | Recomputed | Both |
| Tick admission (`tickAdmission`, `activeTicks`, `tickBatches`, `backgroundWork`) | In memory | `tick`, `tickInBackground`, `tickAndHandOff` | Disable, reset, shutdown | None | Empty | Both. Extension alarms and CLI intervals request ticks per platform |
| Heartbeat lanes, watchers and publication leases (`heartbeatLanes`, `tablessWatchers`) | In memory, with the heartbeat cadence persisted in the session | `requestPlatformHeartbeat`, `reconcileTablessWatchers`, `commitHeartbeatResult` | Session changes, `clearHeartbeatOwnership`, shutdown | `withHeartbeatLane`, then `withStateCommit` **without** the platform lock | `handleStartup` releases ownership on the extension; the CLI does not call it | Both |
| Discovery-signal controllers (`discoverySignalControllers`, `discoverySignalLifecycleOpen`) | In memory | `reconcileDiscoverySignalControllers` (from `runTick`) | Auth transitions, tab removal, settings, reset, shutdown | None | Recreated by the next tick | Both, when the adapter provides a factory |
| Auth health (`authHealth`, `authRefreshGeneration`) | Health persisted, generations in memory | `probeAuthHealth`, `refreshAuthHealth`, `persistAuthHealth`, `invalidateAuthHealth` | A newer refresh generation | `persistAuthHealth` under the platform lock, then `withStateCommit` | Health reloaded, then re-probed | Both. Credentials come from cookies (extension) or the credential store (CLI) |
| Manual watch (`manualWatch`, `manualWatchTabs`, `manualClosePause`, playback telemetry) | Persisted | `recordPlaybackTelemetry`, `handleTabUpdated`, `handleTabRemoved`, `resumeAfterManualClose` | Tab events, resume, TTL | Platform lock | Reloaded | Extension only; the CLI has no tabs |
| Settings (`settingsMutation`, `twitchSettingsTransitionGeneration`) | Settings persisted, transition generation in memory | `updateStoredSettings`, `normalizeStartupSettings`, `updateIdleWatchlist` | Each settings commit. A ranking-only patch (`isRankingOnlyPatch`) keeps discovery and invalidates selection only | `withSettingsLock` | Reloaded and migrated (schema v7) | Both. The CLI's `saveSettings` is a no-op |
| Page contexts and Kick recovery evidence | `core/tabs.ts` module globals, mirrored in persisted `managedPageContextTabs`. Recovery evidence in the extension host (`kickPageContextRecovery`) | Scheduler tick, `registerManagedPageContextTabs`, host fetch fallbacks | Release, reset, restart without auto-start | Copied into `SchedulerState` by the scheduler | Re-registered at startup when farming auto-starts | Extension only |
| Claim operations (`dropClaimOperations`, `waitingClaimRewardIds`, `claimHandoffs`, `kickChallengeClaimOperations`, `twitchChannelPointsClaimInFlight`, channel-points push) | In memory. Claimed rewards are persisted through `campaigns` | Ticks, claim jobs, `claimRewardNow`, `runClaimHandoff`, the push | Disable, auth loss, reset, shutdown, `abortClaimHandoffs` at startup | Platform lock | In-flight work is lost; provider inventory is re-read | Both, but manual-watch claim jobs never fire on the CLI |
| Twitch integrity (`installedTwitchIntegrity`, `persistedIntegrityToken`, `integrityLifecycleGeneration`) | In memory in the controller and in `core/tabs.ts` globals; the token is also persisted through `saveTwitchIntegrity` | Header capture, refresh, enable/disable transitions | A newer lifecycle generation | Settings lock, then the platform lock | Token reloaded from storage | Extension only |
| Compatibility reporting (`reportedCompatibility`, route reports) and `campaignEvaluationFingerprints` | In memory | Adapter construction, ticks | Never, within a process | None | Reported again | Both |
| Host jobs | `browser.alarms` (extension); `setInterval` for ticks and heartbeats only (CLI) | `ensureSchedulerAlarms`, `reconcile*Alarm`, integrity scheduling | Settings changes, disable | Settings lock | Alarms survive a service-worker restart; the CLI's `createAlarm` is a no-op | Both, with different job sets (#593) |
| Twitch Extensions host (`generation`, `knownComplete`, `completedUntil`, `unavailableUntil`, summaries) | In memory in `packages/extension/src/extensions/host.ts` | The host's reconcile loop | `storage.onChanged` diffs of settings and scheduler state, every alarm | Outside the controller | Forgotten; providers are re-probed | Extension only |

### Locks and queues

All of these are promise chains: `run = previous.then(operation, operation)`.

| Lock | Protects | Notes |
| --- | --- | --- |
| `withSettingsLock` (`settingsMutation`) | Settings read-modify-write | Also reschedules jobs while held (see below) |
| `withStateLock(operation, platforms)` (`platformMutations`) | One platform's scheduler state and in-memory lifecycle | Takes each requested platform in the fixed order Twitch → Kick |
| `withStateCommit` (`stateCommit`) | The global load → merge → save of `SchedulerState` | Its bodies only load and save state |
| `withHeartbeatLane(platform)` | One platform's watcher, heartbeat reservations and publication leases | Independent of the platform lock |
| `withTwitchIntegrityAlarmLock` | Creating and clearing the integrity refresh alarm | Taken inside the settings and platform locks |
| Discovery lanes | One refresh per platform, with a coalesced follow-up | Not a lock on state |

Nested acquisition orders found in the code, and none in the reverse direction:
- settings → platform: `runTwitchIntegrityRefresh`, `prepareForHostReset`
- settings → commit: each discovery refresh reads settings and state together (`createDiscoveryLane`)
- platform → commit: `persistPlatformState` and `persistAuthHealth` under `withStateLock`
- platform → heartbeat lane: `runTick` → `reconcileTablessWatchers`
- settings or platform → integrity alarm lock

Heartbeat results commit through `withStateCommit` without the platform lock. That is what keeps a
due heartbeat independent of a long tick.

### Work performed while a lock is held

These are the v1.15.0 targets. The authoritative list is
`packages/extension/tests/helpers/lockedIo.ts` (`LOCKED_IO_ALLOWLIST`), with the issue that removes
each entry. `lockedIoAllowlist.test.ts` fails if a provider, tab or timer call appears inside a lock
without being listed, or if a listed call has left its lock without the entry being deleted.

- **Scheduler tick** (`runSchedulerTick`, inside `runTick`'s platform lock): reward claims, the
  channel-points claim, Kick challenge claims, the legacy in-tick `refreshCampaigns`, watch-tab open
  and stop, page-context release, and Twitch Extensions supplemental selection (permission checks and
  provider GQL). Owners: #599, #587.
- **`runTick` itself**, around the scheduler: tabless watcher reconciliation (#586), discovery-signal
  and channel-points push reconciliation (#587, #590), ad focus (#587), and the fallback
  `prepareSelection`, which can wait on another tick's selection run (#587).
- **Heartbeat lane:** `watcher.start` (#586).
- **Auth transitions** stop the discovery-signal observer and the channel-points push directly
  (#595).
- **Tab events and playback:** stopping discovery signals on tab removal, ad focus on telemetry
  (#596).
- **Host reset** closes watch tabs and page contexts under the settings and platform locks (#598).
- **Claims outside the tick:** `claimRewardNow`, `runDropClaims` (which also refreshes campaigns) and
  `runKickChallengeClaims` (#597, #588).
- **Timers under the settings or platform lock:** integrity refresh scheduling (#589), scheduler,
  claim and channel-points alarms on settings writes and at startup (#593, #597, #590).

Event reporting (`reportBestEffort`, `persistAndReport`) and notifications also run inside locks
today. #585 moves operational publication after the commit.

### Characterization coverage

v1.15.0 extractions must keep these tests passing without editing their assertions, except in a PR
labelled `behavior-change`. `controllerContract.test.ts` runs its cases once per host capability set
(extension and CLI, `tests/helpers/controllerContract.ts`); #593 turns those sets into typed host
ports and reuses the cases.

| Invariant | Where it is tested |
| --- | --- |
| One active tick and one shared follow-up per platform; Twitch and Kick progress independently | `controllerContract.test.ts` (both hosts); `backgroundController.test.ts` ("coalesces same-platform ticks…", "admits one Twitch tick and one follow-up…", the "lets Kick … while Twitch …" cases) |
| `ranking_changed` re-selects without rediscovery and loses to any trigger that needs fresh discovery | `controllerContract.test.ts`; `backgroundController.test.ts` ("reordering what is farmed") |
| Cancelled work publishes no state or activity | `controllerContract.test.ts` (shutdown); `backgroundController.test.ts` ("aborts in-flight scheduler work…", "route evidence independent of state publication") |
| Stale discovery, selection and heartbeat work cannot overwrite newer state | `backgroundController.test.ts` ("rejects a stale heartbeat…", "persists discovery after a due heartbeat invalidates a blocked snapshot selection", "does not let a stale … removal …") |
| Heartbeat due time is independent of ticks | `backgroundController.test.ts` ("tabless heartbeat cadence", "lets Kick heartbeat and persist while Twitch heartbeat is still pending") |
| Manual managed-tab closure | `backgroundController.test.ts` ("manual-watch event transitions", "clears manual watch activity when the source tab is closed") |
| Service-worker restart | `backgroundController.test.ts` (the startup cleanup cases and "serializes service-worker restart recovery…"); `controllerContract.test.ts` (extension host) |
| CLI process restart: no startup cleanup today (#593 changes this) | `controllerContract.test.ts` (CLI host) |
| Job registration: the CLI registers none today (#593, #590 change this) | `controllerContract.test.ts` |
| The popup reads the stored settings and state verbatim | `controllerContract.test.ts` ("runtime snapshot") |
| Campaign ranking and #571's selection rules (mid-reward takeover, favourites, discarded refresh hold, just-armed watch) | `ranking.test.ts`, `rankingSettings.test.ts`, `scheduler.test.ts`, `watchSourceScheduler.test.ts` |
| `updateIdleWatchlist` keeps a concurrent popup change | `backgroundController.test.ts` ("Idle Watchlist changes from the page") |
| Supplemental lane: tabless only, released on completion or manual pause | `supplementalWatch.test.ts`, `twitchExtensionHost.test.ts` |
| Supplemental lane: completion forgotten on restart (current behavior; #594 changes it) | `twitchExtensionHost.test.ts` ("forgets completion when a new host starts…") |
| Locked I/O can only shrink | `lockedIoAllowlist.test.ts` |

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
3. Discover campaigns through the adapter and merge progress.
4. Auto-claim claimable rewards when enabled.
5. Select the first eligible source in the platform's normalized `watchSourcePriority`, preserving campaign and channel ranking within each source. See [watch-source selection policy](watch-source-priority.md).
6. Decide whether to keep the current target by checking channel liveness/category and recent playback or heartbeat telemetry.
7. Use tabless watching when enabled and supported, or open, reuse, retarget, or stop the watch tab through the adapter.
8. Claim channel points when enabled and supported by the adapter.
9. Persist sessions, campaigns, managed-tab registrations, and backoff state, then publish activity records through the host event sink.

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
