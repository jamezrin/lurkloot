# Dual Tick Identifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every scheduler tick a globally unique ID and a continuous platform-local ID while keeping current filtered diagnostic messages concise.

**Architecture:** Extend `DiagnosticEvent` with optional structured tick correlation fields. The background controller allocates both IDs synchronously, uses the platform-local ID in lifecycle messages, and decorates every diagnostic collected or emitted during that tick with the same pair.

**Tech Stack:** TypeScript, Vitest, pnpm workspace, WXT extension

## Global Constraints

- `globalTickId` is unique across Twitch and Kick ticks within one controller lifetime.
- `platformTickId` is sequential independently for Twitch and Kick.
- Both counters reset with the in-memory controller.
- Current lifecycle messages display only `platformTickId`.
- All diagnostics produced inside a tick carry both identifiers; diagnostics outside ticks omit them.
- Activity event contracts, persisted scheduler state, settings, permissions, and locale catalogs remain unchanged.
- Diagnostic messages remain English literals.

---

### Task 1: Define and populate structured tick correlation

**Files:**
- Modify: `packages/shared/src/events.ts:59-77`
- Modify: `packages/core/src/background/controller.ts:789-814`
- Modify: `packages/core/src/background/controller.ts:1263-1437`
- Test: `packages/extension/tests/backgroundController.test.ts:3620-3690`

**Interfaces:**
- Produces: `DiagnosticEvent.globalTickId?: number`
- Produces: `DiagnosticEvent.platformTickId?: number`
- Produces: per-tick context `{ globalTickId: number; platformTickId: number }`
- Consumes: existing `Platform`, `DiagnosticEvent`, `EngineEvent`, `reportBestEffort`, and tick event collection

- [ ] **Step 1: Write failing controller tests**

Add a test that runs Twitch, Kick, then Twitch ticks and groups lifecycle
diagnostics by platform:

```ts
it("assigns global and platform-local identifiers to interleaved platform ticks", async () => {
  const env = harness(farming(DEFAULT_SETTINGS));

  await env.controller.tick(["twitch"], "manual_tick");
  await env.controller.tick(["kick"], "manual_tick");
  await env.controller.tick(["twitch"], "manual_tick");

  const starts = env.reportEvents.mock.calls
    .flatMap(([events]) => events)
    .filter((event): event is DiagnosticEvent =>
      event.category === "diagnostic" && event.message.includes("started (trigger=manual_tick"));

  expect(starts.map(({ platform, globalTickId, platformTickId, message }) => ({
    platform,
    globalTickId,
    platformTickId,
    message,
  }))).toEqual([
    {
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: "Tick #1 started (trigger=manual_tick, platforms=twitch)",
    },
    {
      platform: "kick",
      globalTickId: 2,
      platformTickId: 1,
      message: "Tick #1 started (trigger=manual_tick, platforms=kick)",
    },
    {
      platform: "twitch",
      globalTickId: 3,
      platformTickId: 2,
      message: "Tick #2 started (trigger=manual_tick, platforms=twitch)",
    },
  ]);
});
```

Extend the existing lifecycle test to select one tick's start, auth timing,
campaign refresh, and finish diagnostics and assert that all carry
`globalTickId: 1` and `platformTickId: 1`. Add a diagnostic emitted outside a
tick through an existing controller action and assert both fields are absent.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts
```

Expected: FAIL because `DiagnosticEvent` has no tick fields, the global counter
appears in the Twitch message after a Kick tick, and collected scheduler
diagnostics have no correlation metadata.

- [ ] **Step 3: Extend the shared diagnostic contract**

Add the optional fields to `DiagnosticEvent`:

```ts
export type DiagnosticEvent = {
  category: "diagnostic";
  level: LogLevel;
  platform?: Platform;
  message: string;
  globalTickId?: number;
  platformTickId?: number;
  // existing fields remain unchanged
};
```

- [ ] **Step 4: Allocate both identifiers in the controller**

Replace the single counter with:

```ts
let globalTickSequence = 0;
const platformTickSequence: Record<Platform, number> = {
  twitch: 0,
  kick: 0,
};
```

At the beginning of `tickPlatform`, synchronously allocate:

```ts
const tickContext = {
  globalTickId: ++globalTickSequence,
  platformTickId: ++platformTickSequence[platform],
};
```

Pass this context into `runTick`. Format lifecycle messages with
`tickContext.platformTickId`.

- [ ] **Step 5: Decorate immediate and collected tick diagnostics**

Allow `diagnosticEvent` to receive optional tick metadata:

```ts
function diagnosticEvent(
  level: "debug" | "info" | "warn",
  message: string,
  platform?: Platform,
  tickContext?: Pick<DiagnosticEvent, "globalTickId" | "platformTickId">,
): void {
  void reportBestEffort([{
    category: "diagnostic",
    level,
    message,
    platform,
    ...tickContext,
  }]);
}
```

Before reporting a tick's collected events, decorate only diagnostics:

```ts
function correlateTickDiagnostics(
  events: readonly EngineEvent[],
  tickContext: Pick<DiagnosticEvent, "globalTickId" | "platformTickId">,
): EngineEvent[] {
  return events.map((event) =>
    event.category === "diagnostic" ? { ...event, ...tickContext } : event);
}
```

Use the correlated array in both the success and scheduler-error
`persistPlatformAndReport` paths. Pass the context to the immediate start,
authentication timing, and finish diagnostics.

- [ ] **Step 6: Run focused tests and typechecks**

Run:

```bash
pnpm --dir packages/extension exec vitest run tests/backgroundController.test.ts tests/activityStorage.test.ts tests/activityLogView.test.tsx
pnpm --filter @lurkloot/shared --filter @lurkloot/core --filter @lurkloot/extension typecheck
git diff --check
```

Expected: all tests and typechecks pass; no whitespace errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/events.ts packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): add dual tick diagnostic identifiers"
```

### Task 2: Verify delivery

**Files:**
- Verify only: all workspace packages and browser builds

**Interfaces:**
- Consumes: completed dual identifier implementation from Task 1
- Produces: verified Chrome and Firefox extension builds

- [ ] **Step 1: Search for stale global-only tick formatting**

Run:

```bash
rg -n "tickSequence|Tick #\\$\\{tickId\\}" packages/core packages/extension
```

Expected: no stale single-counter declaration or lifecycle interpolation.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension and CLI tests, site
build, and both Chromium and Firefox production builds pass.

- [ ] **Step 3: Check final branch state**

Run:

```bash
git status --short
git diff --check
git log --oneline -3
```

Expected: clean worktree, no diff errors, and the feature commit at `HEAD`.

- [ ] **Step 4: Push the existing issue branch**

```bash
git push origin perf/scheduler-platform-concurrency
```

Expected: the existing pull request branch updates without a force push.

