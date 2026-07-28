# Preempt In-Flight Scheduler Ticks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel in-flight scheduler work before factory reset or runtime shutdown so stale work cannot delay or race cleanup.

**Architecture:** Each controller tick owns an `AbortController` registered for its full lifetime. Its signal flows through scheduler options and adapter operations into transports, integrity acquisition, and page-context work; reset and shutdown abort registered ticks before serialized cleanup, while cancellation rolls back without error persistence.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, WXT WebExtension APIs, Node fetch.

## Global Constraints

- Keep `@lurkloot/core` browser-free and do not import WXT or browser globals.
- Preserve the controller's settings/state serialization around host storage reset.
- Treat cancellation as expected control flow: no partial state save, interruption event, or error diagnostic.
- Preserve ordinary scheduler failure behavior.
- Use deterministic mocked tests rather than live Twitch or Kick calls.

---

### Task 1: Define Scheduler Cancellation Contract

**Files:**
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Produces: `SchedulerTickOptions.signal?: AbortSignal`
- Produces: optional `signal?: AbortSignal` final argument on every async `PlatformAdapter` operation used by a scheduler tick.

- [ ] **Step 1: Write a failing scheduler test**

Add a test that creates an `AbortController`, blocks the first mocked adapter
operation, aborts it, and asserts later adapter side effects are not called:

```ts
it("stops scheduler side effects when its signal aborts", async () => {
  const abort = new AbortController();
  const tickAdapters = adapters();
  tickAdapters.twitch.discoverCampaigns.mockImplementation(async (signal?: AbortSignal) => {
    abort.abort(new DOMException("reset", "AbortError"));
    signal?.throwIfAborted();
    return [];
  });

  await expect(runSchedulerTick(baseState, tickSettings, tickAdapters, {
    signal: abort.signal,
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(tickAdapters.twitch.readProgress).not.toHaveBeenCalled();
  expect(tickAdapters.twitch.prepareWatchTab).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: FAIL because `signal` is not passed to `discoverCampaigns`.

- [ ] **Step 3: Add signal parameters and phase checks**

Add `signal?: AbortSignal` to `SchedulerTickOptions`. Add an optional final
signal argument to adapter methods, for example:

```ts
discoverCampaigns(signal?: AbortSignal): Promise<DropCampaign[]>;
readProgress(
  campaigns: DropCampaign[],
  session?: WatchSession,
  signal?: AbortSignal,
): Promise<DropCampaign[]>;
```

Use `options.signal?.throwIfAborted()` before each scheduler phase and pass
`options.signal` to every adapter call.

- [ ] **Step 4: Run scheduler tests and verify GREEN**

Run the focused command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/core/src/platforms/adapter.ts packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "refactor(scheduler): add tick cancellation contract"
```

### Task 2: Propagate Cancellation Through Platform I/O

**Files:**
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Modify: `packages/cli/src/transport/common.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/tabs.test.ts`
- Test: `packages/cli/tests/transport.test.ts`

**Interfaces:**
- Consumes: optional signal arguments from `PlatformAdapter`.
- Produces: `TwitchIntegrityRequest.signal?: AbortSignal`.
- Produces: transport calls whose `RequestInit.signal` is the active tick signal.

- [ ] **Step 1: Write failing propagation tests**

Add focused tests asserting an adapter request receives the scheduler-owned
signal, an integrity refresh rejects promptly when it aborts, and the CLI
transport forwards caller cancellation:

```ts
const abort = new AbortController();
await adapter.discoverCampaigns(abort.signal);
expect(fetchJson).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({ signal: abort.signal }),
  expect.any(Function),
);
```

- [ ] **Step 2: Run adapter, tabs, and CLI transport tests and verify RED**

```bash
pnpm --filter @lurkloot/extension test -- adapters.test.ts tabs.test.ts
pnpm --filter @lurkloot/cli test -- transport.test.ts
```

Expected: at least one assertion fails because the signal is dropped.

- [ ] **Step 3: Forward signals through implementations**

Add `signal?: AbortSignal` to adapter implementations and thread it into
transport `RequestInit`, `ensureIntegrity({ signal })`, page-context acquisition,
and abort-aware wait helpers. Call `signal?.throwIfAborted()` before retries and
side effects.

- [ ] **Step 4: Run focused propagation tests and verify GREEN**

Run the commands from Step 2. Expected: PASS.

- [ ] **Step 5: Commit propagation**

```bash
git add packages/core/src/platforms packages/core/src/core/tabs.ts packages/extension/src/core/tabs.ts packages/extension/tests packages/cli/src/transport packages/cli/tests
git commit -m "refactor(platforms): propagate scheduler cancellation"
```

### Task 3: Preempt Ticks During Reset and Shutdown

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/cli/src/runtime/run.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`
- Test: `packages/cli/tests/runtime.test.ts`

**Interfaces:**
- Consumes: `SchedulerTickOptions.signal`.
- Produces: `controller.shutdown(): void`.
- Produces: controller-owned collection of active tick `AbortController`s.

- [ ] **Step 1: Write failing controller tests**

Add deferred-adapter tests that start a tick, observe its signal, then call
reset or shutdown:

```ts
it("preempts an in-flight tick before host reset", async () => {
  const env = harness(farming(DEFAULT_SETTINGS));
  let tickSignal!: AbortSignal;
  env.twitch.discoverCampaigns.mockImplementation((signal?: AbortSignal) => {
    tickSignal = signal!;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });

  const ticking = env.controller.tick();
  await vi.waitFor(() => expect(tickSignal).toBeDefined());
  const resetHostStorage = vi.fn();
  await env.controller.prepareForHostReset(resetHostStorage);
  await ticking;

  expect(tickSignal.aborted).toBe(true);
  expect(resetHostStorage).toHaveBeenCalledOnce();
  expect(env.deps.saveState).not.toHaveBeenCalledWith(
    expect.objectContaining({ lastTickAt: expect.any(String) }),
  );
});
```

Add a parallel test for `shutdown()`, repeat invocation, and absence of
interruption/error persistence.

- [ ] **Step 2: Run controller tests and verify RED**

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: FAIL because ticks have no owned controller and `shutdown` is absent.

- [ ] **Step 3: Implement tick ownership and cancellation rollback**

Register a new controller at the start of `tick`, pass its signal through auth
refresh and `runSchedulerTick`, and remove it in `finally`. Add:

```ts
function abortActiveTicks(reason: unknown): void {
  for (const controller of activeTicks) controller.abort(reason);
}

function shutdown(): void {
  abortActiveTicks(new DOMException("Controller shutdown", "AbortError"));
  abortClaimHandoffs();
}
```

Call `abortActiveTicks` at the beginning of `prepareForHostReset`. In the
scheduler catch path, if the owned signal is aborted, clear observations and
return without `persistAndReport`. Ensure `tickAndHandOff` skips handoff after
cancellation.

- [ ] **Step 4: Wire runtime shutdown**

Replace CLI teardown's direct `abortClaimHandoffs()` call with
`controller.shutdown()`. Wire any existing browser runtime teardown hook to the
same idempotent method without relying on asynchronous completion.

- [ ] **Step 5: Run controller and CLI runtime tests and verify GREEN**

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm --filter @lurkloot/cli test -- runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit controller behavior**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts packages/cli/src/runtime/run.ts packages/cli/tests/runtime.test.ts
git commit -m "fix(controller): preempt ticks during reset and shutdown"
```

### Task 4: Regression and Release Verification

**Files:**
- Modify only files required by failures attributable to Tasks 1–3.

**Interfaces:**
- Consumes: completed cancellation behavior.
- Produces: a verified PR branch that closes issue 293.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check origin/develop...HEAD
git status --short
```

Expected: no whitespace errors and only intentional changes.

- [ ] **Step 2: Run repository verification**

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension tests, site build, and
both browser extension builds all pass.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff --stat origin/develop...HEAD
git diff origin/develop...HEAD
```

Confirm cancellation reaches every scheduler adapter call, reset aborts before
locking, shutdown is idempotent, and no cancellation path persists an error.

- [ ] **Step 4: Commit any verification-only fixes**

```bash
git add <only-files-fixed-after-verification>
git commit -m "fix(controller): complete tick cancellation coverage"
```

Skip this commit when verification required no changes.

- [ ] **Step 5: Push and open the PR**

Push `fix/preempt-in-flight-tick` and create a ready-for-review PR into
`develop` with a Conventional Commit title, a concise summary, verification
results, and `Closes #293`.
