# Diagnostics Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make diagnostics unambiguous across controller restarts, eliminate redundant integrity-alarm scheduling lines, label Twitch selection timings, and report material platform-lock contention.

**Architecture:** The controller owns one run ID and applies it at the reporting choke point, so all diagnostic producers inherit it without duplicating logic. Alarm deduplication stays behind a host-provided read-only alarm adapter, Twitch selection owns its campaign context, and lock-wait timing is measured at the existing platform-lock boundary.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, WXT browser extension APIs

## Global Constraints

- `controllerRunId` is opaque, unique per background-controller instance, and attached to every diagnostic from that instance.
- `globalTickId` and `platformTickId` remain per-run counters.
- One unscoped run-boundary diagnostic precedes the controller's first reported diagnostic.
- Diagnostics outside ticks carry no tick IDs.
- An integrity alarm within 1,000 milliseconds of the desired target is unchanged and unlogged.
- Alarm lookup failures are best-effort and never block scheduling.
- Compatibility remains once per controller run.
- Platform lock waits below 50 milliseconds remain silent.
- Core stays browser-free; browser alarm access remains in the extension host.
- Diagnostic copy remains English literals; no locale keys are added.

---

### Task 1: Correlate every diagnostic with a controller run

**Files:**
- Modify: `packages/shared/src/events.ts:59-79`
- Modify: `packages/core/src/background/controller.ts:75-110`
- Modify: `packages/core/src/background/controller.ts:820-850`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/activityStorage.test.ts`

**Interfaces:**
- Produces: `DiagnosticEvent.controllerRunId?: string`
- Produces: controller-local `controllerRunId: string`
- Consumes: existing `reportBestEffort(events)` reporting choke point

- [ ] **Step 1: Write failing run-correlation tests**

Add a controller test that emits both a non-tick request diagnostic and a tick:

```ts
it("announces one controller run and correlates all of its diagnostics", async () => {
  const env = harness(farming(DEFAULT_SETTINGS));

  await env.controller.handleMessage({
    type: "setAutomation",
    platform: "twitch",
    enabled: true,
  });
  await env.controller.settleBackgroundWork();

  const diagnostics = env.reportEvents.mock.calls
    .flatMap(([events]) => events)
    .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
  const boundaries = diagnostics.filter((event) =>
    event.message.startsWith("Background controller run "));
  const runId = boundaries[0]?.controllerRunId;

  expect(boundaries).toHaveLength(1);
  expect(runId).toEqual(expect.any(String));
  expect(diagnostics.every((event) => event.controllerRunId === runId)).toBe(true);
  expect(diagnostics.find((event) =>
    event.message === "User requested Twitch automation enable")).not.toHaveProperty("globalTickId");
});
```

Add a second test that constructs two harnesses, runs one Twitch tick in each,
and asserts both display `Tick #1` while their full `controllerRunId` values
differ.

Extend activity storage round-trip coverage with a diagnostic containing
`controllerRunId`, `globalTickId`, and `platformTickId`, then assert all three
survive `append` and `load`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/activityStorage.test.ts
```

Expected: FAIL because there is no run field or boundary event.

- [ ] **Step 3: Add the shared field and run ID generator**

Extend `DiagnosticEvent`:

```ts
controllerRunId?: string;
```

Create one ID when `createBackgroundController` runs:

```ts
const controllerRunId = typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const controllerRunLabel = controllerRunId.slice(0, 8);
```

- [ ] **Step 4: Announce and decorate at the reporting choke point**

Keep a single announcement promise and report it before the first non-empty
diagnostic batch. Decorate diagnostics only:

```ts
const correlateControllerRun = (events: readonly EngineEvent[]): EngineEvent[] =>
  events.map((event) =>
    event.category === "diagnostic"
      ? { ...event, controllerRunId }
      : event);
```

The boundary event is:

```ts
{
  category: "diagnostic",
  level: "debug",
  message: `Background controller run ${controllerRunLabel} started`,
  controllerRunId,
}
```

Call `deps.reportEvents` directly for the boundary to avoid recursively invoking
`reportBestEffort`; then report the decorated batch. Activity-only batches do
not create a boundary until a diagnostic is actually reported.

- [ ] **Step 5: Run focused tests and typechecks**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/activityStorage.test.ts
pnpm --filter @lurkloot/shared --filter @lurkloot/core --filter @lurkloot/extension typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/events.ts packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/activityStorage.test.ts
git commit -m "feat(core): correlate diagnostics by controller run"
```

### Task 2: Avoid redundant integrity alarm scheduling

**Files:**
- Modify: `packages/core/src/background/controller.ts:170-210`
- Modify: `packages/core/src/background/controller.ts:490-535`
- Modify: `packages/extension/entrypoints/background.ts:130-142`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/extension/tests/backgroundEntrypoint.test.ts`

**Interfaces:**
- Produces: `BackgroundControllerDeps.getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>`
- Consumes: browser `alarms.get(name)` through the extension host

- [ ] **Step 1: Write failing alarm-deduplication tests**

Add controller tests using an integrity token whose calculated refresh target is
captured from the first `createAlarm` call:

```ts
it("does not recreate or relog an unchanged Twitch integrity alarm", async () => {
  const integrity = integrityBundle({
    integrity: "unchanged-alarm-token",
    expiresAt: Date.now() + 30 * 60_000,
  });
  const first = harness(undefined, {
    loadTwitchIntegrity: async () => integrity,
  });
  await first.controller.settleBackgroundWork();
  const scheduledTime = (first.deps.createAlarm.mock.calls.find(
    ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
  )?.[1] as { when: number }).when;

  const second = harness(undefined, {
    loadTwitchIntegrity: async () => integrity,
    getAlarm: async () => ({ scheduledTime }),
  });
  await second.controller.settleBackgroundWork();

  expect(second.deps.createAlarm).not.toHaveBeenCalledWith(
    TWITCH_INTEGRITY_ALARM_NAME,
    expect.anything(),
  );
  expect(allDiagnostics(second)).not.toContainEqual(expect.objectContaining({
    message: expect.stringContaining("Scheduled proactive Twitch integrity refresh"),
  }));
});
```

Add companion tests where `getAlarm` returns a target more than 1,000ms away and
where it rejects. Both must call `createAlarm` and emit the scheduled target.

Update the entrypoint source test to require:

```ts
getAlarm: async (name) => {
  const alarm = await browser.alarms.get(name);
  return alarm ? { scheduledTime: alarm.scheduledTime } : undefined;
},
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/backgroundEntrypoint.test.ts
```

Expected: FAIL because `getAlarm` is not part of the dependency contract and
every schedule recreates/logs the alarm.

- [ ] **Step 3: Add the dependency and source-level comparison**

Add the optional dependency:

```ts
getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>;
```

Before `createAlarm`, perform a best-effort lookup:

```ts
let existing: { scheduledTime: number } | undefined;
try {
  existing = await deps.getAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
} catch {
  existing = undefined;
}
if (existing && Math.abs(existing.scheduledTime - when) <= 1_000) {
  twitchIntegrityRefreshDue = undefined;
  return;
}
```

Then preserve the existing create/log path.

- [ ] **Step 4: Wire browser and headless hosts**

The extension maps `browser.alarms.get` to the browser-free shape. The CLI omits
the optional dependency.

- [ ] **Step 5: Run focused tests and typechecks**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/backgroundEntrypoint.test.ts
pnpm --filter @lurkloot/core --filter @lurkloot/extension --filter @lurkloot/cli typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/entrypoints/background.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/backgroundEntrypoint.test.ts
git commit -m "perf(twitch): skip unchanged integrity alarms"
```

### Task 3: Label Twitch channel-selection diagnostics

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts:980-1060`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `campaign?: DropCampaign` already passed to `selectCandidateChannel`
- Produces: a shared local selection-context label used by both success and no-winner diagnostics

- [ ] **Step 1: Write failing selection-context tests**

Extend the existing selection diagnostics tests:

```ts
expect(events).toContainEqual(expect.objectContaining({
  category: "diagnostic",
  message: expect.stringMatching(
    /^Twitch channel selection for "Campaign One" \(campaign campaign-1\) finished in \d+ms/,
  ),
}));
```

Call selection without a campaign and assert:

```ts
message: expect.stringMatching(
  /^Twitch idle channel selection finished in \d+ms/,
)
```

Cover both a selected winner and an empty result so the two existing emit sites
cannot drift.

- [ ] **Step 2: Run the adapter tests to verify RED**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts
```

Expected: FAIL because both diagnostics currently begin only with
`Twitch channel selection finished`.

- [ ] **Step 3: Build one context label**

At the beginning of selection:

```ts
const selectionLabel = campaign
  ? `for "${campaign.name}" (campaign ${campaign.id})`
  : "idle";
```

Use one local `reportSelectionFinished()` helper for both emit sites so each
message begins:

```ts
`Twitch ${selectionLabel} channel selection finished in ...`
```

Keep all request, cache, fallback, and candidate counters unchanged.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/adapters.test.ts
pnpm --filter @lurkloot/core --filter @lurkloot/extension typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "feat(twitch): label channel selection diagnostics"
```

### Task 4: Measure material platform-lock contention

**Files:**
- Modify: `packages/core/src/background/controller.ts:1120-1220`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `tickContext?: TickDiagnosticContext` already accepted by `refreshAuthHealth`
- Produces: structured `data.waitMs` on lock-wait diagnostics

- [ ] **Step 1: Write failing contention tests**

Use fake timers and hold the Twitch platform lock with a deferred scheduler
refresh. Start a second Twitch tick, advance 75ms, release the first tick, and
assert:

```ts
expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
  category: "diagnostic",
  platform: "twitch",
  globalTickId: 2,
  platformTickId: 2,
  message: "Tick #2 waited 75ms for Twitch platform work",
  data: { waitMs: 75 },
}));
```

Add an uncontended tick assertion:

```ts
expect(allDiagnostics(env).some((event) =>
  event.message.includes("waited") && event.message.includes("platform work"),
)).toBe(false);
```

- [ ] **Step 2: Run the controller tests to verify RED**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts
```

Expected: FAIL because platform-lock acquisition time is not measured.

- [ ] **Step 3: Return acquisition timing from auth refresh**

Measure around `beginAuthRefresh`:

```ts
const lockStartedAt = Date.now();
const generations = await beginAuthRefresh(platforms);
const lockWaitMs = Date.now() - lockStartedAt;
```

When `tickContext` exists and `lockWaitMs >= 50`, emit one correlated diagnostic
per requested platform:

```ts
diagnosticEvent(
  "debug",
  `Tick #${tickContext.platformTickId} waited ${lockWaitMs}ms for ${platformLabel} platform work`,
  platform,
  tickContext,
  { waitMs: lockWaitMs },
);
```

Extend `diagnosticEvent` with an optional `data` argument and preserve all
existing call sites.

- [ ] **Step 4: Run focused tests and typechecks**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/activityStorage.test.ts
pnpm --filter @lurkloot/shared --filter @lurkloot/core --filter @lurkloot/extension typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): report platform lock contention"
```

### Task 5: Verify and update the existing pull request

**Files:**
- Verify only: entire workspace and browser builds

**Interfaces:**
- Consumes: Tasks 1-4
- Produces: verified Chrome and Firefox extension builds on the existing issue branch

- [ ] **Step 1: Search the final diagnostic producers**

Run:

```bash
rg -n "Background controller run|controllerRunId|Scheduled proactive Twitch integrity refresh|channel selection finished|platform work" packages
```

Expected: run correlation is centralized, the alarm line remains only on the
actual scheduling path, both selection outcomes use the shared reporter, and
lock-wait copy exists only in the controller.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm verify
```

Expected: tooling tests, all workspace typechecks, extension and CLI tests, site
tests/build, and Chromium/Firefox production builds pass.

- [ ] **Step 3: Inspect final state**

Run:

```bash
git status --short
git diff --check
git log --oneline -8
```

Expected: clean worktree and the four implementation commits above the design
and plan commits.

- [ ] **Step 4: Push without force**

Run:

```bash
git push origin perf/scheduler-platform-concurrency
```

Expected: the existing pull request branch advances normally.
