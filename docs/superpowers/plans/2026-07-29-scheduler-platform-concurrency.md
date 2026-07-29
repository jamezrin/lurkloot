# Scheduler Platform Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Twitch and Kick scheduler work independently for every trigger and route recurring work through separate platform alarms without losing concurrent state updates.

**Architecture:** Long-running work is serialized only against other work for the same platform. Each completed operation commits its explicitly owned platform slice through a short storage queue that reloads and merges the latest `SchedulerState`, while all-platform callers fan out with settled aggregation.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, WXT WebExtension APIs.

## Global Constraints

- Keep one persisted `SchedulerState` blob; do not introduce a state migration.
- Both platforms continue using `settings.pollIntervalMinutes`.
- Network, tab, notification, and watcher work must never run inside the storage commit queue.
- Same-platform state writers must remain ordered.
- One platform failure must not cancel or roll back the sibling platform.
- Diagnostic messages remain English literals; activity events retain structured codes and data.
- `@lurkloot/core` must remain browser-free.
- Use two-space indentation, double quotes, semicolons, explicit type imports, and ES modules.

---

### Task 1: Platform State Slice Merge

**Files:**
- Create: `packages/core/src/background/platformState.ts`
- Create: `packages/extension/tests/platformState.test.ts`

**Interfaces:**
- Produces: `mergePlatformState(destination: SchedulerState, source: SchedulerState, platform: Platform): SchedulerState`
- Produces: `mergeOptionalEntry<T>(destination, source, platform)` as a private helper that preserves or deletes optional entries correctly.

- [ ] **Step 1: Write failing merge tests**

Create tests that construct distinguishable Twitch, Kick, and global values and prove that merging Twitch:

```ts
const merged = mergePlatformState(destination, source, "twitch");

expect(merged.sessions.twitch).toEqual(source.sessions.twitch);
expect(merged.sessions.kick).toEqual(destination.sessions.kick);
expect(merged.campaigns.twitch).toEqual(source.campaigns.twitch);
expect(merged.campaigns.kick).toEqual(destination.campaigns.kick);
expect(merged.installedAt).toBe(destination.installedAt);
expect(merged.lastTickAt).toBe("2026-07-29T12:00:00.000Z");
```

Add a second test where `source.managedWatchTabs.twitch`,
`source.managedPageContextTabs.twitch`, `source.manualWatch.twitch`,
`source.manualClosePause.twitch`, `source.gamification.twitch`,
`source.criticalHealth.twitch`, and
`source.deadlineInfeasibleRewardIds.twitch` are absent. Assert that the merged
records remove Twitch while preserving Kick.
Set the destination timestamp to `2026-07-29T12:00:00.000Z` and the source
timestamp to `2026-07-29T11:00:00.000Z` so the assertion proves a late commit
cannot move `lastTickAt` backwards.

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- platformState.test.ts
```

Expected: FAIL because `@lurkloot/core/background/platformState` is not exported.

- [ ] **Step 3: Implement the merge boundary**

Implement `platformState.ts` with an optional-record helper and explicit field
list:

```ts
function mergeOptionalEntry<T>(
  destination: Partial<Record<Platform, T>> | undefined,
  source: Partial<Record<Platform, T>> | undefined,
  platform: Platform,
): Partial<Record<Platform, T>> {
  const merged = { ...destination };
  const value = source?.[platform];
  if (value === undefined) delete merged[platform];
  else merged[platform] = value;
  return merged;
}

export function mergePlatformState(
  destination: SchedulerState,
  source: SchedulerState,
  platform: Platform,
): SchedulerState {
  return {
    ...destination,
    sessions: { ...destination.sessions, [platform]: source.sessions[platform] },
    authHealth: { ...destination.authHealth, [platform]: source.authHealth[platform] },
    campaigns: { ...destination.campaigns, [platform]: source.campaigns[platform] },
    criticalHealth: mergeOptionalEntry(destination.criticalHealth, source.criticalHealth, platform),
    managedWatchTabs: mergeOptionalEntry(destination.managedWatchTabs, source.managedWatchTabs, platform),
    managedPageContextTabs: mergeOptionalEntry(destination.managedPageContextTabs, source.managedPageContextTabs, platform),
    manualWatch: mergeOptionalEntry(destination.manualWatch, source.manualWatch, platform),
    manualClosePause: mergeOptionalEntry(destination.manualClosePause, source.manualClosePause, platform),
    gamification: mergeOptionalEntry(destination.gamification, source.gamification, platform),
    deadlineInfeasibleRewardIds: mergeOptionalEntry(
      destination.deadlineInfeasibleRewardIds,
      source.deadlineInfeasibleRewardIds,
      platform,
    ),
    lastTickAt: newestTimestamp(destination.lastTickAt, source.lastTickAt),
  };
}
```

Export the module through `packages/core/package.json` using
`"./background/platformState": "./src/background/platformState.ts"`.
Implement `newestTimestamp` by parsing both defined ISO values and returning
the value with the larger finite timestamp, falling back to the defined value
when only one parses.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- platformState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/platformState.ts packages/core/package.json packages/extension/tests/platformState.test.ts
git commit -m "refactor(controller): add platform state merge boundary"
```

### Task 2: Platform-scoped Tab Registries

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/tabs.test.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/criticalHealth.test.ts`

**Interfaces:**
- Produces: `registerManagedPageContextTabs(contexts, platforms?: readonly Platform[]): void`
- Produces: `syncManagedTabBreakers(state, platforms?: readonly Platform[]): void`
- Keeps: omitted `platforms` means whole-registry synchronization for reset and test cleanup.

- [ ] **Step 1: Write failing scoped-registry tests**

Seed both platforms, then synchronize only Twitch:

```ts
registerManagedPageContextTabs({
  twitch: twitchContext,
  kick: kickContext,
});
registerManagedPageContextTabs({}, ["twitch"]);
expect(currentManagedPageContextTabs()).toEqual({ kick: kickContext });

syncManagedTabBreakers({
  criticalHealth: {
    twitch: { ...openHealth, breakerOpen: false },
    kick: { ...openHealth, breakerOpen: true },
  },
});
syncManagedTabBreakers({}, ["twitch"]);
expect(managedTabBreakerOpen("twitch")).toBe(false);
expect(managedTabBreakerOpen("kick")).toBe(true);
```

Also add a scheduler test proving a Twitch-only tick does not remove a
registered Kick retained context or Kick breaker.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tabs.test.ts scheduler.test.ts criticalHealth.test.ts
```

Expected: FAIL because both current functions clear or synchronize all
platforms.

- [ ] **Step 3: Implement scoped synchronization**

Use one normalized target list:

```ts
const ALL_PLATFORMS: readonly Platform[] = ["twitch", "kick"];

export function registerManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  platforms: readonly Platform[] = ALL_PLATFORMS,
): void {
  for (const platform of platforms) {
    retainedPageContextTabs.delete(platform);
    const context = contexts[platform];
    if (context) retainedPageContextTabs.set(platform, context);
  }
}
```

Apply the same target-list pattern to `syncManagedTabBreakers`. Update
single-platform scheduler/controller call sites to pass `[platform]`; retain
whole-registry calls only for reset and test cleanup.

- [ ] **Step 4: Run scoped-registry tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tabs.test.ts scheduler.test.ts criticalHealth.test.ts backgroundController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/tabs.ts packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/extension/tests/tabs.test.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/criticalHealth.test.ts
git commit -m "refactor(tabs): scope state mirrors by platform"
```

### Task 3: Enforce Single-platform Controller Calls

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/cli/src/runtime/run.ts`

**Interfaces:**
- Keeps: `SchedulerTickOptions.platforms?: Platform[]` for direct engine consumers and focused tests.
- Keeps: `runSchedulerTick(state, settings, adapters, options): Promise<SchedulerTickResult>`
- Enforces: controller calls always pass a one-element `platforms` array.

- [ ] **Step 1: Add tests for one-platform controller invocation**

Add a test with spies on both adapters:

```ts
await runSchedulerTick(state, settings, adapters, { platforms: ["kick"] });

expect(kick.discoverCampaigns).toHaveBeenCalledOnce();
expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
expect(result.decisions.every((decision) => decision.platform === "kick")).toBe(true);
```

- [ ] **Step 2: Run the focused scheduler suite and verify type/test failures**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: PASS for the compatibility surface; the controller concurrency test
in Task 4 fails until controller calls are split.

- [ ] **Step 3: Preserve the scheduler compatibility bridge**

Keep the existing scheduler loop for direct callers. Scope retained contexts
and breaker synchronization to `options.platforms ?? PLATFORMS`, and update
breaker resynchronization inside `applyObservation` to pass `[platform]`.
Task 4 makes every controller call pass a single platform and fans out
multi-platform requests concurrently.

- [ ] **Step 4: Run scheduler and type checks**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/cli/src/runtime/run.ts packages/extension/tests/scheduler.test.ts
git commit -m "refactor(scheduler): run one platform per tick"
```

### Task 4: Per-platform Operation Queues and Short Commits

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `mergePlatformState(destination, source, platform)`
- Produces: private `withPlatformLock<T>(platform, operation): Promise<T>`
- Produces: private `commitPlatformState(platform, source): Promise<SchedulerState>`
- Changes: `runTick` becomes `runPlatformTick(platform, tickId, tickStartedAt, signal): Promise<string[]>`

- [ ] **Step 1: Write failing overlap and merge tests**

Use deferred adapter promises to prove Kick starts and commits while Twitch is
still pending:

```ts
const twitchDiscovery = deferred<DropCampaign[]>();
env.twitch.discoverCampaigns = vi.fn(() => twitchDiscovery.promise);

const ticking = env.controller.tick(undefined, "manual_tick");
await vi.waitFor(() => expect(env.kick.discoverCampaigns).toHaveBeenCalledOnce());
await vi.waitFor(() => expect(env.state.lastTickAt).toBeDefined());
expect(env.twitch.discoverCampaigns).toHaveBeenCalledOnce();

twitchDiscovery.resolve([]);
await ticking;
```

Add a concurrent completion test where Twitch and Kick each mutate campaigns
and sessions. Assert both final slices survive. Add a failure test where Twitch
throws after Kick succeeds; assert Kick state persists and the Twitch
interruption includes `platform: "twitch"`.

Retain and update the existing same-platform writer tests: telemetry racing a
Twitch tick must still show ordered load/save behavior for Twitch, while Kick
may interleave.

- [ ] **Step 2: Run the focused tests and verify serialization failures**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: FAIL because the global `stateMutation` holds Twitch work ahead of
Kick.

- [ ] **Step 3: Add operation and commit queues**

Replace the module-global state queue with controller-local queues:

```ts
const platformMutations: Record<Platform, Promise<unknown>> = {
  twitch: Promise.resolve(),
  kick: Promise.resolve(),
};
let stateCommit: Promise<unknown> = Promise.resolve();

function withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T> {
  const run = platformMutations[platform].then(operation, operation);
  platformMutations[platform] = run.then(() => undefined, () => undefined);
  return run;
}

function withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
  const run = stateCommit.then(operation, operation);
  stateCommit = run.then(() => undefined, () => undefined);
  return run;
}

async function commitPlatformState(platform: Platform, source: SchedulerState): Promise<SchedulerState> {
  return withStateCommit(async () => {
    const latest = await deps.loadState();
    const merged = mergePlatformState(latest, source, platform);
    await deps.saveState(merged);
    return merged;
  });
}
```

Move auth preparation, adapter creation, `runSchedulerTick`, notification
generation, ad focus, watcher reconciliation, critical-health event handling,
and commit into `withPlatformLock(platform, ...)`. Ensure the commit queue wraps
only the final load/merge/save.

- [ ] **Step 4: Fan out platform ticks with settled aggregation**

Normalize targets and start them together:

```ts
const requested = platforms ?? PLATFORMS;
const settled = await Promise.allSettled(
  requested.map((platform) => runPlatformTick(platform, tickId, tickStartedAt, signal)),
);
for (let index = 0; index < settled.length; index += 1) {
  const result = settled[index];
  const platform = requested[index];
  if (result.status === "fulfilled" && result.value.length > 0) {
    claimedRewards[platform] = result.value;
  } else if (result.status === "rejected") {
    await reportPlatformTickFailure(platform, result.reason);
  }
}
```

Give each platform its own event collector. Do not share `events`,
`nextWaitingClaimRewardIds`, or claimed arrays between concurrent operations.
Update `waitingClaimRewardIds` only for the completed platform.

- [ ] **Step 5: Convert single-platform writers**

Change telemetry, tab removal, manual resume, auth-health changes, heartbeats,
and other handlers that own one platform to use that platform queue and
`commitPlatformState`. For tab removal, resolve affected platforms first and
acquire those queues in stable Twitch-then-Kick order. Whole-host reset acquires
both platform queues in that order, then uses the commit queue for replacement.

- [ ] **Step 6: Run controller tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm typecheck
```

Expected: PASS, including overlap, independent failure, merge, and
same-platform ordering tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "perf(controller): run platform ticks concurrently"
```

### Task 5: Separate Twitch and Kick Scheduler Alarms

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/backgroundEntrypoint.test.ts`
- Modify: `packages/extension/tests/credentialObserver.test.ts`

**Interfaces:**
- Produces: `TWITCH_ALARM_NAME = "lurkloot.tick.twitch"`
- Produces: `KICK_ALARM_NAME = "lurkloot.tick.kick"`
- Keeps: `ALARM_NAME = "lurkloot.tick"` as a legacy cleanup constant.

- [ ] **Step 1: Write failing alarm tests**

Assert setup creates both scoped alarms and clears the legacy alarm:

```ts
await env.controller.ensureAlarm();

expect(env.deps.createAlarm).toHaveBeenCalledWith(
  TWITCH_ALARM_NAME,
  { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes },
);
expect(env.deps.createAlarm).toHaveBeenCalledWith(
  KICK_ALARM_NAME,
  { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes },
);
expect(env.deps.clearAlarm).toHaveBeenCalledWith(ALARM_NAME);
```

Update the alarm-listener test to deliver each name and assert:

```ts
listener({ name: TWITCH_ALARM_NAME });
expect(controller.tickAndHandOff).toHaveBeenCalledWith(["twitch"], "alarm");

listener({ name: KICK_ALARM_NAME });
expect(controller.tickAndHandOff).toHaveBeenCalledWith(["kick"], "alarm");
```

Assert the legacy alarm does not trigger scheduler work.

- [ ] **Step 2: Verify alarm tests fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts backgroundEntrypoint.test.ts credentialObserver.test.ts
```

Expected: FAIL because only `lurkloot.tick` exists.

- [ ] **Step 3: Implement alarm creation, routing, and cleanup**

Add the constants and route names explicitly in
`createBackgroundAlarmListener`. Extract one helper used by ensure/startup and
poll-interval changes:

```ts
async function ensureSchedulerAlarms(periodInMinutes: number): Promise<void> {
  await deps.clearAlarm?.(ALARM_NAME);
  await Promise.all([
    deps.createAlarm?.(TWITCH_ALARM_NAME, { periodInMinutes }),
    deps.createAlarm?.(KICK_ALARM_NAME, { periodInMinutes }),
  ]);
}
```

Do not alter `WATCH_ALARM_NAME` or `TWITCH_INTEGRITY_ALARM_NAME`.

- [ ] **Step 4: Run alarm and type tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts backgroundEntrypoint.test.ts credentialObserver.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/backgroundEntrypoint.test.ts packages/extension/tests/credentialObserver.test.ts
git commit -m "perf(controller): schedule platforms independently"
```

### Task 6: Cross-trigger Concurrency and Lifecycle Safety

**Files:**
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/cli/tests/runtime.test.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/cli/src/runtime/run.ts`

**Interfaces:**
- Keeps: `tick(platforms?: Platform[], trigger?: TickTrigger)`
- Keeps: `tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger)`
- Keeps: `settleBackgroundWork(): Promise<void>`

- [ ] **Step 1: Add trigger and lifecycle tests**

Cover startup/manual all-platform fan-out by holding Twitch discovery and
asserting Kick completes. Add CLI coverage proving the default one-shot call
starts both adapters before either is released.

Add shutdown/reset coverage:

```ts
const twitchTick = env.controller.tick(["twitch"]);
const kickTick = env.controller.tick(["kick"]);
await vi.waitFor(() => {
  expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
  expect(env.kick.discoverCampaigns).toHaveBeenCalled();
});
await env.controller.prepareForHostReset();
await expect(Promise.all([twitchTick, kickTick])).resolves.toBeDefined();
```

Add a concurrent-claim test asserting Twitch and Kick claimed IDs each start
only their own post-claim handoff.

- [ ] **Step 2: Run tests and inspect failures**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm --filter @lurkloot/cli test -- runtime.test.ts
```

Expected: any failures identify remaining shared abort, background-work, or
handoff assumptions.

- [ ] **Step 3: Make lifecycle tracking platform-safe**

Keep active abort controllers associated with their platform:

```ts
const activeTicks = new Map<AbortController, Platform>();
```

Abort only matching platform work on a platform toggle; abort all entries on
shutdown/reset. Ensure `backgroundWork` draining includes every concurrently
started platform promise and any handoffs appended while it drains.

Keep `claimHandoffs` keyed by platform and launch successful platform handoffs
with settled aggregation so a Twitch handoff cannot delay Kick:

```ts
await Promise.allSettled(
  (Object.keys(claimed) as Platform[]).map((platform) =>
    runClaimHandoff(platform, claimed[platform] ?? [])),
);
```

- [ ] **Step 4: Run lifecycle, CLI, and type tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm --filter @lurkloot/cli test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/cli/src/runtime/run.ts packages/cli/tests/runtime.test.ts
git commit -m "fix(controller): isolate platform tick lifecycles"
```

### Task 7: Full Verification and Documentation Check

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Verifies all interfaces introduced by Tasks 1–6.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
git diff --check origin/develop...
pnpm typecheck
```

Expected: no whitespace errors and all workspace typechecks pass.

- [ ] **Step 2: Run all tests**

Run:

```bash
pnpm test
```

Expected: all CLI, extension, and site tests pass.

- [ ] **Step 3: Run repository verification**

Run:

```bash
pnpm verify
```

Expected: scripts, typechecks, extension tests, site build, Chromium build, and
Firefox build all pass.

- [ ] **Step 4: Inspect final diff and architecture boundary**

Run:

```bash
git diff --stat origin/develop...
git diff --check origin/develop...
pnpm --filter @lurkloot/extension test -- coreBoundary.test.ts
```

Expected: changes remain scoped to controller/scheduler/tab coordination,
alarms, tests, and the approved docs; the core boundary test passes.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required code changes, inspect `git diff --name-only`, stage
only the listed controller/scheduler/tab/test files that were edited, and
commit:

```bash
git add packages/core/src/background/controller.ts packages/core/src/core/scheduler.ts packages/core/src/core/tabs.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/tabs.test.ts
git commit -m "fix(controller): address platform concurrency verification"
```

If no files changed, do not create an empty commit.
