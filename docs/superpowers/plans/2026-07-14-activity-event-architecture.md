# Activity Event Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hybrid state/log architecture with typed engine events, extension-owned durable activity history, and direct non-persistent CLI logging.

**Architecture:** Core returns ordered `EngineEvent[]` beside operational state and publishes controller-owned batches through a scoped reporter. The extension owns IndexedDB envelopes, migration, querying, localization, and activity runtime messages; the CLI formats the same event union through its existing logger without storing it.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest 4, fake-indexeddb, IndexedDB, React 19, WXT, JSON locale catalogs.

## Global Constraints

- `packages/core` remains browser-free and imports no WXT, IndexedDB, React, or extension history contracts.
- `SchedulerState` contains no event or diagnostic history.
- Normal extension activity is always retained; diagnostic persistence remains opt-in.
- CLI output uses the existing leveled stderr logger and never persists events.
- Use strict TypeScript, explicit type imports, two-space indentation, double quotes, and semicolons.
- Add no browser permissions or credential behavior.

---

### Task 1: Define the typed event contract

**Files:**
- Create: `packages/shared/src/events.ts`
- Modify: `packages/shared/package.json`
- Create: `packages/extension/tests/eventContract.test.ts`

**Interfaces:**
- Produces: `EngineEvent`, `ActivityEvent`, `DiagnosticEvent`, `StoredEngineEvent`, `StoredLegacyEvent`, `ActivityHistoryRecord`, `LegacyEventLogEntry`, `EventReporter`, `EventEmitter`, `FarmingStopReason` from `@lurkloot/shared/events`.
- Leaves the legacy state/log fields temporarily intact until the scheduler and controller consume the new contract in Tasks 2-3.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type { EngineEvent, StoredEngineEvent } from "@lurkloot/shared/events";

describe("engine event contract", () => {
  it("discriminates activity payloads by code", () => {
    const event: EngineEvent = {
      category: "activity",
      code: "farming_stopped",
      level: "info",
      platform: "twitch",
      data: {
        campaignId: "campaign",
        campaignName: "Campaign",
        rewardId: "reward",
        rewardName: "Reward",
        reason: "runtime_restart",
      },
    };
    expectTypeOf(event).toMatchTypeOf<EngineEvent>();
    expect(event.code).toBe("farming_stopped");
  });

  it("adds persistence metadata only to stored events", () => {
    expectTypeOf<StoredEngineEvent>().toMatchTypeOf<EngineEvent & { id: string; at: string }>();
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/eventContract.test.ts`

Expected: failure because `@lurkloot/shared/events` does not exist.

- [ ] **Step 3: Add the closed event union**

Create `packages/shared/src/events.ts` with this public shape:

```ts
import type { LogLevel } from "./logging";
import type { Platform } from "./models";

export type FarmingStopReason =
  | "automation_disabled"
  | "platform_disabled"
  | "platform_backoff"
  | "platform_error"
  | "campaign_ineligible"
  | "channel_excluded"
  | "channel_offline"
  | "channel_mismatch"
  | "watch_unhealthy"
  | "higher_priority_reward"
  | "higher_priority_watch_queue"
  | "watch_requirement_completed"
  | "runtime_restart"
  | "target_changed"
  | "manual_watch";

type CampaignRewardData = {
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
};

export type ActivityEvent =
  | { category: "activity"; code: "farming_started"; level: "info"; platform: Platform; message?: never; data: CampaignRewardData & { channel?: string } }
  | { category: "activity"; code: "farming_stopped"; level: "info" | "warn" | "error"; platform: Platform; message?: never; data: CampaignRewardData & { reason: FarmingStopReason } }
  | { category: "activity"; code: "reward_claimed"; level: "info"; platform: Platform; message?: never; data: CampaignRewardData & { method: "automatic" | "manual" } }
  | { category: "activity"; code: "interruption"; level: "warn" | "error"; platform?: Platform; message?: never; data: { reason: FarmingStopReason; detail?: string } };

export type DiagnosticEvent = {
  category: "diagnostic";
  level: LogLevel;
  platform?: Platform;
  message: string;
  code?: string;
  data?: Record<string, string | number | boolean | undefined>;
};

export type EventCategory = EngineEvent["category"];
export type EngineEvent = ActivityEvent | DiagnosticEvent;
export type EventEmitter = (event: EngineEvent) => void;
export type EventReporter = (events: readonly EngineEvent[]) => void | Promise<void>;
export type StoredEngineEvent = EngineEvent & { id: string; at: string };

export interface LegacyEventLogEntry {
  id: string;
  at: string;
  platform?: Platform;
  level: LogLevel;
  message: string;
  category?: "activity" | "diagnostic";
  code?: string;
  data?: Record<string, string | number | boolean | undefined>;
}

export type StoredLegacyEvent = LegacyEventLogEntry & { legacy: true };
export type ActivityHistoryRecord = StoredEngineEvent | StoredLegacyEvent;
```

Export it as `./events` in `packages/shared/package.json`. Do not change the legacy state/log contract in this task; that keeps the workspace compiling while producers are migrated.

- [ ] **Step 4: Run focused tests and typecheck GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/eventContract.test.ts && pnpm --filter @lurkloot/shared typecheck && pnpm --filter @lurkloot/core typecheck`

Expected: focused tests and both typechecks pass.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/shared/package.json packages/shared/src/events.ts packages/extension/tests/eventContract.test.ts
git commit -m "feat(activity): define typed engine events"
```

---

### Task 2: Return ordered, non-repetitive scheduler events

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `EngineEvent` and `FarmingStopReason` from Task 1.
- Produces: `SchedulerTickResult = { state: SchedulerState; decisions: WatchDecision[]; events: EngineEvent[] }` in causal order.

- [ ] **Step 1: Write failing scheduler behavior tests**

Add tests that establish the new batch semantics:

```ts
it("returns claim activity in the event batch without mutating scheduler state", async () => {
  const result = await runSchedulerTick(baseState, settings(), adaptersWithClaimableReward());
  expect(result.state.events).toEqual(baseState.events);
  expect(result.events).toContainEqual(expect.objectContaining({
    category: "activity",
    code: "reward_claimed",
    data: expect.objectContaining({ method: "automatic" }),
  }));
});

it("does not repeat diagnostics for an unchanged healthy target", async () => {
  const first = await runSchedulerTick(baseState, settings(), adapters());
  const second = await runSchedulerTick(first.state, settings(), adapters());
  expect(second.events.filter((event) => event.category === "diagnostic" && event.message.startsWith("Campaign decision:"))).toEqual([]);
  expect(second.events.filter((event) => event.category === "diagnostic" && event.message.includes("campaigns eligible"))).toEqual([]);
});

it("does not classify a missing replacement reward as completed", async () => {
  const result = await runSchedulerTick(watchingState(), settings(), adaptersWithoutPreviousReward());
  expect(result.state.sessions.twitch.reasonCode).not.toBe("watch_requirement_completed");
});
```

Retain existing selection, retry, claim, and watch-mode assertions, but change their log assertions from `result.state.events` to `result.events`. Replace the old quiet-versus-verbose producer-gating test with an assertion that diagnostics are always present in the returned batch; host reporters now own filtering.

- [ ] **Step 2: Run the scheduler tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts`

Expected: failure because the scheduler still prepends events into state and repeats stable diagnostics.

- [ ] **Step 3: Implement operation-local event collection**

At the start of `runSchedulerTick`, create `const events: EngineEvent[] = []`. Replace `addTickEvent` with an emitter that pushes diagnostics in call order:

```ts
function emitDiagnostic(events: EngineEvent[], platform: Platform, level: LogLevel, message: string): void {
  events.push({ category: "diagnostic", platform, level, message });
}
```

Push typed claim events directly. Return `{ state: nextState, decisions, events }`. Remove `enabledLevels` and every producer-side level gate.

Only emit inventory diagnostics when `campaignDiagnosticFingerprint` changes. Compute decision diagnostics after `shouldKeepWatching` has produced the final decision and compare campaign ID, reward ID, channel URL, action, and final reason code once. Do not compare the preliminary `eligible_campaign` reason with the stored continuation reason.

Replace the reward-ID shortcut with an explicit lookup of the previously watched reward in refreshed campaigns. Emit `watch_requirement_completed` only when that reward is `claimable` or `claimed`; otherwise classify the switch from eligibility/priority/target evidence.

- [ ] **Step 4: Run scheduler tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts`

Expected: all scheduler tests pass with ordered result events and no newly appended scheduler-state events.

- [ ] **Step 5: Commit scheduler migration**

```bash
git add packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "refactor(scheduler): return ordered engine events"
```

---

### Task 3: Publish controller lifecycle events through a scoped reporter

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/logging.ts`
- Modify: `packages/shared/src/settings.ts`
- Modify: `packages/core/src/core/defaults.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/extension/tests/settings.test.ts`
- Modify: `packages/cli/src/runtime/run.ts`
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/src/storage.ts`

**Interfaces:**
- Consumes: scheduler `events` from Task 2.
- Produces: `BackgroundControllerDeps.reportEvents?: EventReporter` and `createAdapters(emit: EventEmitter)`.
- Removes: `recordEvents`, `loadEvents`, and `clearEvents` controller dependencies.
- Produces: `SchedulerState` without `events` and engine/extension settings without `enabledLogLevels`.

- [ ] **Step 1: Write failing controller tests**

Add these cases to the controller harness:

```ts
it("saves operational state before publishing the ordered batch", async () => {
  const calls: string[] = [];
  const env = harness({}, {
    saveState: async () => { calls.push("state"); },
    reportEvents: async () => { calls.push("events"); },
  });
  await env.controller.tick();
  expect(calls).toEqual(["state", "events"]);
});

it("never persists an event outbox in scheduler state", async () => {
  const env = harness();
  await env.controller.tick();
  expect(env.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
});

it("emits a runtime restart stop before clearing a stale farming target", async () => {
  const env = harnessWithWatchingState();
  await env.controller.handleStartup();
  expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      data: expect.objectContaining({ reason: "runtime_restart" }),
    }),
  ]));
});

it("reports a controller-fatal interruption even when diagnostics are filtered by the host", async () => {
  const env = harnessWithAdapterFactoryFailure();
  await env.controller.tick();
  expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ category: "activity", code: "interruption", level: "error" }),
  ]));
});
```

Delete tests asserting `getActivity` or `clearActivity` dispatch through the controller; Task 6 relocates those messages to the extension.

- [ ] **Step 2: Run controller tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts`

Expected: failure because events still live in state and startup only emits a diagnostic.

- [ ] **Step 3: Refactor persistence and lifecycle derivation**

Use one helper with explicit ordering:

```ts
async function persistAndReport(state: SchedulerState, events: readonly EngineEvent[]): Promise<void> {
  await deps.saveState(state);
  if (events.length === 0 || !deps.reportEvents) return;
  try {
    await deps.reportEvents(events);
  } catch {
    // Host event persistence/output is best-effort.
  }
}
```

Change lifecycle derivation to `farmingLifecycleEvents(previous, next): ActivityEvent[]` rather than mutating state. Compare reason/status codes, not free-form messages. For startup, derive the previous target before `staleStartupCleanup`, add a `farming_stopped/runtime_restart` event, save the cleaned state, publish the event, then optionally tick to resume.

For fatal tick failures, save the operational error state and report both an `interruption` activity event and a technical diagnostic. Manual claim success reports a typed `reward_claimed` event with `method: "manual"`.

Remove history message imports and branches from `handleMessage`; its return type no longer includes `ActivityPage`. Remove `SchedulerState.events`, reduce `logging.ts` to level/order helpers, remove `events` from `DEFAULT_STATE`, and make `mergeSchedulerState` discard an input legacy `events` key. Keep the old `EventLogEntry` names temporarily as deprecated legacy/history compatibility types until Tasks 5-7 migrate the repository and popup, then delete them. Remove `enabledLogLevels` from settings and normalization; update settings tests so `diagnosticLogging` is independent.

Update the extension and CLI controller construction to use `reportEvents` and the new event types. Keep the current extension repository and CLI formatter temporarily by adapting typed events at those boundaries; Tasks 5 and 8 replace those compatibility paths. Simplify CLI state storage so it no longer adds or strips a typed `events` property.

- [ ] **Step 4: Run controller tests and package typechecks GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/backgroundController.test.ts tests/settings.test.ts && pnpm -r typecheck`

Expected: controller/settings tests and every workspace typecheck pass; the adapter singleton still exists behaviorally but is removed in Task 4.

- [ ] **Step 5: Commit controller migration**

```bash
git add packages/shared packages/core/src/core/defaults.ts packages/core/src/background/controller.ts packages/extension/entrypoints/background.ts packages/extension/tests/backgroundController.test.ts packages/extension/tests/settings.test.ts packages/cli/src/runtime/run.ts packages/cli/src/settings.ts packages/cli/src/storage.ts
git commit -m "refactor(controller): publish scoped event batches"
```

---

### Task 4: Remove the process-global logger from adapters and tab helpers

**Files:**
- Delete: `packages/core/src/core/activityLog.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/core/src/platforms/adapter.ts`
- Modify: `packages/core/src/platforms/twitch/index.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/tests/tabs.test.ts`
- Modify: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `EventEmitter` from Task 1 and `createAdapters(emit)` from Task 3.
- Produces: explicit optional `emit` parameters for pure tab helpers and adapter constructors/fetcher factories.

- [ ] **Step 1: Replace singleton tests with isolation tests**

Delete `setActivityLogger` setup/teardown from `tabs.test.ts`. Pass emitters explicitly and add:

```ts
it("keeps tab diagnostics scoped to the supplied emitter", async () => {
  const first: EngineEvent[] = [];
  const second: EngineEvent[] = [];
  await openPinnedMutedTabWithBrowser(firstBrowser(), channel, undefined, undefined, (event) => first.push(event));
  await openPinnedMutedTabWithBrowser(secondBrowser(), channel, undefined, undefined, (event) => second.push(event));
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]).not.toBe(second[0]);
});
```

Add an adapter test constructing two adapters with different emitters and assert a diagnostic from each remains in its own array.

- [ ] **Step 2: Run tab/adapter tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts tests/adapters.test.ts`

Expected: failure because helpers and constructors do not accept emitters.

- [ ] **Step 3: Inject emitters and remove the singleton module**

Add a local no-op default only at public pure-helper boundaries:

```ts
const ignoreEvent: EventEmitter = () => {};

function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform?: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}
```

Add `emit: EventEmitter = ignoreEvent` as the last parameter of tab helper functions that log. Add an emitter constructor parameter to `TwitchAdapter`, `KickAdapter`, and `createKickFetcher`; replace every `logActivity` call with `diagnostic(this.emit, ...)` or the factory-scoped emitter.

In the extension background, implement `createAdapters: (emit) => { ... }`, build the watch-tab port inside that factory, and bind `emit` through extension tab wrappers to core helpers. Apply the same scoped emitter to integrity, ad-focus, and page-context helper calls made during that controller operation.

Delete `activityLog.ts`, remove its package export, and verify `rg 'setActivityLogger|logActivity|activityLog' packages` returns no production references.

- [ ] **Step 4: Run focused tests and workspace typecheck GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts tests/adapters.test.ts tests/backgroundController.test.ts && pnpm -r typecheck`

Expected: all focused tests and every workspace typecheck pass.

- [ ] **Step 5: Commit reporter injection**

```bash
git add packages/core packages/extension/entrypoints/background.ts packages/extension/src/core/tabs.ts packages/extension/tests/tabs.test.ts packages/extension/tests/adapters.test.ts
git commit -m "refactor(core): inject event reporters"
```

---

### Task 5: Rebuild IndexedDB retention, pagination, and migration

**Files:**
- Modify: `packages/extension/package.json`
- Modify: `pnpm-lock.yaml`
- Rewrite: `packages/extension/src/core/activityStorage.ts`
- Modify: `packages/extension/src/core/storage.ts`
- Create: `packages/extension/tests/activityStorage.test.ts`
- Create: `packages/extension/tests/storageMigration.test.ts`
- Modify: `packages/shared/src/messages.ts`

**Interfaces:**
- Produces: `ActivityQuery = { platform?: Platform; category: EventCategory; cursor?: string; limit?: number }`.
- Produces: `ActivityPage = { events: ActivityHistoryRecord[]; nextCursor?: string }`.
- Produces extension repository methods `appendActivityEvents`, `importLegacyActivityEvents`, `loadActivityEvents`, and `clearActivityEvents`.

- [ ] **Step 1: Install deterministic IndexedDB test support**

Run: `pnpm --filter @lurkloot/extension add -D fake-indexeddb`

Expected: `fake-indexeddb` appears in the extension dev dependencies and the lockfile changes.

- [ ] **Step 2: Write failing repository tests**

Use `import "fake-indexeddb/auto"`, a unique database name per test through an exported test-only repository factory, and fake timers. Cover:

```ts
it("keeps activity when diagnostics exceed their independent cap", async () => {
  await repository.append([activityEvent("a")]);
  await repository.append(Array.from({ length: 2001 }, (_, index) => diagnosticEvent(index)));
  expect((await repository.load({ category: "activity" })).events.map((event) => event.data)).toContainEqual(expect.objectContaining({ rewardId: "a" }));
  expect((await repository.load({ category: "diagnostic", limit: 100 })).events).toHaveLength(100);
});

it("does not double-count expired rows while enforcing the cap", async () => {
  await seedRepository({ expired: 100, current: 2000, category: "activity" });
  await repository.prune();
  expect(await repository.count("activity")).toBe(2000);
});

it("paginates every record sharing the same millisecond", async () => {
  await seedSameTimestampRecords(3);
  const first = await repository.load({ category: "activity", limit: 2 });
  const second = await repository.load({ category: "activity", limit: 2, cursor: first.nextCursor });
  expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(3);
});

it("excludes expired records even before scheduled pruning runs", async () => {
  await seedRepository({ expired: 1, current: 1, category: "activity" });
  expect((await repository.load({ category: "activity" })).events).toHaveLength(1);
});

it("reopens after versionchange closes the cached connection", async () => {
  await repository.open();
  repository.closeForVersionChangeForTest();
  await expect(repository.load({ category: "activity" })).resolves.toBeDefined();
});
```

Migration tests must simulate append rejection, call `loadState`, then `saveState`, and assert the original raw `events` array remains in `browser.storage.local`; a subsequent successful load must import and remove it.

- [ ] **Step 3: Run repository tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityStorage.test.ts tests/storageMigration.test.ts`

Expected: failures for the current combined cap, timestamp cursor, prune ordering, connection cache, and migration failure behavior.

- [ ] **Step 4: Implement database version 2 and safe migration**

Use one `events` store and indexes `category_at_id` on `[category, at, id]` and `platform_category_at_id` on `[platform, category, at, id]`. Use the category index for popup reads and filter the optional platform while walking the cursor so platform-less global interruptions remain visible. Use a `meta` store for `lastPrunedAt`; prune at most once per 24 hours unless tests call the explicit repository prune method.

Envelope a live batch with one ISO timestamp and IDs containing a zero-padded monotonic batch sequence plus `crypto.randomUUID()`. This preserves collision-free ordering when multiple records share a millisecond. Encode the cursor as an opaque URI-encoded JSON tuple:

```ts
type ActivityCursor = [at: string, id: string];
const encodeCursor = ([at, id]: ActivityCursor): string => encodeURIComponent(JSON.stringify([at, id]));
const decodeCursor = (value: string): ActivityCursor => JSON.parse(decodeURIComponent(value)) as ActivityCursor;
```

Read with a category-specific lower bound equal to the retention cutoff and an exclusive compound upper bound from the cursor. Fetch `limit + 1`, return `nextCursor` only when the extra record exists, and never use timestamp alone.

Prune one category at a time: await expiry cursor deletion to transaction completion, start a second transaction, count that category, then delete exactly `count - cap` oldest remaining keys. Reset the cached database promise on every rejected open and in `onversionchange` before closing.

For legacy migration, parse raw browser state as:

```ts
type LegacyStoredSchedulerState = Partial<SchedulerState> & { events?: LegacyEventLogEntry[] };
```

Normalize imported records to `StoredLegacyEvent` by adding `legacy: true` and `category: record.category ?? "diagnostic"`, then pass them to `importLegacyActivityEvents` before returning operational state. This import preserves their original IDs/timestamps and commits atomically. Remove raw `events` only after that transaction commits. If import fails, return merged operational state but have `saveState` preserve any still-present raw legacy events until a later successful import removes them.

- [ ] **Step 5: Run repository and migration tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityStorage.test.ts tests/storageMigration.test.ts && pnpm --filter @lurkloot/extension typecheck`

Expected: all repository/migration tests and extension typecheck pass.

- [ ] **Step 6: Commit durable storage**

```bash
git add packages/extension/package.json pnpm-lock.yaml packages/extension/src/core/activityStorage.ts packages/extension/src/core/storage.ts packages/extension/tests/activityStorage.test.ts packages/extension/tests/storageMigration.test.ts packages/shared/src/messages.ts
git commit -m "fix(activity): make history retention robust"
```

---

### Task 6: Move activity message routing into the extension host

**Files:**
- Create: `packages/extension/src/core/activityMessages.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Create: `packages/extension/tests/activityMessages.test.ts`
- Modify: `packages/extension/tests/coreBoundary.test.ts`

**Interfaces:**
- Consumes: repository query and clear methods from Task 5.
- Produces: `handleActivityMessage(message): Promise<ActivityPage | void | undefined>` owned by the extension.

- [ ] **Step 1: Write failing routing tests**

```ts
it("handles history messages without calling the core controller", async () => {
  const load = vi.fn(async () => ({ events: [], nextCursor: undefined }));
  const clear = vi.fn(async () => undefined);
  const handler = createActivityMessageHandler({ load, clear });
  await handler({ type: "getActivity", category: "activity", platform: "twitch", limit: 80 });
  await handler({ type: "clearActivity" });
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ category: "activity" }));
  expect(clear).toHaveBeenCalledOnce();
});
```

Extend the core-boundary test to assert `packages/core` contains no `ActivityPage`, `getActivity`, `clearActivity`, or `activityStorage` reference.

- [ ] **Step 2: Run routing tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityMessages.test.ts tests/coreBoundary.test.ts`

Expected: failure because history dispatch is still wired through the core controller.

- [ ] **Step 3: Implement host routing and sink policy**

The handler returns `undefined` for non-activity messages. In `background.ts`, route credential export first, activity messages second, then delegate remaining messages to `controller.handleMessage`.

Configure `reportEvents` so activity is always appended and diagnostics are appended only when `loadSettings().diagnosticLogging` is true. Pass all accepted events in one repository append to preserve batch order.

- [ ] **Step 4: Run routing/controller tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityMessages.test.ts tests/coreBoundary.test.ts tests/backgroundController.test.ts`

Expected: all tests pass and core has no history API dependency.

- [ ] **Step 5: Commit the host boundary**

```bash
git add packages/extension/src/core/activityMessages.ts packages/extension/entrypoints/background.ts packages/extension/tests/activityMessages.test.ts packages/extension/tests/coreBoundary.test.ts
git commit -m "refactor(extension): own activity history routing"
```

---

### Task 7: Localize activity presentation and expose paging/clearing

**Files:**
- Create: `packages/popup-ui/src/activity.logic.ts`
- Modify: `packages/popup-ui/src/activity.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/popup-ui/src/demo.ts`
- Create: `packages/extension/tests/activityView.test.ts`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/zh_CN.json`

**Interfaces:**
- Consumes: `ActivityHistoryRecord` and cursor-based `ActivityPage`.
- Produces: `formatActivityEvent(event, t)`, `mergeActivityPages(current, incoming)`, and category-specific popup paging state.

- [ ] **Step 1: Write failing pure view-model tests**

```ts
it("formats current activity wording from code and payload", () => {
  const t = vi.fn((key: string, substitutions?: string | string[]) => `${key}:${Array.isArray(substitutions) ? substitutions.join("|") : substitutions ?? ""}`);
  expect(formatActivityEvent(storedStoppedEvent("runtime_restart"), t)).toBe(
    "activityFarmingStopped:Reward|Campaign|activityReasonRuntimeRestart:",
  );
  expect(t).toHaveBeenCalledWith("activityReasonRuntimeRestart");
});

it("uses stored prose only for diagnostics and legacy fallback", () => {
  expect(formatActivityEvent(storedDiagnostic("network detail"), t)).toBe("network detail");
  expect(formatActivityEvent(legacyEvent("old activity"), t)).toBe("old activity");
});

it("merges refreshed and paged results without duplicates", () => {
  expect(mergeActivityPages([event("2"), event("1")], [event("3"), event("2")]).map((entry) => entry.id)).toEqual(["3", "2", "1"]);
});
```

- [ ] **Step 2: Run the view-model tests and confirm RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityView.test.ts`

Expected: failure because activity formatting and page merging helpers do not exist.

- [ ] **Step 3: Implement localized formatting and independent streams**

Map every activity variant exhaustively in `formatActivityEvent`; the `default` branch assigns to `never`. Add locale keys for started, stopped, claimed, interruption, every `FarmingStopReason`, show/hide diagnostics, load more, clear history, confirm clear, and clearing failure.

After the repository and popup use `ActivityHistoryRecord`, remove the deprecated `EventLogEntry`, `EventCategory`, and `ActivityEventCode` compatibility declarations from `models.ts`; all live and persisted event contracts then come from `@lurkloot/shared/events`.

In `Popup.tsx`, maintain separate activity and diagnostic `{ events, nextCursor }` states. Initial polling requests `{ category: "activity" }`. Turning on diagnostics requests `{ category: "diagnostic" }`; hidden diagnostic errors never participate in the activity badge. Loading more sends the current category cursor and merges by ID. Clearing requires a first click to arm the action and a second click to send `clearActivity`, then clears both local streams.

`ActivityLog` receives already-separated streams, renders normal activity first, conditionally interleaves diagnostics by `(at,id)` when enabled, uses `formatActivityEvent`, and exposes load/clear callbacks. Update the demo adapter for required category and cursor fields.

- [ ] **Step 4: Run view, locale, and type tests GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/activityView.test.ts tests/i18n.test.ts && pnpm --filter @lurkloot/popup-ui typecheck && pnpm --filter @lurkloot/extension typecheck`

Expected: formatter, locale parity, popup UI, and extension typechecks pass.

- [ ] **Step 5: Commit popup behavior**

```bash
git add packages/popup-ui packages/locales/messages packages/extension/tests/activityView.test.ts
git commit -m "feat(activity): localize and page event history"
```

---

### Task 8: Route CLI events directly and strengthen repository verification

**Files:**
- Modify: `packages/cli/src/runtime/run.ts`
- Modify: `packages/cli/src/storage.ts`
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/src/events.ts`
- Create: `packages/cli/tests/runtime.test.ts`
- Modify: `packages/cli/tests/storage.test.ts`
- Modify: `packages/cli/tests/settings.test.ts`
- Modify: `packages/cli/tests/config.test.ts`
- Modify: `package.json`
- Modify: `docs/architecture.md`
- Modify: `packages/cli/README.md`

**Interfaces:**
- Consumes: scoped `EngineEvent` batches and event-free `SchedulerState`.
- Produces: `formatCliEvent(event): string` and `CliConfig.warnings: string[]`.

- [ ] **Step 1: Write failing CLI behavior tests**

```ts
it("logs an event batch in causal order through the logger", async () => {
  const lines: string[] = [];
  await reportCliEvents([
    startedEvent("Reward A"),
    stoppedEvent("Reward A", "target_changed"),
    startedEvent("Reward B"),
  ], loggerRecording(lines));
  expect(lines.map(stripTimestamp)).toEqual([
    "INFO [twitch] Started farming Reward A from Campaign",
    "INFO [twitch] Stopped farming Reward A from Campaign: target changed",
    "INFO [twitch] Started farming Reward B from Campaign",
  ]);
});

it("never writes legacy events back to state.json", async () => {
  await writeRawState(path, { ...DEFAULT_STATE, events: [legacyEvent()] });
  const state = await loadState(path);
  await saveState(path, state);
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("events");
});

it("warns once when enabledLogLevels is present", () => {
  const config = parseConfig({ settings: { enabledLogLevels: ["error"] } }, CONFIG_PATH);
  expect(config.warnings).toEqual([expect.stringContaining("--log")]);
});

it("rejects diagnosticLogging as extension-only", () => {
  expect(() => parseConfig({ settings: { diagnosticLogging: true } }, CONFIG_PATH)).toThrow(/extension-only/);
});
```

- [ ] **Step 2: Run CLI tests and confirm RED**

Run: `pnpm --filter @lurkloot/cli test`

Expected: failure because CLI activity formatting, warnings, and the new reporter path are absent.

- [ ] **Step 3: Implement direct CLI reporting and config warnings**

Implement `formatCliEvent` with an exhaustive activity-code switch and diagnostic message passthrough. `runLoop` supplies `reportEvents: (events) => reportCliEvents(events, logger)` and no longer imports or installs a global logger. Preserve array order.

Simplify CLI storage to parse unknown JSON through `mergeSchedulerState` and serialize `SchedulerState` directly; because the type no longer contains events, legacy extra keys disappear naturally after load/save.

Add `warnings: string[]` to `CliConfig`. When raw settings owns `enabledLogLevels`, append exactly `"settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error"`. Add `diagnosticLogging` to extension-only keys. In command handlers, emit each config warning through `logger.warn(..., "config")`; `validate-config` writes the same warning to stderr before its JSON stdout. Maintain a per-command config load so each warning appears once.

Change root `test` to `pnpm -r --if-present test`, which runs both extension and CLI Vitest suites. Update architecture and CLI docs to describe the typed reporter boundary and external retention.

- [ ] **Step 4: Run CLI tests and full check GREEN**

Run: `pnpm --filter @lurkloot/cli test && pnpm check`

Expected: CLI tests pass, root check includes both CLI and extension tests, workspace typechecks pass, and the site builds.

- [ ] **Step 5: Commit CLI and verification changes**

```bash
git add packages/cli package.json docs/architecture.md
git commit -m "refactor(cli): log engine events without persistence"
```

---

### Task 9: Final regression review and PR update

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: a clean, fully verified branch and updated draft PR.

- [ ] **Step 1: Run structural searches**

Run:

```bash
rg -n 'SchedulerState.*events|state\.events|setActivityLogger|logActivity|activityLog|enabledLogLevels' packages docs/architecture.md packages/cli/README.md --glob '*.ts' --glob '*.tsx' --glob '*.md'
rg -n 'getActivity|clearActivity|ActivityPage|indexedDB' packages/core
```

Expected: no state/global-logger/core-history references; `enabledLogLevels` appears only in CLI legacy migration tests/documentation.

- [ ] **Step 2: Run the complete verification suite**

Run: `pnpm verify`

Expected: script tests, CLI and extension tests, all workspace typechecks, Astro site build, Chromium build, and Firefox build pass.

- [ ] **Step 3: Review the complete diff**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: no whitespace errors, no unintended untracked files, and changes remain scoped to activity/event architecture.

- [ ] **Step 4: Commit verification-only fixes if needed**

If Step 2 required code changes, rerun the failing focused test first and then `pnpm verify`; commit only those fixes:

```bash
git add -u
git commit -m "fix(activity): address integration regressions"
```

If no files changed, do not create an empty commit.

- [ ] **Step 5: Push and update PR #89**

Run: `git push origin feat/activity-event-log`

Update the draft PR summary and testing section to describe the state/event separation, scoped reporters, IndexedDB guarantees, localized activity, CLI behavior, and the successful `pnpm verify` run. Keep the PR linked to issue #88.
