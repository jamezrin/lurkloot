# Kick Realtime Flash-Drop Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** React to Kick's category-scoped realtime campaign-start event in both visible-tab and tabless watch modes, refresh Kick canonically through the scheduler, and admit just-launched exact-fit flash rewards without weakening ordinary deadline filtering.

**Architecture:** Add an optional platform-neutral `DiscoverySignalController` capability beside tabless watching. The background controller reconciles one persistent observer per watched platform and coalesces its host-neutral callbacks into serialized platform-only ticks; Kick alone owns the Pusher protocol. Deadline feasibility remains a pure shared policy based on campaign/reward timestamps and platform identity.

**Tech Stack:** TypeScript 7, pnpm workspace, Vitest, WXT browser extension, native WebSocket/Pusher protocol v7.

## Global Constraints

- Work only in `/home/jamezrin/dev/lurkloot/.worktrees/kick-realtime-flash-drops` on `feat/kick-realtime-flash-drops`.
- Keep `packages/core` browser-free and free of WXT or browser globals beyond injected standards-compatible transports.
- Realtime discovery must work for both visible-tab and tabless Kick sessions.
- Protocol-specific Kick channel/event names must remain behind the Kick platform implementation.
- Realtime payloads are notifications only; canonical campaign and progress endpoints remain authoritative.
- Existing eligibility, priority, and current-watch replacement rules remain authoritative; no hard preemption.
- Keep the normal scheduler alarm as fallback and add no broad periodic polling.
- Realtime failure must not affect watch health or interrupt farming.
- Diagnostics are English literals; add no locale keys.
- Add no permissions, credential storage, or credential export.
- Implement every behavior test-first and run `pnpm verify` before completion.

---

## File Map

- Create `packages/core/src/core/webSocket.ts`: minimal injected socket/factory contract shared by persistent platform transports.
- Create `packages/core/src/core/discoverySignals.ts`: neutral discovery target/controller contracts and bounded diagnostic queue.
- Create `packages/core/src/platforms/kick/discoverySignals.ts`: Kick Pusher connection, subscription, parsing, reconnect, and cleanup.
- Modify `packages/core/src/platforms/kick/watch.ts`: import the neutral socket contract instead of declaring a Kick-local copy.
- Modify `packages/core/src/platforms/kick/index.ts`: import the neutral socket factory and expose the Kick observer factory.
- Modify `packages/core/src/platforms/adapter.ts`: optional discovery-controller factory.
- Modify `packages/core/src/background/controller.ts`: lifecycle reconciliation, diagnostics, shutdown/reset cleanup, and signal-refresh coalescing.
- Modify `packages/core/package.json`: export neutral and Kick discovery modules used by tests.
- Modify `packages/shared/src/rewards.ts`: exact-fit launch exception and campaign-platform-aware feasibility signature.
- Create `packages/extension/tests/kickDiscoverySignals.test.ts`: protocol-level observer tests.
- Modify `packages/extension/tests/tablessWatch.test.ts`: use the shared socket contract and retain watcher regression coverage.
- Modify `packages/extension/tests/helpers/adapters.ts`: use the shared socket factory contract.
- Modify `packages/cli/src/transport/cycle.ts`: use the shared socket contracts.
- Modify `packages/cli/src/transport/common.ts`: use the shared socket factory contract.
- Modify `packages/extension/tests/backgroundController.test.ts`: observer lifecycle and coalescing tests.
- Modify `packages/extension/tests/rewardFeasibility.test.ts`: exact-fit boundary tests.
- Modify `packages/extension/tests/scheduler.test.ts`: refreshed flash-campaign priority regressions.

---

### Task 1: Introduce Neutral Persistent-Transport and Discovery Contracts

**Files:**

- Create: `packages/core/src/core/webSocket.ts`
- Create: `packages/core/src/core/discoverySignals.ts`
- Modify: `packages/core/src/platforms/kick/watch.ts`
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/extension/tests/tablessWatch.test.ts`
- Modify: `packages/extension/tests/helpers/adapters.ts`
- Modify: `packages/cli/src/transport/cycle.ts`
- Modify: `packages/cli/src/transport/common.ts`

**Interfaces:**

- Produces: `WebSocketLike`, `WebSocketFactory`, `DiscoverySignalTarget`, `DiscoverySignalController`, and `PendingDiscoverySignalDiagnostics`.
- Produces: `PlatformAdapter.createDiscoverySignalController?(): DiscoverySignalController`.
- Preserves: `KickWatcherDeps.createWebSocket?: WebSocketFactory` and all existing tabless runtime behavior.

- [ ] **Step 1: Add a compile-time test import for the neutral contracts**

In `packages/extension/tests/tablessWatch.test.ts`, replace the socket type import with the planned neutral exports and add a minimal contract fixture:

```ts
import type { DiscoverySignalController, DiscoverySignalTarget } from "@lurkloot/core/discoverySignals";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import { KickWatcher } from "@lurkloot/core/kick/watch";

const discoveryContractFixture = (
  controller: DiscoverySignalController,
  target: DiscoverySignalTarget,
): Promise<void> => controller.start(target, () => undefined);

void discoveryContractFixture;
```

Remove `type WebSocketLike` from the `@lurkloot/core/kick/watch` import. This is a type-level RED because neither neutral export exists yet.

- [ ] **Step 2: Run typecheck to verify the missing-module failure**

Run:

```bash
pnpm --filter @lurkloot/extension typecheck
```

Expected: FAIL because `@lurkloot/core/discoverySignals` and `@lurkloot/core/webSocket` are not exported.

- [ ] **Step 3: Add the minimal shared contracts**

Create `packages/core/src/core/webSocket.ts`:

```ts
export interface WebSocketMessageEventLike {
  data?: unknown;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
```

Create `packages/core/src/core/discoverySignals.ts`:

```ts
import type { DiagnosticEvent } from "@lurkloot/shared/events";
import type { ChannelCandidate, Platform } from "@lurkloot/shared/models";

export const MAX_PENDING_DISCOVERY_SIGNAL_DIAGNOSTICS = 250;

export interface DiscoverySignalTarget {
  platform: Platform;
  channel: ChannelCandidate;
}

export interface DiscoverySignalController {
  readonly platform: Platform;
  readonly targetKey: string | undefined;
  start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void>;
  drainEvents(): DiagnosticEvent[];
  stop(): Promise<void>;
}

export class PendingDiscoverySignalDiagnostics {
  private readonly events: DiagnosticEvent[] = [];

  push(event: DiagnosticEvent): void {
    if (this.events.length >= MAX_PENDING_DISCOVERY_SIGNAL_DIAGNOSTICS) this.events.shift();
    this.events.push(event);
  }

  drain(): DiagnosticEvent[] {
    return this.events.splice(0);
  }
}
```

Move the existing `WebSocketLike` and `WebSocketFactory` declarations out of `kick/watch.ts` and import them from `../../core/webSocket`. Update `kick/index.ts`, extension test helpers, and CLI transports to import these types from `@lurkloot/core/webSocket`; do not retain the Kick-local type exports.

Add to `PlatformAdapter`:

```ts
import type { DiscoverySignalController } from "../core/discoverySignals";

createDiscoverySignalController?(): DiscoverySignalController;
```

Add package exports:

```json
"./webSocket": "./src/core/webSocket.ts",
"./discoverySignals": "./src/core/discoverySignals.ts"
```

- [ ] **Step 4: Run focused typecheck and watcher tests**

Run:

```bash
pnpm --filter @lurkloot/core typecheck
pnpm --filter @lurkloot/extension test -- tablessWatch.test.ts
```

Expected: PASS; all existing Kick viewer watcher behavior is unchanged.

- [ ] **Step 5: Commit the neutral seam**

```bash
git add packages/core/src/core/webSocket.ts packages/core/src/core/discoverySignals.ts packages/core/src/platforms/kick/watch.ts packages/core/src/platforms/kick/index.ts packages/core/src/platforms/adapter.ts packages/core/package.json packages/extension/tests/tablessWatch.test.ts packages/extension/tests/helpers/adapters.ts packages/cli/src/transport/cycle.ts packages/cli/src/transport/common.ts
git commit -m "refactor(core): add discovery signal controller seam"
```

---

### Task 2: Implement the Kick Pusher Discovery Observer

**Files:**

- Create: `packages/core/src/platforms/kick/discoverySignals.ts`
- Create: `packages/extension/tests/kickDiscoverySignals.test.ts`
- Modify: `packages/core/package.json`

**Interfaces:**

- Consumes: `DiscoverySignalController`, `DiscoverySignalTarget`, `PendingDiscoverySignalDiagnostics`, and `WebSocketFactory` from Task 1.
- Produces: `KickDiscoverySignalController` and `KickDiscoverySignalDeps`.
- Protocol constants: app key `32cbd69e4b950bf97679`, host `ws-us2.pusher.com`, protocol `7`, event `drops_campaign_started`, category channel prefix `drops_category_`.

- [ ] **Step 1: Write failing tests for connection and subscription framing**

Create `packages/extension/tests/kickDiscoverySignals.test.ts` with a message-capable fake:

```ts
class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: "open" | "close" | "error", event: WebSocketMessageEventLike = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  message(value: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }
}
```

Test that `start()` for Kick category `42` opens exactly:

```text
wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false
```

After a `pusher:connection_established` frame, assert the socket sends:

```json
{"event":"pusher:subscribe","data":{"auth":"","channel":"drops_category_42"}}
```

Also assert `targetKey === "42"` and `start()` with the same category does not open a second socket.

- [ ] **Step 2: Run the protocol test to verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- kickDiscoverySignals.test.ts
```

Expected: FAIL because `@lurkloot/core/kick/discoverySignals` does not exist.

- [ ] **Step 3: Implement connection, subscription, and strict event parsing**

Create `KickDiscoverySignalController` with this public shape:

```ts
export interface KickDiscoverySignalDeps {
  createWebSocket?: WebSocketFactory;
  scheduleReconnect?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelReconnect?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class KickDiscoverySignalController implements DiscoverySignalController {
  readonly platform = "kick" as const;
  get targetKey(): string | undefined;
  constructor(deps?: KickDiscoverySignalDeps);
  start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void>;
  drainEvents(): DiagnosticEvent[];
  stop(): Promise<void>;
}
```

Implement these rules:

- `start()` rejects non-Kick targets by stopping and logging a debug diagnostic.
- A missing/blank `channel.categoryId` stops without opening a socket.
- The same normalized category updates the callback but keeps its socket.
- A new category closes the old socket, clears reconnect state, and connects anew.
- Subscribe only after `pusher:connection_established`.
- Treat `data` in incoming frames as either an object or JSON string.
- Call `onSignal()` only for `event === "drops_campaign_started"`, `channel === currentChannelName`, and a Pusher `data` value that decodes to a non-empty string or finite number campaign identifier.
- Validate the payload shape only to reject malformed events; never persist the identifier or treat it as campaign data.
- Reply to `pusher:ping` with `{"event":"pusher:pong","data":{}}`.
- Ignore malformed data and stale-socket callbacks without throwing.

Export `./kick/discoverySignals` from `packages/core/package.json`.

- [ ] **Step 4: Add failing lifecycle and failure-degradation tests**

Add tests for:

```ts
it("emits one signal only for the current category campaign-start event", ...);
it("ignores malformed, unrelated, and stale-socket events", ...);
it("closes the obsolete category socket before subscribing to the replacement", ...);
it("answers Pusher ping frames without emitting a discovery signal", ...);
it("reconnects after an unexpected close and resubscribes to the current category", ...);
it("does not reconnect after stop or an expected replacement close", ...);
it("bounds callback diagnostics to the newest 250 entries", ...);
```

For reconnect tests, inject a scheduler that records `{ callback, delayMs }`. Require exponential delays of 1, 2, 4, 8, 16, then at most 30 seconds; reset the attempt counter after `pusher:connection_established`. Invoke the captured callback directly instead of advancing real time.

- [ ] **Step 5: Run tests to verify the new lifecycle cases fail**

Run:

```bash
pnpm --filter @lurkloot/extension test -- kickDiscoverySignals.test.ts
```

Expected: the new reconnect, replacement, ping/pong, and bounded-diagnostic cases FAIL until their behavior is implemented.

- [ ] **Step 6: Implement minimal reconnect and cleanup behavior**

Use named constants:

```ts
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const WEBSOCKET_OPEN = 1;
```

Track the current socket, normalized category, signal callback, reconnect attempt, reconnect timer, stopped state, and intentionally closed sockets. An unexpected close schedules one reconnect; `error` logs a warning and lets the subsequent close own reconnect scheduling so an error/close pair cannot double-schedule. `stop()` must cancel the timer, intentionally close the socket, clear the target/callback, and make all captured stale callbacks inert.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- kickDiscoverySignals.test.ts tablessWatch.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the Kick protocol implementation**

```bash
git add packages/core/src/platforms/kick/discoverySignals.ts packages/core/package.json packages/extension/tests/kickDiscoverySignals.test.ts
git commit -m "feat(kick): observe realtime campaign signals"
```

---

### Task 3: Expose the Kick Observer Through the Platform Adapter

**Files:**

- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/extension/tests/kickDiscoverySignals.test.ts`

**Interfaces:**

- Consumes: `PlatformAdapter.createDiscoverySignalController?()` and `KickDiscoverySignalController`.
- Produces: `KickAdapter.createDiscoverySignalController()` using the adapter's injected socket factory.

- [ ] **Step 1: Write failing adapter-construction test**

In `kickDiscoverySignals.test.ts` or the existing adapter construction suite, create a `KickAdapter` with an injected socket factory and assert:

```ts
const observer = adapter.createDiscoverySignalController?.();
expect(observer).toBeInstanceOf(KickDiscoverySignalController);
expect(observer?.platform).toBe("kick");
```

Expected production addition in `KickAdapter`:

```ts
createDiscoverySignalController(): DiscoverySignalController {
  return new KickDiscoverySignalController({ createWebSocket: this.webSocketFactory });
}
```

- [ ] **Step 2: Run the adapter test to verify RED, then implement the factory**

Run before implementation:

```bash
pnpm --filter @lurkloot/extension test -- kickDiscoverySignals.test.ts
```

Expected: FAIL because the factory is absent.

Implement the factory, rerun the command, and expect PASS.

- [ ] **Step 3: Commit adapter exposure**

```bash
git add packages/core/src/platforms/kick/index.ts packages/extension/tests/kickDiscoverySignals.test.ts
git commit -m "feat(kick): expose campaign discovery observer"
```

---

### Task 4: Reconcile Observers and Coalesce Platform-Only Refreshes

**Files:**

- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/tests/helpers/adapters.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**

- Extends: `TickTrigger` with `"discovery_signal"`.
- Produces: `queueDiscoverySignalRefresh(platform: Platform): void` with one running loop and at most one pending refresh per platform.
- Consumes: existing `tickAndHandOff([platform], trigger)`, per-platform locks, `backgroundWork`, and canonical adapter refresh paths.

- [ ] **Step 1: Add a fake observer and write failing lifecycle tests**

In `backgroundController.test.ts`, add a `FakeDiscoverySignalController` implementing the Task 1 contract. It records `starts`, counts `stops`, stores the latest callback, exposes `emitSignal()`, and destructively drains diagnostic events. Extend the harness so only the Kick adapter returns this fake.

```ts
class FakeDiscoverySignalController implements DiscoverySignalController {
  readonly platform: Platform;
  targetKey?: string;
  starts: DiscoverySignalTarget[] = [];
  stops = 0;
  private onSignal?: () => void;
  private readonly events: DiagnosticEvent[] = [];

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void> {
    this.starts.push(target);
    this.targetKey = target.channel.categoryId;
    this.onSignal = onSignal;
  }

  emitSignal(): void {
    this.onSignal?.();
  }

  pushDiagnostic(message: string): void {
    this.events.push({ category: "diagnostic", platform: this.platform, level: "warn", message });
  }

  drainEvents(): DiagnosticEvent[] {
    return this.events.splice(0);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.targetKey = undefined;
    this.onSignal = undefined;
  }
}
```

Add a `describe("discovery signal lifecycle", ...)` block proving:

```ts
it.each(["tab", "tabless"] as const)("starts the Kick observer for an active %s watch session", ...);
it("does not create an observer for an idle session", ...);
it("stops the observer when Kick is disabled or authentication becomes unhealthy", ...);
it("updates the observer when the watched channel category changes", ...);
it("stops observers during host reset and controller shutdown", ...);
it("does not make discovery failure count as a watch-heartbeat failure", ...);
```

Use real scheduler decisions in the tab/tabless cases: return a Kick campaign and candidate channel with `categoryId: "42"`, run a Kick tick, and assert the target given to the observer. Do not mutate controller internals.

- [ ] **Step 2: Write failing coalescing and isolation tests**

In `backgroundController.test.ts`, add deterministic tests that use deferred Kick `refreshCampaigns` calls:

```ts
it("turns a Kick discovery signal into a Kick-only canonical tick", ...);
it("coalesces a burst into one pending Kick refresh", ...);
it("runs exactly one follow-up when a signal arrives during an active Kick tick", ...);
it("keeps Twitch refresh calls unchanged by a Kick signal", ...);
it("drops pending signal work after disablement or shutdown", ...);
it("records discovery_signal in tick lifecycle diagnostics", ...);
```

For the burst case:

1. Complete the initial tick that creates the observer.
2. Block the first signal-triggered Kick refresh on a deferred promise.
3. Emit the observer callback three more times.
4. Release the first refresh.
5. Assert exactly one second signal-triggered refresh runs.
6. Release it and call `settleBackgroundWork()`.
7. Assert no third refresh and no Twitch refresh.

- [ ] **Step 3: Run lifecycle and coalescing tests to verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: FAIL because the controller does not reconcile observers, callbacks do not schedule ticks, and the trigger is not defined.

- [ ] **Step 4: Implement observer reconciliation, cleanup, and the bounded refresh loop**

Extend `TickTrigger`:

```ts
| "discovery_signal"
```

Add per-platform state:

```ts
const discoverySignalRefreshRunning: Record<Platform, boolean> = { twitch: false, kick: false };
const discoverySignalRefreshPending: Record<Platform, boolean> = { twitch: false, kick: false };
```

Add `discoverySignalControllers = new Map<Platform, DiscoverySignalController>()`, a drain helper, and `reconcileDiscoverySignalControllers(...)`. The wanted predicate is enabled, healthy auth, `session.status === "watching"`, a present `session.channel`, and an adapter factory. Do not branch on `watchMode`. Always call `start()` for a wanted observer and pass `() => queueDiscoverySignalRefresh(platform)`; the platform implementation owns idempotence and target sufficiency. Reconcile after tabless watchers on each completed tick. Stop and clear observers, pending flags, timers/sockets through their `stop()` methods during disablement, reset, and shutdown.

Implement:

```ts
function queueDiscoverySignalRefresh(platform: Platform): void {
  if (controllerShutdown) return;
  discoverySignalRefreshPending[platform] = true;
  if (discoverySignalRefreshRunning[platform]) return;
  discoverySignalRefreshRunning[platform] = true;

  const run = (async () => {
    try {
      while (discoverySignalRefreshPending[platform] && !controllerShutdown) {
        discoverySignalRefreshPending[platform] = false;
        const settings = await deps.loadSettings();
        if (!settings.platform[platform].enabled) break;
        await tickAndHandOff([platform], "discovery_signal");
      }
    } finally {
      discoverySignalRefreshRunning[platform] = false;
      if (controllerShutdown) discoverySignalRefreshPending[platform] = false;
    }
  })().catch((error) => {
    diagnosticEvent("warn", `Discovery signal refresh failed: ${error instanceof Error ? error.message : String(error)}`, platform);
  });

  backgroundWork = backgroundWork.then(() => run, () => run);
}
```

Preserve the key semantics even if the exact implementation is adjusted for existing controller helpers: reserve `running` synchronously before any `await`, use the existing platform lock through `tickAndHandOff`, retain only one pending boolean, and include the detached loop in `settleBackgroundWork()`.

On platform disablement, reset, or shutdown, clear that platform's pending flag before stopping its observer. An in-flight tick is handled by the controller's existing abort/lifecycle mechanisms.

- [ ] **Step 5: Add priority integration tests against refreshed campaign data**

In `scheduler.test.ts`, add two focused cases using one ordinary campaign and one two-minute flash campaign returned together by the adapter:

```ts
it("ending_soonest selects an eligible newly refreshed flash campaign", ...);
it("explicit campaign priority can keep an ordinary campaign ahead of a flash campaign", ...);
```

Use existing `chooseCampaignDecision` or `runSchedulerTick` helpers rather than testing the sort comparator alone. The first should use `priorityMode: "ending_soonest"` with no explicit priorities. The second should assign the ordinary campaign a higher `campaignPriorities` value and assert the existing campaign remains selected.

- [ ] **Step 6: Run priority tests and confirm behavior**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: the default and explicit-priority tests PASS through existing scheduler behavior. Do not introduce flash-specific scheduler ranking.

- [ ] **Step 7: Run all controller and scheduler focused tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts scheduler.test.ts kickDiscoverySignals.test.ts
```

Expected: PASS with no overlapping Kick refreshes and no Twitch calls caused by Kick signals.

- [ ] **Step 8: Commit observer lifecycle and refresh scheduling**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/helpers/adapters.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(controller): refresh on discovery signals"
```

---

### Task 5: Add the Narrow Exact-Fit Kick Feasibility Policy

**Files:**

- Modify: `packages/shared/src/rewards.ts`
- Modify: `packages/extension/tests/rewardFeasibility.test.ts`

**Interfaces:**

- Changes: `rewardFeasibility(campaign: Pick<DropCampaign, "endsAt" | "platform">, ...)`.
- Changes: `isRewardDeadlineFeasible(campaign: Pick<DropCampaign, "endsAt" | "platform">, ...)`.
- Produces named constants `EXACT_FIT_WINDOW_TOLERANCE_MS = 5_000` and `EXACT_FIT_LAUNCH_ALLOWANCE_MS = 15_000`.
- Preserves: all return variants and diagnostic fields; `marginMinutes` continues to report the configured margin even when the narrow exception admits the reward.

- [ ] **Step 1: Write failing exact-fit launch tests**

Extend `rewardFeasibility.test.ts` with a Kick campaign helper and these cases at fixed timestamps:

```ts
it("admits a Kick exact-fit reward observed ten seconds after launch", ...);
it("admits timestamp rounding within five seconds", ...);
it("rejects an exact-fit reward observed more than fifteen seconds after launch", ...);
it("rejects a raw deficit larger than elapsed launch time", ...);
it("keeps the configured margin for a Kick reward whose window is not exact-fit", ...);
it("does not apply the launch allowance to Twitch", ...);
it("keeps skipUnfinishableRewards disabled behavior unchanged", ...);
```

The principal positive fixture is:

```ts
const launchedAt = Date.parse("2026-08-12T12:00:00.000Z");
const now = launchedAt + 10_000;
const drop = reward({
  requiredMinutes: 2,
  watchedMinutes: 0,
  availableFrom: "2026-08-12T12:00:00.000Z",
  availableUntil: "2026-08-12T12:02:00.000Z",
});
const result = rewardFeasibility(
  campaign([drop], { platform: "kick" }),
  drop,
  true,
  5,
  now,
);
expect(result.kind).toBe("feasible");
```

- [ ] **Step 2: Run feasibility tests to verify RED**

Run:

```bash
pnpm --filter @lurkloot/extension test -- rewardFeasibility.test.ts
```

Expected: the positive exact-fit cases FAIL as `insufficient_time`.

- [ ] **Step 3: Implement the pure narrow policy**

In `packages/shared/src/rewards.ts`, add:

```ts
export const EXACT_FIT_WINDOW_TOLERANCE_MS = 5_000;
export const EXACT_FIT_LAUNCH_ALLOWANCE_MS = 15_000;
```

Extract a private predicate with this exact decision shape:

```ts
function isKickExactFitLaunch(
  campaign: Pick<DropCampaign, "platform">,
  reward: DropReward,
  now: number,
  availableMilliseconds: number,
  remainingMilliseconds: number,
): boolean {
  if (campaign.platform !== "kick" || !reward.availableFrom || !reward.availableUntil) return false;
  const startsAt = Date.parse(reward.availableFrom);
  const endsAt = Date.parse(reward.availableUntil);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return false;

  const fullWindow = endsAt - startsAt;
  const fullRequirement = reward.requiredMinutes * 60_000;
  if (Math.abs(fullWindow - fullRequirement) > EXACT_FIT_WINDOW_TOLERANCE_MS) return false;

  const elapsedSinceLaunch = now - startsAt;
  if (elapsedSinceLaunch < 0 || elapsedSinceLaunch > EXACT_FIT_LAUNCH_ALLOWANCE_MS) return false;

  const startupAllowance = Math.min(elapsedSinceLaunch, EXACT_FIT_LAUNCH_ALLOWANCE_MS);
  return remainingMilliseconds - availableMilliseconds <= startupAllowance;
}
```

In `rewardFeasibility`, compute raw remaining milliseconds separately. Return `feasible` when either the ordinary margin check passes or the exact-fit predicate passes:

```ts
const remainingMilliseconds = remainingMinutes * 60_000;
const requiredMilliseconds = remainingMilliseconds + marginMinutes * 60_000;
const kind = availableMilliseconds >= requiredMilliseconds
  || isKickExactFitLaunch(campaign, reward, now, availableMilliseconds, remainingMilliseconds)
  ? "feasible"
  : "insufficient_time";
```

Use the earliest campaign/reward deadline for `availableMilliseconds` exactly as today. Requiring `reward.availableUntil` in the exception prevents a campaign-level deadline alone from fabricating an exact reward window.

- [ ] **Step 4: Run feasibility, filter, scheduler, and popup view-model regressions**

Run:

```bash
pnpm --filter @lurkloot/extension test -- rewardFeasibility.test.ts campaignFilters.test.ts scheduler.test.ts dropsView.test.tsx
pnpm --filter @lurkloot/popup-ui typecheck
pnpm --filter @lurkloot/shared typecheck
```

Expected: PASS; ordinary one-millisecond-shortage and margin tests remain unchanged.

- [ ] **Step 5: Commit the feasibility policy**

```bash
git add packages/shared/src/rewards.ts packages/extension/tests/rewardFeasibility.test.ts
git commit -m "fix(kick): admit exact-fit flash rewards at launch"
```

---

### Task 6: Verify the Complete Change

**Files:**

- Review only; modify files only to correct failures attributable to this branch.

**Interfaces:**

- Verifies every acceptance criterion from issue #384 and the approved design.

- [ ] **Step 1: Run formatting and diff checks**

Run:

```bash
git diff origin/develop --check
git status --short
```

Expected: no whitespace errors and no unrelated files.

- [ ] **Step 2: Run all focused tests together**

Run:

```bash
pnpm --filter @lurkloot/extension test -- kickDiscoverySignals.test.ts tablessWatch.test.ts backgroundController.test.ts rewardFeasibility.test.ts scheduler.test.ts campaignFilters.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run:

```bash
pnpm verify
```

Expected: script tests, all workspace typechecks, all tests, site build, and Chromium/Firefox extension builds PASS.

- [ ] **Step 4: Audit architecture and security boundaries**

Run:

```bash
rg -n "drops_category_|drops_campaign_started|pusher:" packages/core/src/core packages/core/src/background packages/shared packages/extension/entrypoints
git diff origin/develop -- packages/extension/wxt.config.ts packages/locales packages/extension/public/_locales
```

Expected:

- Kick protocol strings appear only in `packages/core/src/platforms/kick/discoverySignals.ts` and its tests.
- No locale catalog, manifest permission, or credential-handling changes.
- Scheduler contains no Kick realtime concepts.

- [ ] **Step 5: Review commits and working tree**

Run:

```bash
git log --oneline origin/develop..HEAD
git status --short
```

Expected: focused Conventional Commits, including the already committed design spec, and a clean working tree.
