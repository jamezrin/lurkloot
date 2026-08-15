# Scheduler Lane Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Twitch and Kick watch heartbeats on an independent 60-second cadence while discovery refresh and target selection operate from coherent provider snapshots.

**Architecture:** Deliver three independently reviewable changes. First isolate an immutable active-watch context and heartbeat lane from the platform discovery lock. Then add single-flight provider-owned discovery snapshots. Finally make target selection consume committed snapshot revisions and run only from material changes or explicit triggers.

**Tech Stack:** TypeScript, `@lurkloot/core`, `@lurkloot/shared`, WXT browser alarms, Node timers, Vitest, pnpm.

## Global Constraints

- The target heartbeat cadence is exactly 60 seconds for Twitch and Kick.
- A late timer produces one attempt, never a burst of catch-up attempts.
- The heartbeat lane performs no campaign refresh, candidate enumeration, target ranking, or routine auth-health probe.
- Twitch and Kick eligibility evidence remains provider-specific behind `PlatformAdapter`.
- Ambiguous, incomplete, or failed discovery preserves a healthy current watch; explicit supported negatives remain rejectable.
- Discovery is single-flight per provider with at most one coalesced pending refresh.
- Network requests never run under the short scheduler-state commit lock.
- Diagnostics are aggregate English literals; do not add locale keys or per-candidate events.
- Add no browser permissions and persist no raw provider payloads.

---

### Task 1: Isolate the provider-neutral watch heartbeat lane (#336)

**Files:**
- Create: `packages/core/src/background/watchLane.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/core/src/core/tablessWatch.ts`
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/cli/src/runtime/run.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/backgroundEntrypoint.test.ts`
- Test: `packages/cli/tests/run.test.ts`

**Interfaces:**
- Produces: `CommittedWatchContext`, an immutable provider watch identity containing platform, channel, broadcast, campaign, reward, and timing revision.
- Produces: `WatchLane.attemptDue(platform, now): Promise<WatchLaneResult>` and `WatchLane.commit(context): void`.
- Consumes: existing `TablessWatchController.tick()` implementations and short state persistence callbacks.

- [ ] **Step 1: Add failing controller tests for lock independence**

Use a deferred `refreshCampaigns()` promise in `backgroundController.test.ts`. Start a Twitch discovery tick, fire `runWatchHeartbeat()`, and assert the Twitch watcher receives `tick()` before resolving discovery. Repeat for Kick.

- [ ] **Step 2: Run the focused tests and verify the current shared lock blocks them**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: both new assertions fail because `runPlatformWatchHeartbeat()` waits on `withStateLock()`.

- [ ] **Step 3: Add timing, coalescing, and handoff tests**

Cover a 60-second due boundary, no accumulated drift after slow persistence, one attempt after a late alarm, concurrent alarm coalescing, immediate-switch deduplication, restart recovery, and a simultaneous channel switch that observes either the complete old context or complete new context.

- [ ] **Step 4: Implement the watch-context and lane boundary**

Move heartbeat network transmission out of the platform mutation lock. Restrict synchronization to atomic context replacement, watcher lifecycle ownership, and a short merge-safe result commit. Keep existing failure counts and tab fallback semantics.

- [ ] **Step 5: Give both hosts a fixed heartbeat driver**

Keep the extension `WATCH_ALARM_NAME` at one minute and calculate due time from persisted timing. Add a separate 60-second CLI heartbeat timer instead of relying on `pollIntervalMinutes`; keep discovery on its existing configurable timer.

- [ ] **Step 6: Add aggregate timing diagnostics**

Report scheduled due time, actual attempt time, timer lateness, internal synchronization delay, coalescing, and stale-result rejection without logging credentials or per-candidate data.

- [ ] **Step 7: Run focused and workspace verification**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts backgroundEntrypoint.test.ts
pnpm --filter @lurkloot/cli test -- run.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit the independently reviewable watch lane**

```bash
git add packages/core/src/background/watchLane.ts packages/core/src/background/controller.ts packages/core/src/core/tablessWatch.ts packages/shared/src/models.ts packages/extension/entrypoints/background.ts packages/cli/src/runtime/run.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/backgroundEntrypoint.test.ts packages/cli/tests/run.test.ts
git commit -m "fix(core): isolate watch heartbeat cadence"
```

### Task 2: Publish asynchronous provider discovery snapshots

**Files:**
- Create: `packages/core/src/core/discoverySnapshot.ts`
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces: `DiscoverySnapshot` with platform, revision, observed time, campaigns, completeness, and provider-owned candidate observations.
- Produces: `PlatformAdapter.refreshDiscoverySnapshot(previous, options): Promise<DiscoverySnapshot>`.
- Consumes: existing Twitch/Kick discovery state, batching, caches, `refreshCampaigns`, `listCandidateChannels`, and `checkChannel` behavior.

- [ ] **Step 1: Add failing single-flight and provider-independence tests**

Block Twitch refresh, request it again, and assert only one pending rerun is retained. While Twitch is blocked, assert Kick refresh completes and publishes its own revision.

- [ ] **Step 2: Add failing snapshot-coherence tests**

Assert an incomplete/failed refresh retains the last completed snapshot, identity/settings generation changes discard stale results, and a cold process starts without persisted raw provider data.

- [ ] **Step 3: Define the normalized snapshot envelope**

Keep only scheduling metadata shared. Store provider-specific candidate evidence through opaque adapter-owned structures or adapter methods so Kick is not required to emulate Twitch `AvailableDrops`.

- [ ] **Step 4: Implement per-provider single-flight refresh**

Add controller ownership for one active refresh and one boolean/latest pending request per provider. Publish a completed revision atomically; never publish partial work as an authoritative empty snapshot.

- [ ] **Step 5: Adapt Twitch discovery**

Build snapshots using existing campaign details, liveness/category batches, availability cache, and #392 progress-confirmed fail-open semantics. Keep #339 caching and #337 backoff compatible with this lane.

- [ ] **Step 6: Adapt Kick discovery**

Build snapshots from Kick campaign/ACL/category data and fresh liveness/category checks. Represent absence of a channel-specific eligibility API as unknown, not false.

- [ ] **Step 7: Add aggregate discovery diagnostics**

Report provider, duration, revision, snapshot age/completeness, cache/batch counters, pending coalescing, and discarded stale generations.

- [ ] **Step 8: Run focused and workspace verification**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts adapters.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit the discovery snapshot lane**

```bash
git add packages/core/src/core/discoverySnapshot.ts packages/core/src/platforms/adapter.ts packages/core/src/platforms/twitch/index.ts packages/core/src/platforms/kick/index.ts packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/adapters.test.ts
git commit -m "refactor(core): publish provider discovery snapshots"
```

### Task 3: Select targets from committed snapshot revisions

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/core/src/core/discoverySnapshot.ts`
- Test: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `DiscoverySnapshot` revisions published by Task 2.
- Produces: a pure snapshot-based selection input and an atomic `CommittedWatchContext` handoff to Task 1.

- [ ] **Step 1: Add failing tests proving selection performs no discovery I/O**

Pass a committed snapshot to selection, make every adapter refresh/list method throw if called, and assert selection chooses or retains a target solely from the snapshot.

- [ ] **Step 2: Add trigger and material-change tests**

Cover new snapshot revisions with no material change, meaningful availability/campaign changes, claim handoff, current-watch failure, relevant settings changes, and explicit refresh/resume.

- [ ] **Step 3: Add fail-open and stale-generation tests**

Assert ambiguous/stale snapshots retain a healthy current watch, fresh provider-supported negatives reject candidates, and an old selection result cannot publish after identity/settings/target generation advances.

- [ ] **Step 4: Split refresh from scheduler evaluation**

Change `runSchedulerTick()` or introduce a focused selection function so campaign refresh and candidate network checks are absent from the selection call path. Preserve claim, notification, page-context, and lifecycle behavior at their existing controller boundaries.

- [ ] **Step 5: Wire snapshot publication to lightweight selection**

Trigger selection after material publication, coalesce concurrent selection requests per provider, and commit the chosen `CommittedWatchContext` atomically without acquiring the watch transport during network work.

- [ ] **Step 6: Add aggregate selection diagnostics**

Report trigger, snapshot revision and age, material-change decision, candidate counts, selected target or retention reason, and discarded stale work.

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts backgroundController.test.ts
pnpm verify
```

Expected: all tests, typechecks, site build, and both extension builds pass.

- [ ] **Step 8: Commit snapshot-driven selection**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/core/src/core/discoverySnapshot.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "refactor(core): select from discovery snapshots"
```

### Task 4: Soak and close the architectural initiative

**Files:**
- Modify only if evidence requires: provider/controller diagnostic tests and the relevant GitHub issue acceptance criteria.

**Interfaces:**
- Consumes: watch timing diagnostics, discovery revision diagnostics, and selection revision diagnostics from Tasks 1-3.
- Produces: credential-free evidence that all three lanes operate independently in an authenticated extension session and headless CLI run.

- [ ] **Step 1: Run an authenticated extension soak**

Capture several discovery cycles for both providers, including a channel going online/offline or an explicit refresh. Confirm heartbeat internal delay remains near zero while discovery is active and no credentials appear in exports.

- [ ] **Step 2: Run a CLI timing soak**

Use a discovery interval different from one minute and confirm Twitch/Kick watch attempts retain the independent 60-second target cadence.

- [ ] **Step 3: Run final verification**

Run: `pnpm verify`

Expected: all checks pass.

- [ ] **Step 4: Record evidence and close linked issues**

Attach aggregate credential-free timing excerpts to the three implementation issues, close completed children, and update #361/#382 so their remaining #337/#339 work is accurately separated from heartbeat latency.
