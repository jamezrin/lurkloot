# Twitch Integrity Token Warming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively refresh Twitch integrity tokens before expiry and gate authenticated Twitch work on one bounded acquisition attempt without exposing preparation in the UI.

**Architecture:** Unify Twitch token minting behind one cancellable single-flight primitive in `tabs.ts`. The browser host injects acquisition, cancellation, alarm creation, and alarm clearing into the core controller; the controller owns expiry scheduling and decides when a normal Twitch tick or refresh alarm should acquire a token. A failed acquisition suppresses only Twitch authenticated work until the next normal discovery alarm, leaving Kick independent.

**Tech Stack:** TypeScript, WXT browser APIs, WebExtension alarms/webRequest/tabs, Vitest fake timers and mocks, pnpm workspace scripts.

## Global Constraints

- Implement from `origin/develop` after merge commits `40e6a8c` (#297) and `bb93f6f` (#299/#293).
- Use a one-shot alarm named `lurkloot.twitch-integrity`; do not add permissions because `alarms` is already declared.
- Schedule at `expiresAt - 120_000ms - jitter`, where jitter is a stable integer in `[0, 30_000]` derived locally from the token.
- If that target is not in the future, do not create an immediate alarm; retry on the next normal discovery alarm.
- A failed acquisition never creates a dedicated retry alarm.
- Enabling Twitch persists immediately and never waits for acquisition.
- Do not add popup state, activity events, notifications, locale keys, or user-facing preparation copy.
- Diagnostic messages are English literals and must not contain tokens, cookies, device/session identifiers, or authenticated response content.
- Do not classify integrity availability as Twitch authentication health.
- Do not mint tokens while Twitch is disabled; `EngineSettings` deliberately
  has no separate global `running` flag.
- Do not change Kick or CLI behavior.
- All acquisition paths share one in-flight page-context mint.

---

### Task 1: Make Integrity Acquisition One Cancellable Single Flight

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Consumes: Existing `TwitchIntegrityRequest`, `ensureTwitchIntegrityWithBrowser`, `mintTwitchIntegrity`, and #293 `AbortSignal` support.
- Produces:

```ts
export const INTEGRITY_EXPIRY_SKEW_MS = 30_000;
export function isValidTwitchIntegrity(
  value: TwitchIntegrity | undefined,
  now?: number,
): value is TwitchIntegrity;
export function cancelTwitchIntegrityAcquisition(reason?: unknown): void;
```

`ensureTwitchIntegrityWithBrowser(...)` remains source compatible, but both forced and ordinary mints share the same underlying acquisition.

- [ ] **Step 1: Write failing tests for ordinary single-flight acquisition**

Add focused cases inside the existing `ensureTwitchIntegrityWithBrowser` describe block:

```ts
it("shares one page-context mint between concurrent ordinary acquisitions", async () => {
  const browser = browserMock();
  browser.tabs.create.mockResolvedValue({ id: 51 });

  const first = ensureTwitchIntegrityWithBrowser(
    browser,
    "https://www.twitch.tv/drops/inventory",
    5_000,
  );
  const second = ensureTwitchIntegrityWithBrowser(
    browser,
    "https://www.twitch.tv/drops/inventory",
    5_000,
  );

  await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalledTimes(1));
  setTwitchIntegrity(fresh(), { isNew: true });

  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  expect(browser.tabs.create).toHaveBeenCalledTimes(1);
});
```

Also add:

- cancelling the acquisition removes its newly opened page context and rejects every joined caller;
- after cancellation settles, a later caller can start a new acquisition;
- aborting only a joined caller rejects that caller without cancelling the shared underlying acquisition;
- `isValidTwitchIntegrity` accepts a token outside the 30-second skew and rejects missing, expired, and inside-skew values.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
```

Expected: the concurrent ordinary acquisition test observes more than one acquisition or lacks the new exported helpers.

- [ ] **Step 3: Replace the forced-only promise with an owned acquisition**

In `tabs.ts`, replace `inFlightForcedRefresh` with an entry that owns the underlying abort:

```ts
interface TwitchIntegrityAcquisition {
  promise: Promise<boolean>;
  abort: AbortController;
}

let inFlightIntegrityAcquisition: TwitchIntegrityAcquisition | undefined;

export function cancelTwitchIntegrityAcquisition(reason?: unknown): void {
  inFlightIntegrityAcquisition?.abort.abort(reason);
}
```

Extract the validity predicate so controller policy and request attachment use exactly the same skew:

```ts
export const INTEGRITY_EXPIRY_SKEW_MS = 30_000;

export function isValidTwitchIntegrity(
  value: TwitchIntegrity | undefined,
  now: number = Date.now(),
): value is TwitchIntegrity {
  return value != null && value.expiresAt > now + INTEGRITY_EXPIRY_SKEW_MS;
}

export function hasValidTwitchIntegrity(now: number = Date.now()): boolean {
  return isValidTwitchIntegrity(twitchIntegrity, now);
}
```

Create one internal acquisition for both ordinary and forced requests. The creator’s signal aborts the owned controller because #293 reset/shutdown cancellation owns that operation. Later joiners race only their own signal through `withAbortSignal` and do not cancel the shared acquisition:

```ts
function startTwitchIntegrityAcquisition(
  browserApi: BrowserTabApi,
  originUrl: string,
  timeoutMs: number,
  emit: EventEmitter,
  rejectedToken: string | undefined,
  forceRefresh: boolean,
  ownerSignal?: AbortSignal,
): Promise<boolean> {
  if (inFlightIntegrityAcquisition) {
    diagnostic(emit, "debug", "Joining the Twitch integrity acquisition already in flight", "twitch");
    return withAbortSignal(inFlightIntegrityAcquisition.promise, ownerSignal);
  }

  const abort = new AbortController();
  const abortFromOwner = () => abort.abort(ownerSignal?.reason);
  ownerSignal?.addEventListener("abort", abortFromOwner, { once: true });

  const promise = mintTwitchIntegrity(
    browserApi,
    originUrl,
    timeoutMs,
    emit,
    rejectedToken,
    forceRefresh,
    abort.signal,
  ).finally(() => {
    ownerSignal?.removeEventListener("abort", abortFromOwner);
    if (inFlightIntegrityAcquisition?.promise === promise) {
      inFlightIntegrityAcquisition = undefined;
    }
  });
  inFlightIntegrityAcquisition = { promise, abort };
  return promise;
}
```

Keep the rejected-token replacement fast path before joining or starting an acquisition. Update `resetTwitchIntegrityRefreshBounds()` to abort and clear the unified entry so existing suite isolation remains deterministic.

- [ ] **Step 4: Run tabs tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
pnpm --filter @lurkloot/core typecheck
pnpm --filter @lurkloot/extension typecheck
```

Expected: all commands pass.

- [ ] **Step 5: Commit the acquisition primitive**

```bash
git add packages/core/src/core/tabs.ts packages/extension/tests/tabs.test.ts
git commit -m "refactor(twitch): unify integrity token acquisition"
```

---

### Task 2: Add Expiry Scheduling Policy to the Controller

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: Task 1 `isValidTwitchIntegrity`, existing stored integrity bundle, and injected host operations.
- Produces:

```ts
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

interface BackgroundControllerDeps<S extends EngineSettings> {
  createAlarm(
    name: string,
    options: { periodInMinutes: number } | { when: number },
  ): Promise<void>;
  clearAlarm?(name: string): Promise<boolean>;
  ensureTwitchIntegrity?(
    emit: EventEmitter,
    request?: TwitchIntegrityRequest,
  ): Promise<boolean>;
  cancelTwitchIntegrityAcquisition?(reason?: unknown): void;
}
```

The controller returns a new `runTwitchIntegrityRefresh()` handler for the extension alarm listener.

- [ ] **Step 1: Extend the controller test harness**

Add the new optional dependency mocks:

```ts
clearAlarm: vi.fn(async () => true),
ensureTwitchIntegrity: vi.fn(async () => true),
cancelTwitchIntegrityAcquisition: vi.fn(),
```

Allow `createAlarm` expectations to accept both periodic and one-shot options.

- [ ] **Step 2: Write failing tests for deterministic scheduling**

Add controller tests using synthetic tokens and fake time:

```ts
it("schedules integrity refresh from token expiry with stable bounded jitter", async () => {
  vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
  const integrity = integrityBundle({
    integrity: "stable-test-token",
    expiresAt: Date.now() + 30 * 60_000,
  });
  const env = controllerEnv({ loadTwitchIntegrity: vi.fn(async () => integrity) });

  await env.controller.settleBackgroundWork();

  const calls = env.deps.createAlarm.mock.calls.filter(
    ([name]) => name === TWITCH_INTEGRITY_ALARM_NAME,
  );
  expect(calls).toHaveLength(1);
  const when = (calls[0][1] as { when: number }).when;
  expect(when).toBeLessThanOrEqual(integrity.expiresAt - 120_000);
  expect(when).toBeGreaterThanOrEqual(integrity.expiresAt - 150_000);
});
```

Add separate tests proving:

- loading an expired token logs a debug diagnostic and creates no integrity alarm;
- capturing a replacement persists it and replaces the old one-shot schedule;
- the same token always produces the same jitter;
- a computed target in the past clears any prior alarm and creates no immediate alarm;
- alarm creation failure does not discard or invalidate the captured token;
- no diagnostic includes the token value.

- [ ] **Step 3: Run controller tests and verify failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts
```

Expected: the alarm constant, one-shot alarm dependency, and scheduling behavior do not exist.

- [ ] **Step 4: Implement stable scheduling without exposing token material**

Add an internal non-cryptographic hash used only to distribute alarm times:

```ts
function integrityRefreshJitter(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS + 1);
}
```

Add:

```ts
async function clearTwitchIntegrityAlarm(): Promise<void> {
  await deps.clearAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
}

async function scheduleTwitchIntegrityRefresh(
  integrity: TwitchIntegrity,
  emit?: EventEmitter,
): Promise<void> {
  const when = integrity.expiresAt
    - TWITCH_INTEGRITY_REFRESH_LEAD_MS
    - integrityRefreshJitter(integrity.integrity);
  if (when <= Date.now()) {
    await clearTwitchIntegrityAlarm();
    return;
  }
  await deps.createAlarm(TWITCH_INTEGRITY_ALARM_NAME, { when });
  emit?.({
    category: "diagnostic",
    platform: "twitch",
    level: "debug",
    message: `Scheduled proactive Twitch integrity refresh for ${new Date(when).toISOString()}`,
  });
}
```

Call scheduling after a valid stored token is loaded and after a new captured token is persisted. Keep alarm writes best effort: report their failure, but retain the in-memory and stored token.

- [ ] **Step 5: Run controller tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit expiry scheduling**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(twitch): schedule integrity refresh before expiry"
```

---

### Task 3: Gate Authenticated Twitch Tick Work and Handle the Refresh Alarm

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: Task 2 injected `ensureTwitchIntegrity`, alarm helpers, existing tick `AbortSignal`, and `isFarmingActive`.
- Produces:

```ts
runTwitchIntegrityRefresh(): Promise<void>;
```

The normal tick uses its #293 signal for acquisition and excludes only Twitch from auth refresh and scheduler work when acquisition fails.

- [ ] **Step 1: Write failing normal-tick gating tests**

Add tests proving:

```ts
it("acquires integrity before Twitch auth and scheduler work", async () => {
  const order: string[] = [];
  const env = controllerEnv({
    ensureTwitchIntegrity: vi.fn(async () => {
      order.push("integrity");
      return true;
    }),
    twitchCheckAuthHealth: vi.fn(async () => {
      order.push("auth");
      return healthyAuth("twitch");
    }),
  });

  await env.controller.tick(["twitch"], "manual_tick");
  expect(order).toEqual(["integrity", "auth"]);
});
```

Add separate tests proving:

- a successful acquisition lets the same Twitch tick continue;
- a false result prevents Twitch auth probing and scheduler adapter work;
- failure emits a warning diagnostic saying retry is deferred to the next normal alarm;
- acquisition failure does not emit an interruption activity event or mark auth unhealthy;
- a Twitch acquisition failure does not prevent Kick auth or scheduler work in an all-platform tick;
- an acquisition throw caused by an aborted tick exits silently through #293 behavior;
- enabling Twitch returns before the detached tick’s acquisition resolves.

- [ ] **Step 2: Write failing refresh-alarm tests**

Cover:

- the handler reloads settings and token state on every invocation;
- it clears/no-ops when Twitch is disabled;
- it reschedules without minting when a newer token is valid beyond the refresh window;
- it performs one forced fresh-context acquisition when the token is missing or within the refresh window;
- success relies on capture persistence to schedule the replacement;
- false/throwing acquisition creates no retry alarm and logs that the next normal alarm will retry;
- two concurrent alarm/tick invocations reach only one injected acquisition;
- a late alarm revalidates current state instead of trusting the originally scheduled token.

- [ ] **Step 3: Run controller tests and verify failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts
```

Expected: Twitch auth currently begins without the new prerequisite and no refresh handler exists.

- [ ] **Step 4: Add the internal readiness gate**

Before `refreshAuthHealth` in `runTick`, when the requested scope includes an enabled Twitch platform:

```ts
async function prepareTwitchIntegrity(
  settings: S,
  signal: AbortSignal,
): Promise<boolean> {
  if (!settings.platform.twitch.enabled) return true;
  if (!deps.ensureTwitchIntegrity) return true;

  return withEventCollector(async (emit, events) => {
    const ready = await deps.ensureTwitchIntegrity(emit, { signal });
    if (!ready) {
      emit({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
      });
    }
    await reportBestEffort(events);
    return ready;
  });
}
```

When it returns false, add Twitch to the existing per-tick excluded platform set before auth refresh and scheduler selection. Do not persist auth-health or scheduler-state changes for the skipped Twitch pipeline.

- [ ] **Step 5: Implement the refresh-alarm handler**

The handler:

1. loads current settings and stored integrity;
2. clears/no-ops unless Twitch is enabled;
3. reschedules a token whose calculated target is still future;
4. otherwise creates an owned `AbortController`, calls injected acquisition with `{ forceRefresh: true, signal }`, and reports collected diagnostics;
5. does not create a retry alarm on false or failure;
6. removes its controller from active ownership in `finally`.

Keep an `integrityRefreshAbort` owned by the controller. `shutdown`,
`prepareForHostReset`, and Twitch disable call both
`integrityRefreshAbort.abort(...)` and
`deps.cancelTwitchIntegrityAcquisition?.(...)`. This is separate from
`abortActiveTicks` so disabling Twitch does not cancel Kick.

- [ ] **Step 6: Add lifecycle cleanup**

In the settings toggle path:

- when Twitch becomes disabled, cancel Twitch acquisition and clear the integrity alarm;
- disabling the last enabled platform needs no additional branch: the Twitch
  disable path already performs its own cleanup;
- when Twitch is enabled, return the snapshot immediately and let the existing detached platform tick perform acquisition;
- do not add a snapshot field or message type for readiness.

In `shutdown()` and `prepareForHostReset()`, cancel acquisition and clear the alarm before waiting for locks. Alarm clearing is asynchronous in reset; shutdown calls cancellation synchronously and leaves host alarm cleanup to the registered lifecycle where necessary.

- [ ] **Step 7: Run controller tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: all commands pass.

- [ ] **Step 8: Commit controller gating and lifecycle**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(twitch): gate authenticated work on integrity readiness"
```

---

### Task 4: Wire the One-Shot Browser Alarm

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`
- Create: `packages/extension/tests/backgroundEntrypoint.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 controller dependencies, `cancelTwitchIntegrityAcquisition`, `ensureTwitchIntegrity`, and `TWITCH_INTEGRITY_ALARM_NAME`.
- Produces: WXT alarm dispatch to `controller.runTwitchIntegrityRefresh()`.

- [ ] **Step 1: Write a focused source-contract test for entrypoint wiring**

Follow the existing source-inspection pattern in
`packages/extension/tests/compatibility.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("background integrity alarm wiring", () => {
  const source = readFileSync(
    new URL("../entrypoints/background.ts", import.meta.url),
    "utf8",
  );

  it("injects alarm creation, clearing, acquisition, and cancellation", () => {
    expect(source).toContain("clearAlarm: (name) => browser.alarms.clear(name)");
    expect(source).toContain("ensureTwitchIntegrity: (emit, request)");
    expect(source).toContain("cancelTwitchIntegrityAcquisition");
  });

  it("dispatches the integrity alarm to the controller", () => {
    expect(source).toContain("alarm.name === TWITCH_INTEGRITY_ALARM_NAME");
    expect(source).toContain("controller.runTwitchIntegrityRefresh()");
  });
});
```

- [ ] **Step 2: Write failing host-wiring assertions**

In the same source-contract test, also assert:

- `createAlarm(name, { when })` forwards the one-shot timestamp to `browser.alarms.create`;
- `clearAlarm(name)` calls `browser.alarms.clear`;
- an alarm named `TWITCH_INTEGRITY_ALARM_NAME` calls `runTwitchIntegrityRefresh`;
- unrelated alarms remain ignored;
- the injected `ensureTwitchIntegrity` forwards `TwitchIntegrityRequest.signal`;
- the injected cancellation hook calls `cancelTwitchIntegrityAcquisition`.

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundEntrypoint.test.ts
```

Expected: the new alarm name and host dependencies are not wired.

- [ ] **Step 4: Wire browser dependencies and dispatch**

Update controller construction:

```ts
createAlarm: (name, options) => browser.alarms.create(name, options),
clearAlarm: (name) => browser.alarms.clear(name),
ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrity(emit, request),
cancelTwitchIntegrityAcquisition,
```

Extend the listener:

```ts
} else if (alarm.name === TWITCH_INTEGRITY_ALARM_NAME) {
  void controller.runTwitchIntegrityRefresh();
}
```

Import the new constant from `@lurkloot/core/controller` and cancellation helper from the extension’s core tabs adapter/export surface.

- [ ] **Step 5: Run entrypoint tests and both relevant typechecks**

Run:

```bash
pnpm --filter @lurkloot/extension test -- tests/backgroundEntrypoint.test.ts
pnpm --filter @lurkloot/core typecheck
pnpm --filter @lurkloot/extension typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit host wiring**

```bash
git add packages/extension/entrypoints/background.ts packages/extension/tests/backgroundEntrypoint.test.ts
git commit -m "feat(extension): run expiry-driven integrity refresh alarm"
```

---

### Task 5: Verify Diagnostics-Only Delivery and Full Regression Safety

**Files:**
- Modify only if verification reveals a defect in Tasks 1–4.
- Verify: `packages/locales/messages/*.json`, popup contracts, manifest permissions, and all workspace outputs.

**Interfaces:**
- Consumes: Completed implementation from Tasks 1–4.
- Produces: A release-ready branch for issue #298.

- [ ] **Step 1: Prove no user-facing preparation contract was added**

Run:

```bash
git diff origin/develop...HEAD -- packages/popup-ui packages/shared/src/messages.ts packages/locales packages/extension/wxt.config.ts
rg -n "preparing|warming|integrity.*ready" packages/popup-ui packages/locales packages/shared/src/messages.ts
```

Expected: no popup/snapshot/message/locale preparation state and no new permission. Any matches must be pre-existing or diagnostic-only.

- [ ] **Step 2: Run focused regression suites**

```bash
pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts
pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts
pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run repository verification**

```bash
pnpm verify
```

Expected: script tests, all workspace typechecks, CLI and extension tests, Astro build, and Chromium/Firefox builds pass.

- [ ] **Step 4: Inspect the final diff and diagnostics**

```bash
git diff --check origin/develop...HEAD
git diff --stat origin/develop...HEAD
git log --oneline origin/develop..HEAD
```

Confirm every new diagnostic is an English literal, contains no integrity value, and matches the intended warning/debug severity.

- [ ] **Step 5: Keep corrections in the task that owns them**

If verification finds a defect, return to the owning task, add or strengthen
its focused regression test, make the minimal correction, rerun that task’s
checks, and amend that task before delivery. Do not create an empty verification
commit.
