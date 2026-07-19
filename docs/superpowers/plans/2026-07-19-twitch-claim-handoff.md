# Post-Claim Reward Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Twitch reward is claimed, run a bounded, abortable refresh loop that detects the next eligible reward and starts earning on it immediately, instead of waiting up to a minute for the fixed watch alarm.

**Architecture:** A new `runClaimHandoff(platform)` in `packages/core/src/background/controller.ts` re-runs the existing scoped `tick([platform])` on a configurable interval until the session lands on a different reward, then fires one immediate tabless heartbeat. It runs outside the controller's state lock (each inner `tick()` takes the lock itself), is gated on a new `supportsPostClaimHandoff` adapter capability, and is bounded by a deadline computed once at start. Design: `docs/superpowers/specs/2026-07-19-twitch-claim-handoff-design.md`.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (Node environment, globals enabled), React (popup UI), WXT (extension shell).

**Conventions that apply to every task:**
- Two-space indentation, double quotes, semicolons, camelCase functions/variables, `type` imports for types.
- Conventional Commits, imperative mood, no trailing period.
- Run tests with `pnpm test` from the repo root. To run a single file: `pnpm --filter @lurkloot/extension exec vitest run tests/<file> -t "<test name>"`.
- `packages/core` must never import WXT or browser globals; `packages/extension/tests/coreBoundary.test.ts` enforces this.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/shared/src/models.ts` | `EngineSettings` contract | Add 3 fields |
| `packages/shared/src/settings.ts` | Defaults + normalization/clamping | Add 3 defaults, 3 merge lines |
| `packages/core/src/platforms/adapter.ts` | `PlatformAdapter` contract | Add capability flag |
| `packages/core/src/platforms/twitch/index.ts` | Twitch adapter | Declare capability |
| `packages/core/src/background/controller.ts` | Handoff driver, abort map, triggers, `wait` dep | Main implementation |
| `packages/cli/src/config.ts` | JSONC config template | Add 3 entries |
| `packages/popup-ui/src/settings.tsx` | Advanced settings UI | Add 3 rows |
| `packages/locales/messages/*.json` (10 files) | UI copy | Add 6 keys each |
| `packages/extension/tests/settings.test.ts` | Clamping coverage | Add cases |
| `packages/extension/tests/backgroundController.test.ts` | Handoff behavior coverage | Add suite |

Tasks 1–2 are pure contract/settings work with no behavior. Task 3 adds the capability. Tasks 4–8 build the handoff incrementally, each with its own failing test first. Tasks 9–10 are configuration surfaces.

---

## Task 1: Engine settings fields, defaults, and clamping

**Files:**
- Modify: `packages/shared/src/models.ts:261`
- Modify: `packages/shared/src/settings.ts:60`, `packages/shared/src/settings.ts:134`
- Test: `packages/extension/tests/settings.test.ts:111`

- [ ] **Step 1: Write the failing test**

In `packages/extension/tests/settings.test.ts`, add a new test after the existing `"clamps persisted numeric settings to browser-safe ranges"` test (which ends around line 118):

```typescript
  it("clamps post-claim handoff settings and defaults them when absent", () => {
    expect(mergeSettings({}).postClaimHandoff).toBe(true);
    expect(mergeSettings({}).postClaimHandoffIntervalSeconds).toBe(5);
    expect(mergeSettings({}).postClaimHandoffMaxSeconds).toBe(45);

    expect(mergeSettings({ postClaimHandoffIntervalSeconds: 0 }).postClaimHandoffIntervalSeconds).toBe(1);
    expect(mergeSettings({ postClaimHandoffIntervalSeconds: 99 }).postClaimHandoffIntervalSeconds).toBe(30);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: 1 }).postClaimHandoffMaxSeconds).toBe(5);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: 999 }).postClaimHandoffMaxSeconds).toBe(120);

    expect(mergeSettings({ postClaimHandoffIntervalSeconds: Number.NaN }).postClaimHandoffIntervalSeconds)
      .toBe(DEFAULT_SETTINGS.postClaimHandoffIntervalSeconds);
    expect(mergeSettings({ postClaimHandoffMaxSeconds: Number.NaN }).postClaimHandoffMaxSeconds)
      .toBe(DEFAULT_SETTINGS.postClaimHandoffMaxSeconds);
    expect(mergeSettings({ postClaimHandoff: false }).postClaimHandoff).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts -t "clamps post-claim handoff"`

Expected: FAIL. TypeScript will report that `postClaimHandoff` does not exist on the settings type.

- [ ] **Step 3: Add the fields to the engine contract**

In `packages/shared/src/models.ts`, replace lines 261-262:

```typescript
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
```

with:

```typescript
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim handoff. After a reward is claimed, re-run discovery for
  // that platform on this cadence until the next eligible reward appears, then
  // transmit immediately instead of waiting for the fixed one-minute watch
  // alarm. Only platforms whose adapter sets supportsPostClaimHandoff use it.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
```

- [ ] **Step 4: Add the defaults**

In `packages/shared/src/settings.ts`, replace lines 60-61:

```typescript
  offlineRetryLimit: 3,
  pollIntervalMinutes: 1,
```

with:

```typescript
  offlineRetryLimit: 3,
  pollIntervalMinutes: 1,
  postClaimHandoff: true,
  // Nine refreshes at most, always finishing before the next one-minute watch
  // alarm so the handoff and the alarm never contend for the same heartbeat.
  postClaimHandoffIntervalSeconds: 5,
  postClaimHandoffMaxSeconds: 45,
```

- [ ] **Step 5: Add the normalization**

In `packages/shared/src/settings.ts`, replace line 136 (the `pollIntervalMinutes` line inside `mergeEngineSettings`) so the block reads:

```typescript
    // chrome.alarms floors periodInMinutes at 1, so sub-minute values are inert.
    pollIntervalMinutes: clampNumber(value?.pollIntervalMinutes, 1, 60, DEFAULT_ENGINE_SETTINGS.pollIntervalMinutes),
    postClaimHandoff: booleanOr(value?.postClaimHandoff, DEFAULT_ENGINE_SETTINGS.postClaimHandoff),
    postClaimHandoffIntervalSeconds: clampInteger(value?.postClaimHandoffIntervalSeconds, 1, 30, DEFAULT_ENGINE_SETTINGS.postClaimHandoffIntervalSeconds),
    postClaimHandoffMaxSeconds: clampInteger(value?.postClaimHandoffMaxSeconds, 5, 120, DEFAULT_ENGINE_SETTINGS.postClaimHandoffMaxSeconds),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/settings.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 7: Typecheck the workspace**

Run: `pnpm typecheck`

Expected: exit 0. If `packages/cli` fails because `DEFAULT_CLI_SETTINGS` is built from `DEFAULT_ENGINE_SETTINGS` by spread, no change is needed — it inherits the new fields. If it fails for another reason, fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "feat(settings): add post-claim handoff engine settings"
```

---

## Task 2: Adapter capability flag

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts:56`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Test: `packages/extension/tests/adapters.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/extension/tests/adapters.test.ts`, add this test inside the `describe("TwitchAdapter", ...)` block. Both adapters accept a bare fetcher (see line 666, `new TwitchAdapter(fetcher)`, and line 136, `new KickAdapter(fetcher)`), so reuse the `fetcher` fixture already in scope there:

```typescript
  it("declares the post-claim handoff capability for Twitch only", () => {
    expect(new TwitchAdapter(fetcher).supportsPostClaimHandoff).toBe(true);
    expect(new KickAdapter(fetcher).supportsPostClaimHandoff).toBeUndefined();
  });
```

`KickAdapter` is already imported at line 3 of that file, so no new import is needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts -t "post-claim handoff capability"`

Expected: FAIL — `supportsPostClaimHandoff` is not a property of `PlatformAdapter`.

- [ ] **Step 3: Add the capability to the adapter contract**

In `packages/core/src/platforms/adapter.ts`, after line 57 (`createTablessWatcher?(): TablessWatchController;`) and before the closing brace of `PlatformAdapter`:

```typescript
  // Whether a bounded post-claim refresh is worthwhile on this platform. Twitch
  // only reveals the next reward in a campaign chain on a subsequent inventory
  // read, so re-polling recovers watch time the fixed alarm would otherwise
  // waste. Kick's tabless watcher holds a persistent viewer socket and paces
  // its own sends, so it has no equivalent dead minute to recover.
  supportsPostClaimHandoff?: boolean;
```

- [ ] **Step 4: Declare it on the Twitch adapter**

In `packages/core/src/platforms/twitch/index.ts`, `supportsTabless = true;` is a plain class property on line 710. Add directly beneath it:

```typescript
  supportsPostClaimHandoff = true;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/platforms/adapter.ts packages/core/src/platforms/twitch/index.ts packages/extension/tests/adapters.test.ts
git commit -m "feat(core): add post-claim handoff adapter capability"
```

---

## Task 3: Injectable `wait` dependency

The handoff sleeps between refreshes. Real `setTimeout` would make every test in Task 5 onward slow and flaky, so the delay becomes an injectable dependency first. This task adds it with no caller — Task 5 is the first consumer.

**Files:**
- Modify: `packages/core/src/background/controller.ts:106` (end of `BackgroundControllerDeps`)

- [ ] **Step 1: Add the dependency to the interface**

In `packages/core/src/background/controller.ts`, inside `BackgroundControllerDeps`, after the `stopPageContextTabs?` field (line 106) and before the closing brace:

```typescript
  // Delay used by the bounded post-claim handoff. Injected so tests can drive
  // the loop deterministically instead of racing real timers. Resolves early
  // (without throwing) when the signal aborts, so callers check `signal.aborted`
  // after awaiting rather than catching.
  wait?(ms: number, signal: AbortSignal): Promise<void>;
```

- [ ] **Step 2: Add the default implementation**

In `packages/core/src/background/controller.ts`, immediately after the `createBackgroundController` function opens (after line 111, `const reportedCompatibilityWarnings = new Set<string>();`), add:

```typescript
  const wait: NonNullable<BackgroundControllerDeps<S>["wait"]> = deps.wait ?? ((ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }));
```

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm typecheck && pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts`

Expected: typecheck exit 0; all existing controller tests PASS. The new `wait` is unused so far, which is expected. If your linter fails on the unused binding, leave the commit for Task 4 and continue — Task 4 consumes it.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/background/controller.ts
git commit -m "refactor(core): inject the controller delay used by the claim handoff"
```

---

## Task 4: `tick()` reports which platforms claimed

The handoff needs to know a claim happened. `tick()` already runs inside `withEventCollector` and sees every emitted event, so it can collect the platforms that produced a `reward_claimed` activity event and return them. Its signature changes from `Promise<void>` to `Promise<Platform[]>`; all existing call sites ignore the value and keep compiling.

**Files:**
- Modify: `packages/core/src/background/controller.ts:359-401`
- Test: `packages/extension/tests/backgroundController.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/extension/tests/backgroundController.test.ts`, add this test inside the top-level `describe("background controller", ...)` block:

```typescript
  it("reports the platforms that claimed a reward from tick", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: true });
    env.twitch.discoverCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

    const claimed = await env.controller.tick();

    expect(claimed).toEqual(["twitch"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "reports the platforms that claimed"`

Expected: FAIL — `claimed` is `undefined`, not `["twitch"]`.

- [ ] **Step 3: Return claimed platforms from tick**

In `packages/core/src/background/controller.ts`, change the `tick` signature on line 359 from:

```typescript
  async function tick(platforms?: Platform[], options?: { forcePaused?: boolean }): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
```

to:

```typescript
  async function tick(platforms?: Platform[], options?: { forcePaused?: boolean }): Promise<Platform[]> {
    const claimedPlatforms = new Set<Platform>();
    await withStateLock(() => withEventCollector(async (emit, events) => {
```

Inside that closure, the scheduler is invoked with an `emit` that is passed through to `runSchedulerTick`. Wrap it so claims are observed. Replace the `runSchedulerTick` call (lines 373-378) with:

```typescript
        const claimObservingEmit: EventEmitter = (event) => {
          if (event.category === "activity" && event.code === "reward_claimed" && event.platform) {
            claimedPlatforms.add(event.platform);
          }
          emit(event);
        };
        const result = await runSchedulerTick(state, settings, adapters, {
          ...(platforms ? { platforms } : {}),
          stopPageContextTabs: deps.stopPageContextTabs,
          waitingClaimRewardIds: nextWaitingClaimRewardIds,
          emit: claimObservingEmit,
        });
```

In the `catch` block (line 385), the tick failed and any partial claim set is not actionable, so add as its first statement:

```typescript
        claimedPlatforms.clear();
```

Then change the end of the function (line 401) from:

```typescript
    }));
  }
```

to:

```typescript
    }));
    return [...claimedPlatforms];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts`

Expected: PASS, including all pre-existing controller tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): report claimed platforms from the scheduler tick"
```

---

## Task 5: The bounded handoff loop

This is the core of the feature: the loop, the abort map, the deadline, and the stop conditions. The immediate heartbeat is deliberately deferred to Task 6 so this task's tests isolate loop control from transmission.

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

- [ ] **Step 1: Add the test harness helper**

In `packages/extension/tests/backgroundController.test.ts`, add this helper next to the existing `tablessEnv` helper (around line 1721). It gives tests a `wait` they advance by hand:

```typescript
  function manualWait() {
    const pending: Array<() => void> = [];
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    // Releases every currently-parked wait and yields so the loop can advance.
    const flush = async () => {
      for (const resolve of pending.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { wait, flush, get parked() { return pending.length; } };
  }
```

- [ ] **Step 2: Write the failing tests**

`harness` must accept the injected `wait`. First extend `harness`'s `overrides` parameter (line 55) from:

```typescript
  overrides: {
    saveState?: (state: SchedulerState) => Promise<void>;
    reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
  } = {},
```

to:

```typescript
  overrides: {
    saveState?: (state: SchedulerState) => Promise<void>;
    reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
```

and add `wait: overrides.wait,` to the `deps` object literal (after `reportEvents`, around line 90).

Then add this suite at the end of `describe("background controller", ...)`:

```typescript
  describe("post-claim handoff", () => {
    // Twitch-only environment whose adapter opts into the handoff and whose
    // campaign yields a claimable reward on the first pass.
    function handoffEnv(overrides: Partial<ExtensionSettings> = {}) {
      const timer = manualWait();
      const env = harness({
        ...DEFAULT_SETTINGS,
        running: true,
        autoClaim: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, watchQueueChannels: [] },
        },
        ...overrides,
      }, { wait: timer.wait });
      env.twitch.supportsPostClaimHandoff = true;
      return { ...env, timer };
    }

    // A campaign whose first reward is claimable and whose second reward only
    // becomes visible on a later inventory read — the exact Twitch behavior the
    // handoff exists to absorb.
    function chainedCampaign(revealSecond: boolean): DropCampaign {
      const first: DropReward = { id: "reward-1", name: "First", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" };
      const second: DropReward = { id: "reward-2", name: "Second", requiredMinutes: 60, watchedMinutes: 0, status: "in_progress" };
      return {
        id: "twitch-campaign",
        platform: "twitch",
        name: "twitch campaign",
        status: "active",
        rewards: revealSecond ? [first, second] : [first],
      };
    }

    it("starts earning the next reward before the next heartbeat alarm", async () => {
      const env = handoffEnv();
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
    });

    it("stops at the deadline when no next reward appears", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      // 15s budget at a 5s interval is three refreshes, never ten.
      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("exits early when the platform has no eligible reward left", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => []);

      const handoff = env.controller.runClaimHandoff("twitch");
      await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("aborts in flight when farming stops", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      await Promise.resolve();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
      expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    });

    it("does not run for a platform without the capability", async () => {
      const env = handoffEnv();
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("does not run when the setting is disabled", async () => {
      const env = handoffEnv({ postClaimHandoff: false });

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "post-claim handoff"`

Expected: FAIL — `env.controller.runClaimHandoff is not a function`.

- [ ] **Step 4: Implement the handoff**

In `packages/core/src/background/controller.ts`, add near the other module-level state (next to `stateMutation`, around line 65):

```typescript
// In-flight post-claim handoffs, one per platform. A claim arriving while a
// handoff is already running for that platform is absorbed by the running loop
// rather than starting a second one, which is what keeps the work bounded.
const claimHandoffs = new Map<Platform, AbortController>();
```

Then add these two functions inside `createBackgroundController`, immediately after `runWatchHeartbeat` (after line 592):

```typescript
  // Aborts every in-flight handoff. Called when farming stops, when a settings
  // session begins, and on runtime restart.
  function abortClaimHandoffs(): void {
    for (const controller of claimHandoffs.values()) controller.abort();
    claimHandoffs.clear();
  }

  // Bounded post-claim handoff (see docs/superpowers/specs/2026-07-19-twitch-claim-handoff-design.md).
  // Re-runs a scoped tick on the configured cadence until the platform lands on
  // a reward other than the ones just claimed, then hands off to the immediate
  // heartbeat. Runs OUTSIDE the state lock: each inner tick() acquires the lock
  // on its own, so a long handoff never blocks telemetry or user actions.
  async function runClaimHandoff(platform: Platform): Promise<void> {
    if (claimHandoffs.has(platform)) return;
    const settings = await deps.loadSettings();
    if (!settings.postClaimHandoff || !settings.running) return;
    if (!settings.platform[platform].enabled) return;

    const adapters = createAdapters(settings, () => undefined);
    if (!adapters[platform].supportsPostClaimHandoff) return;

    const before = await deps.loadState();
    const claimedRewardIds = new Set<string>();
    const startingRewardId = before.sessions[platform].rewardId;
    if (startingRewardId) claimedRewardIds.add(startingRewardId);

    const abort = new AbortController();
    claimHandoffs.set(platform, abort);
    // The deadline is computed once. A claim occurring inside the loop never
    // extends it, so the worst case stays fixed at maxSeconds.
    const deadline = Date.now() + settings.postClaimHandoffMaxSeconds * 1000;
    const intervalMs = settings.postClaimHandoffIntervalSeconds * 1000;

    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        await wait(intervalMs, abort.signal);
        if (abort.signal.aborted) break;

        const claimed = await tick([platform]);
        for (const claimedPlatform of claimed) {
          if (claimedPlatform !== platform) continue;
          const rewardId = (await deps.loadState()).sessions[platform].rewardId;
          if (rewardId) claimedRewardIds.add(rewardId);
        }
        if (abort.signal.aborted) break;

        const session = (await deps.loadState()).sessions[platform];
        if (session.status === "watching" && session.rewardId && !claimedRewardIds.has(session.rewardId)) {
          await sendImmediateHeartbeat(platform, session);
          return;
        }
        // Nothing eligible left on this platform: the chain is finished, so stop
        // rather than burning the rest of the budget on identical refreshes.
        if (session.status !== "watching" && session.reasonCode === "campaign_ineligible") return;
      }
    } finally {
      if (claimHandoffs.get(platform) === abort) claimHandoffs.delete(platform);
    }
  }
```

Add a temporary stub for the heartbeat, which Task 6 replaces:

```typescript
  // Replaced with the real immediate heartbeat in Task 6.
  async function sendImmediateHeartbeat(_platform: Platform, _session: WatchSession): Promise<void> {
    return;
  }
```

Finally, export both from the controller's return object (line 955), so it reads:

```typescript
  return {
    ensureAlarm,
    handleStartup,
    handleTabRemoved,
    handleMessage,
    beginSettingsSession,
    endSettingsSession,
    captureTwitchIntegrity,
    tick,
    runWatchHeartbeat,
    runClaimHandoff,
    abortClaimHandoffs,
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts`

Expected: PASS, including all pre-existing controller tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): add the bounded post-claim reward handoff loop"
```

---

## Task 6: Immediate tabless heartbeat on success

**Files:**
- Modify: `packages/core/src/background/controller.ts` (replaces the Task 5 stub)
- Test: `packages/extension/tests/backgroundController.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these to the `describe("post-claim handoff", ...)` block. They need a tabless watcher, so they combine `handoffEnv` with the existing `fakeTablessWatcher` helper:

```typescript
    it("sends one immediate heartbeat when the next reward starts tablessly", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).toHaveBeenCalledTimes(1);
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    });

    it("skips the immediate heartbeat when one just landed on the same channel", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      // Establish the tabless session and land a heartbeat seconds ago.
      await env.controller.tick();
      await env.controller.runWatchHeartbeat();
      watcher.tick.mockClear();

      reveal = true;
      const handoff = env.controller.runClaimHandoff("twitch");
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("sends no heartbeat when the next reward runs in a visible tab", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: false });
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).not.toHaveBeenCalled();
      // The tick that detected the successor already re-pointed the tab.
      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
      expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "immediate heartbeat"`

Expected: FAIL — the stub sends nothing, so `watcher.tick` is never called in the first test.

- [ ] **Step 3: Implement the immediate heartbeat**

In `packages/core/src/background/controller.ts`, replace the Task 5 stub with:

```typescript
  // How recently a heartbeat must have landed for the handoff to consider the
  // channel already covered. Half the fixed one-minute alarm period: long
  // enough to suppress a genuine double-send, short enough that a real handoff
  // still transmits.
  const RECENT_HEARTBEAT_MS = 30_000;

  // Transmits one heartbeat for a freshly-selected tabless target instead of
  // waiting for the next watch alarm. A visible tab needs nothing: it earns
  // progress continuously and the detecting tick already re-pointed it.
  async function sendImmediateHeartbeat(platform: Platform, session: WatchSession): Promise<void> {
    if (session.watchMode !== "tabless") return;
    const watcher = tablessWatchers.get(platform);
    if (!watcher) return;

    // A channel switch always transmits: lastHeartbeatAt then refers to the
    // previous target, so its recency says nothing about the new one.
    const sameChannel = watcher.channelUrl != null && watcher.channelUrl === session.channel?.url;
    const lastHeartbeatAt = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Number.NaN;
    const recent = !Number.isNaN(lastHeartbeatAt) && Date.now() - lastHeartbeatAt < RECENT_HEARTBEAT_MS;
    if (sameChannel && recent) return;

    await withStateLock(() => withEventCollector(async (emit, events) => {
      let ok = false;
      let message: string | undefined;
      drainWatcherEvents(watcher, emit);
      try {
        const result = await watcher.tick(tablessWatchContext());
        ok = result.ok;
        message = result.message;
      } catch (error) {
        message = error instanceof Error ? error.message : "Post-claim heartbeat failed";
      } finally {
        drainWatcherEvents(watcher, emit);
      }

      const state = await deps.loadState();
      const current = state.sessions[platform];
      const nextState: SchedulerState = {
        ...state,
        sessions: {
          ...state.sessions,
          [platform]: {
            ...current,
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeatOk: ok,
            heartbeatChecks: ok ? 0 : (current.heartbeatChecks ?? 0) + 1,
          },
        },
      };
      emit({
        category: "diagnostic",
        platform,
        level: ok ? "debug" : "warn",
        message: ok
          ? "Post-claim handoff started the next reward without waiting for the watch alarm"
          : message ?? "Post-claim heartbeat failed",
      });
      await persistAndReport(nextState, events);
    }));
  }
```

Note the lock discipline: `runClaimHandoff` holds no lock when it calls this, and `tick()` has already released its own, so acquiring here is safe and non-reentrant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): transmit immediately when the post-claim handoff finds a reward"
```

---

## Task 7: Wire the triggers and aborts

The handoff exists but nothing starts it. This task connects it to automatic claims, manual claims, and the lifecycle events that must cancel it.

**Files:**
- Modify: `packages/core/src/background/controller.ts:289-360`, `:594-604`, `:804`
- Test: `packages/extension/tests/backgroundController.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `describe("post-claim handoff", ...)` block:

```typescript
    it("starts a handoff after an automatic claim", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.tickAndHandOff();
      await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalled();
    });

    it("does not start a nested handoff for a claim inside a handoff", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      // Every refresh yields another claimable reward, which would restart the
      // deadline forever if nesting were allowed.
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it("aborts running handoffs when a settings session begins", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      await Promise.resolve();
      await env.controller.beginSettingsSession();
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts -t "handoff"`

Expected: FAIL — `env.controller.tickAndHandOff is not a function`.

- [ ] **Step 3: Add the combined entry point**

In `packages/core/src/background/controller.ts`, immediately after `runClaimHandoff`, add:

```typescript
  // The normal entry point for alarm- and message-driven ticks: run the tick,
  // then hand off for every platform that claimed. Kept separate from tick() so
  // the handoff's own inner ticks cannot recurse into another handoff.
  async function tickAndHandOff(platforms?: Platform[]): Promise<void> {
    const claimed = await tick(platforms);
    for (const platform of claimed) await runClaimHandoff(platform);
  }
```

Recursion is structurally impossible: `runClaimHandoff` calls `tick()`, never `tickAndHandOff()`, and its `claimHandoffs.has(platform)` guard rejects a second entry for the same platform.

- [ ] **Step 4: Route the alarm and message paths through it**

In `packages/core/src/background/controller.ts`, replace `await tick();` with `await tickAndHandOff();` at these call sites, which are the ones driven by the alarm or by user action:

- line 330 (the alarm handler inside `handleMessage`/`handleAlarm`)
- line 840 and line 854 (`if (settings.running) await tick();`)
- line 860-861 (`tickAfterSave`) — becomes `await tickAndHandOff(message.tickAfterSavePlatforms);`
- line 889-890 (`tickNow`)

Leave these call sites on plain `tick()`:

- lines 289-309 (`ensureAlarm` / `handleStartup`) — a restart should not fire a handoff.
- line 590 (`runWatchHeartbeat`'s fallback tick) — a heartbeat fallback is not a claim.
- line 596 (`beginSettingsSession`'s `forcePaused` tick) — this pauses, it does not claim.

- [ ] **Step 5: Trigger from the manual claim path**

The manual claim lives in `claimRewardNow` (line 714). Its `withStateLock(...)` closes on line 805 and is followed by `return snapshot();` on line 806, so the handoff goes between them — after the lock is released, never inside it.

In `packages/core/src/background/controller.ts`, change the opening of `claimRewardNow` from:

```typescript
    await withStateLock(() => withEventCollector(async (emit, events) => {
```

to:

```typescript
    let claimedManually = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
```

Inside the `try` block, line 751 reads `const claimed = await createAdapters(settings, emit)[message.platform].claimReward(campaign, reward);`. Directly beneath it add:

```typescript
        claimedManually = claimed;
```

Then change the end of the function from:

```typescript
      await persistAndReport(stateWithCampaigns, events);
    }));
    return snapshot();
  }
```

to:

```typescript
      await persistAndReport(stateWithCampaigns, events);
    }));
    if (claimedManually) await runClaimHandoff(message.platform);
    return snapshot();
  }
```

- [ ] **Step 6: Abort on the lifecycle events**

In `packages/core/src/background/controller.ts`:

In `beginSettingsSession` (line 594), add `abortClaimHandoffs();` as its first statement:

```typescript
  async function beginSettingsSession(): Promise<void> {
    abortClaimHandoffs();
    settingsPauseCount += 1;
    if (settingsPauseCount === 1) await tick(undefined, { forcePaused: true });
  }
```

In `handleStartup` (line 304), add `abortClaimHandoffs();` alongside the existing watcher reset, so a restart leaves no orphaned loop.

In the `setRunning` message handler (line 826), stopping farming must cancel any loop still refreshing. Change:

```typescript
    if (message.type === "setRunning") {
      await updateStoredSettings({ running: message.running });
      await tick();
      return snapshot();
    }
```

to:

```typescript
    if (message.type === "setRunning") {
      if (!message.running) abortClaimHandoffs();
      await updateStoredSettings({ running: message.running });
      await tickAndHandOff();
      return snapshot();
    }
```

- [ ] **Step 7: Export `tickAndHandOff`**

Add `tickAndHandOff,` to the controller's return object next to `tick`.

- [ ] **Step 8: Run the full controller suite**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 9: Run the whole test suite and typecheck**

Run: `pnpm test && pnpm typecheck`

Expected: both exit 0. `coreBoundary.test.ts` must still pass — nothing added here imports a browser global.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): trigger the post-claim handoff from claim and lifecycle paths"
```

---

## Task 8: CLI JSONC configuration

**Files:**
- Modify: `packages/cli/src/config.ts:59`
- Test: `packages/cli/tests/` (whichever file asserts on `defaultConfigJsonc`)

- [ ] **Step 1: Find the existing config test**

Run: `grep -rn "defaultConfigJsonc" packages/cli/tests/`

If a test parses the template, add an assertion there in Step 2. If none exists, skip to Step 3 — do not invent a new test file for a string template.

- [ ] **Step 2: Add the assertion (only if a test exists)**

```typescript
  it("documents the post-claim handoff settings", () => {
    const parsed = JSON.parse(stripJsonComments(defaultConfigJsonc()));
    expect(parsed.settings.postClaimHandoff).toBe(true);
    expect(parsed.settings.postClaimHandoffIntervalSeconds).toBe(5);
    expect(parsed.settings.postClaimHandoffMaxSeconds).toBe(45);
  });
```

Reuse whatever comment-stripping helper the existing test uses rather than adding a dependency.

- [ ] **Step 3: Add the template entries**

In `packages/cli/src/config.ts`, replace lines 57-59:

```
    "offlineRetryLimit": ${json(defaults.offlineRetryLimit)},
    // How often campaign discovery and watch state are refreshed (1-60 minutes).
    "pollIntervalMinutes": ${json(defaults.pollIntervalMinutes)},
```

with:

```
    "offlineRetryLimit": ${json(defaults.offlineRetryLimit)},
    // How often campaign discovery and watch state are refreshed (1-60 minutes).
    "pollIntervalMinutes": ${json(defaults.pollIntervalMinutes)},

    // After claiming a reward, briefly re-check for the next one in the chain
    // instead of waiting for the regular one-minute watch cycle. Twitch only.
    "postClaimHandoff": ${json(defaults.postClaimHandoff)},
    // Seconds between re-checks (1-30) and the total budget before giving up
    // and falling back to the regular schedule (5-120).
    "postClaimHandoffIntervalSeconds": ${json(defaults.postClaimHandoffIntervalSeconds)},
    "postClaimHandoffMaxSeconds": ${json(defaults.postClaimHandoffMaxSeconds)},
```

- [ ] **Step 4: Verify the template is still valid JSONC**

Run: `pnpm --filter @lurkloot/cli test` (or `pnpm test` if the CLI has no separate suite)

Expected: PASS. If the CLI has no tests covering this, run `pnpm typecheck` and visually confirm the generated template parses by running the CLI's config-init path.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/tests/
git commit -m "feat(cli): expose post-claim handoff settings in the config template"
```

---

## Task 9: Locale strings

Six new keys across all ten catalogs. `packages/extension/tests/i18n.test.ts` checks catalog parity, so a missing key in any one file fails the suite.

**Files:**
- Modify: `packages/locales/messages/en.json` and the nine other catalogs (`ar`, `de`, `es`, `fr`, `hi`, `it`, `pt_BR`, `ru`, `zh_CN`)

- [ ] **Step 1: Add the English strings**

In `packages/locales/messages/en.json`, next to the existing `schedulerIntervalTitle` block (line 419), add:

```json
  "postClaimHandoffTitle": {
    "message": "Fast reward handoff"
  },
  "postClaimHandoffDescription": {
    "message": "After claiming a drop, briefly check for the next reward in the campaign instead of waiting for the next scheduled cycle. Twitch only."
  },
  "postClaimHandoffIntervalTitle": {
    "message": "Handoff check interval"
  },
  "postClaimHandoffIntervalDescription": {
    "message": "How long to wait between checks for the next reward."
  },
  "postClaimHandoffMaxTitle": {
    "message": "Handoff time limit"
  },
  "postClaimHandoffMaxDescription": {
    "message": "Give up and return to the regular schedule after this long."
  },
```

- [ ] **Step 2: Translate into the other nine catalogs**

Add the same six keys to each of `ar.json`, `de.json`, `es.json`, `fr.json`, `hi.json`, `it.json`, `pt_BR.json`, `ru.json`, `zh_CN.json`, with translated `message` values. Match each file's existing key ordering and tone. Do not leave English text in a non-English catalog — `i18n.test.ts` will not catch that, but a reviewer will.

- [ ] **Step 3: Verify catalog parity**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/i18n.test.ts`

Expected: PASS. A failure here names the catalog and key that is missing.

- [ ] **Step 4: Commit**

```bash
git add packages/locales/messages/
git commit -m "feat(locales): add post-claim handoff settings copy"
```

---

## Task 10: Advanced settings UI

**Files:**
- Modify: `packages/popup-ui/src/settings.tsx:155-158`

- [ ] **Step 1: Add the rows**

In `packages/popup-ui/src/settings.tsx`, inside the Advanced `SettingsSection`, after the existing `schedulerIntervalTitle` `NumberSettingRow` (line 156):

```tsx
        <SettingRow
          title={t("postClaimHandoffTitle")}
          description={t("postClaimHandoffDescription")}
          checked={settings.postClaimHandoff}
          onChange={set("postClaimHandoff")}
        />
        <NumberSettingRow
          title={t("postClaimHandoffIntervalTitle")}
          description={t("postClaimHandoffIntervalDescription")}
          value={settings.postClaimHandoffIntervalSeconds}
          min={1}
          max={30}
          suffix={t("secondsSuffix")}
          disabled={!settings.postClaimHandoff}
          onChange={(value) => onSettingsChange({ postClaimHandoffIntervalSeconds: value })}
        />
        <NumberSettingRow
          title={t("postClaimHandoffMaxTitle")}
          description={t("postClaimHandoffMaxDescription")}
          value={settings.postClaimHandoffMaxSeconds}
          min={5}
          max={120}
          suffix={t("secondsSuffix")}
          disabled={!settings.postClaimHandoff}
          onChange={(value) => onSettingsChange({ postClaimHandoffMaxSeconds: value })}
        />
```

If `NumberSettingRow` does not accept a `disabled` prop, check how `adFocusMode` (line 149-152) handles `disabled` / `disabledReason` and follow that; if the primitive genuinely lacks the prop, add it to `packages/popup-ui/src/primitives.tsx` following `SettingRow`'s existing disabled handling.

- [ ] **Step 2: Verify the settings patch accepts the new fields**

Run: `grep -n "pollIntervalMinutes" packages/shared/src/settings.ts | grep -i patch`

`applySettingsPatch` must pass the three new fields through. If it uses an explicit allowlist of patchable keys, add all three; if it spreads the patch, no change is needed.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm typecheck && pnpm build:site`

Expected: both exit 0. The site imports the real popup UI for its live demo, so a broken settings row fails the site build.

- [ ] **Step 4: Commit**

```bash
git add packages/popup-ui/src/settings.tsx packages/shared/src/settings.ts
git commit -m "feat(popup): add post-claim handoff controls to advanced settings"
```

---

## Task 11: Full verification

- [ ] **Step 1: Run the full check**

Run: `pnpm check`

Expected: exit 0 — script tests, workspace typechecks, extension tests, and the Astro site build all pass.

- [ ] **Step 2: Run both browser builds**

Run: `pnpm verify`

Expected: exit 0. This is `pnpm check` plus the Chromium and Firefox production builds.

- [ ] **Step 3: Confirm no new permissions**

Run: `git diff origin/develop -- packages/extension/wxt.config.ts`

Expected: empty. This feature adds no host permissions; a non-empty diff means something went wrong and must be explained in the PR.

- [ ] **Step 4: Review the diff against the acceptance criteria**

Run: `git diff origin/develop --stat`

Confirm against issue #110: a new reward can begin before the next alarm (Task 6), the loop is bounded and abortable (Task 5), no duplicated claims or heartbeats (Task 5's nesting guard and Task 6's recency guard), failure falls back cleanly (Task 5 never touches alarms), and tests cover success, timeout, abort, no-next-reward, and visible-tab (Tasks 5–7).
