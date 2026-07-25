# Critical Failure Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect, with near-zero false-positive risk, that a platform is producing no value for the user, stop a page-context reopen loop, and replace the drops view with a localized panel offering "Copy logs & open issue" and "Dismiss and try again".

**Architecture:** A pure, clock-injected reducer module `packages/core/src/core/criticalHealth.ts` (modelled on the existing `authHealth.ts`) owns all detection state. State lives on `SchedulerState.criticalHealth`, so it persists with the rest of scheduler state and reaches the popup for free through `RuntimeSnapshot.state`. The scheduler feeds it one observation per tick; `tabs.ts` feeds it page-context creations and consults its circuit breaker before creating a tab. A pure markdown report builder in `@lurkloot/shared` serves both the popup button and the CLI.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, WXT, React 19, Vitest (Node env, globals enabled), `@lurkloot/shared` contracts, `@lurkloot/locales` JSON catalogs.

**Spec:** `docs/superpowers/specs/2026-07-25-critical-failure-prompt-design.md`
**Issue:** https://github.com/jamezrin/lurkloot/issues/259
**Branch/worktree:** `feat/critical-failure-prompt` in `.worktrees/critical-failure-prompt`

---

## Conventions for every task

- Two-space indent, double quotes, semicolons, camelCase values, PascalCase types/components, `import type` for type-only imports.
- Run tests from the repo root: `pnpm test -- <file>` runs the extension Vitest suite filtered to one file.
- Commit after every task with a Conventional Commit message.
- `@lurkloot/core` must never import `wxt`, `webextension-polyfill`, or touch `browser`/`chrome` globals directly — `packages/extension/tests/coreBoundary.test.ts` enforces this.

## File structure

**Create:**
- `packages/core/src/core/criticalHealth.ts` — the detector: constants, state shape, three pure reducers. One responsibility: deciding whether a platform is critically broken.
- `packages/shared/src/criticalHealth.ts` — the shared contract types (`CriticalHealthState`, `FailureRecord`, `CriticalFailureReason`) plus the normalizer, so both core and the popup depend on types rather than on core.
- `packages/shared/src/failureReport.ts` — the pure markdown report builder.
- `packages/popup-ui/src/criticalFailure.tsx` — the panel component.
- `packages/extension/tests/criticalHealth.test.ts` — detector tests.
- `packages/extension/tests/failureReport.test.ts` — report builder tests.
- `packages/extension/tests/criticalFailureView.test.tsx` — panel tests.

**Modify:**
- `packages/shared/src/models.ts` — `SchedulerState.criticalHealth`, `EngineSettings.criticalFailurePromptEnabled`.
- `packages/shared/src/events.ts` — two new activity event codes.
- `packages/shared/src/settings.ts` — default + normalization for the new setting.
- `packages/shared/src/settingsSchema.ts` — migration to version 3.
- `packages/shared/src/messages.ts` — `dismissCriticalFailure` runtime message.
- `packages/core/src/core/defaults.ts` — normalize/merge `criticalHealth`.
- `packages/core/src/core/scheduler.ts` — feed one observation per tick.
- `packages/core/src/core/tabs.ts` — breaker gate + open recording.
- `packages/core/package.json` — export `./criticalHealth`.
- `packages/core/src/background/controller.ts` — handle the dismiss message.
- `packages/popup-ui/src/activity.logic.ts` — format the two new events.
- `packages/popup-ui/src/Popup.tsx` — render the panel in place of `DropsPanel`.
- `packages/popup-ui/src/types.ts` — optional adapter hook for clipboard.
- `packages/locales/messages/*.json` (all ten) — new keys.
- `packages/extension/tests/settingsMigrations.test.ts` — version 3 coverage.

---

### Task 1: Shared contract types

**Files:**
- Create: `packages/shared/src/criticalHealth.ts`
- Modify: `packages/shared/src/models.ts`
- Test: `packages/extension/tests/criticalHealth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/criticalHealth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_HEALTH, normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";

describe("critical health normalization", () => {
  it("defaults to an unflagged, closed-breaker state", () => {
    expect(DEFAULT_CRITICAL_HEALTH).toEqual({
      status: "ok",
      failingMs: 0,
      failingTicks: 0,
      contextOpens: [],
      breakerOpen: false,
      records: [],
    });
  });

  it("restores a persisted flag while discarding malformed counters", () => {
    const restored = normalizeCriticalHealth({
      status: "flagged",
      reason: "page_context_churn",
      flaggedAt: "2026-07-25T10:00:00.000Z",
      failingMs: "nonsense",
      failingTicks: -4,
      contextOpens: ["2026-07-25T09:59:00.000Z", 42],
      breakerOpen: true,
      records: [{ at: "2026-07-25T09:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" }],
    });

    expect(restored.status).toBe("flagged");
    expect(restored.reason).toBe("page_context_churn");
    expect(restored.breakerOpen).toBe(true);
    expect(restored.failingMs).toBe(0);
    expect(restored.failingTicks).toBe(0);
    expect(restored.contextOpens).toEqual([]);
    expect(restored.records).toHaveLength(1);
  });

  it("drops an unknown status and every malformed record", () => {
    const restored = normalizeCriticalHealth({ status: "exploded", records: [{ kind: "api_error" }, "junk"] });

    expect(restored.status).toBe("ok");
    expect(restored.records).toEqual([]);
  });
});
```

Note: counters reset on restore by design — only `status`, `reason`, `flaggedAt`, `breakerOpen`, `cooldownUntil` and `records` persist across a service-worker restart.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: FAIL, cannot resolve `@lurkloot/shared/criticalHealth`.

- [ ] **Step 3: Write the contract module**

Create `packages/shared/src/criticalHealth.ts`:

```ts
import type { Platform } from "./models";

export type CriticalFailureReason = "no_progress" | "page_context_churn";

export type FailureRecordKind = "api_error" | "auth" | "context_open" | "no_accrual";

// One bounded, always-on breadcrumb. Recorded regardless of the diagnosticLogging
// setting (which defaults off), because the failure report is worthless without
// it — see the NETV4R report in the design doc. Never carries response bodies,
// tokens or cookies.
export interface FailureRecord {
  at: string;
  platform: Platform;
  kind: FailureRecordKind;
  code?: string;
  status?: number;
  detail?: string;
}

export interface CriticalHealthState {
  status: "ok" | "flagged";
  reason?: CriticalFailureReason;
  flaggedAt?: string;
  // Counters are deliberately NOT persisted: MV3 workers recycle constantly and
  // stale counters from an old outage must not accumulate across sessions.
  failingMs: number;
  failingTicks: number;
  lastAccrualAt?: string;
  lastWatchedMinutes?: number;
  contextOpens: string[];
  breakerOpen: boolean;
  dismissedAt?: string;
  cooldownUntil?: string;
  records: FailureRecord[];
}

export const CRITICAL_HEALTH_RECORD_LIMIT = 30;
const FAILURE_RECORD_KINDS = new Set<FailureRecordKind>(["api_error", "auth", "context_open", "no_accrual"]);
const CRITICAL_FAILURE_REASONS = new Set<CriticalFailureReason>(["no_progress", "page_context_churn"]);
const DETAIL_MAX_LENGTH = 200;

export const DEFAULT_CRITICAL_HEALTH: CriticalHealthState = {
  status: "ok",
  failingMs: 0,
  failingTicks: 0,
  contextOpens: [],
  breakerOpen: false,
  records: [],
};

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function normalizeRecord(candidate: unknown): FailureRecord | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Record<string, unknown>;
  const at = isoOrUndefined(value.at);
  const platform = value.platform === "twitch" || value.platform === "kick" ? value.platform : undefined;
  const kind = FAILURE_RECORD_KINDS.has(value.kind as FailureRecordKind) ? value.kind as FailureRecordKind : undefined;
  if (!at || !platform || !kind) return undefined;
  const record: FailureRecord = { at, platform, kind };
  if (typeof value.code === "string" && value.code.length > 0 && value.code.length <= 64) record.code = value.code;
  if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
    record.status = value.status;
  }
  if (typeof value.detail === "string" && value.detail.length > 0) record.detail = value.detail.slice(0, DETAIL_MAX_LENGTH);
  return record;
}

export function normalizeCriticalHealth(candidate: unknown): CriticalHealthState {
  const value = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const status = value.status === "flagged" ? "flagged" : "ok";
  const reason = CRITICAL_FAILURE_REASONS.has(value.reason as CriticalFailureReason)
    ? value.reason as CriticalFailureReason
    : undefined;
  const records = Array.isArray(value.records)
    ? value.records.map(normalizeRecord).filter((record): record is FailureRecord => record !== undefined).slice(-CRITICAL_HEALTH_RECORD_LIMIT)
    : [];
  const state: CriticalHealthState = {
    ...DEFAULT_CRITICAL_HEALTH,
    status,
    breakerOpen: value.breakerOpen === true,
    records,
  };
  if (status === "flagged" && reason) state.reason = reason;
  const flaggedAt = isoOrUndefined(value.flaggedAt);
  if (status === "flagged" && flaggedAt) state.flaggedAt = flaggedAt;
  const dismissedAt = isoOrUndefined(value.dismissedAt);
  if (dismissedAt) state.dismissedAt = dismissedAt;
  const cooldownUntil = isoOrUndefined(value.cooldownUntil);
  if (cooldownUntil) state.cooldownUntil = cooldownUntil;
  return state;
}
```

- [ ] **Step 4: Add the state field**

In `packages/shared/src/models.ts`, add the import at the top of the file:

```ts
import type { CriticalHealthState } from "./criticalHealth";
```

and add this field to `interface SchedulerState`, directly after `authHealth`:

```ts
  // Per-platform critical-failure detection. Persisted so the flag survives an
  // MV3 service-worker restart; its counters are reset on restore.
  criticalHealth?: Partial<Record<Platform, CriticalHealthState>>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add packages/shared/src/criticalHealth.ts packages/shared/src/models.ts packages/extension/tests/criticalHealth.test.ts
git commit -m "feat(shared): add critical health state contract"
```

---

### Task 2: New activity events

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/popup-ui/src/activity.logic.ts:181`
- Test: `packages/extension/tests/eventContract.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the existing top-level `describe` in `packages/extension/tests/eventContract.test.ts`:

```ts
  it("types critical failure detection and clearing", () => {
    const detected: EngineEvent = {
      category: "activity",
      code: "critical_failure_detected",
      level: "error",
      platform: "kick",
      data: { reason: "page_context_churn" },
    };
    const cleared: EngineEvent = {
      category: "activity",
      code: "critical_failure_cleared",
      level: "info",
      platform: "kick",
      data: { reason: "page_context_churn" },
    };

    expectTypeOf(detected).toMatchTypeOf<EngineEvent>();
    expectTypeOf(cleared).toMatchTypeOf<EngineEvent>();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- eventContract.test.ts`
Expected: FAIL — `"critical_failure_detected"` is not assignable to the `code` union.

- [ ] **Step 3: Extend the event union**

In `packages/shared/src/events.ts`, add the import:

```ts
import type { CriticalFailureReason } from "./criticalHealth";
```

and add these two members to the `ActivityEvent` union, after the `auth_health_changed` member (remember to move the trailing `;` to the last member):

```ts
  | { category: "activity"; code: "critical_failure_detected"; level: "error"; platform: Platform; message?: never; data: { reason: CriticalFailureReason } }
  | { category: "activity"; code: "critical_failure_cleared"; level: "info"; platform: Platform; message?: never; data: { reason: CriticalFailureReason } };
```

- [ ] **Step 4: Format the events in the activity log**

`formatCurrentActivity` in `packages/popup-ui/src/activity.logic.ts` is an exhaustive switch, so it will not compile until both codes are handled. Add these cases immediately before the `default:` case:

```ts
    case "critical_failure_detected":
      return t("activityCriticalFailureDetected", [event.platform, formatCriticalFailureReason(event.data.reason, t)]);
    case "critical_failure_cleared":
      return t("activityCriticalFailureCleared", event.platform);
```

and add this helper next to the existing `formatPageContextOpenReason` helper in the same file:

```ts
function formatCriticalFailureReason(reason: CriticalFailureReason, t: TFunction): string {
  return reason === "page_context_churn"
    ? t("criticalFailureReasonPageContextChurn")
    : t("criticalFailureReasonNoProgress");
}
```

with the import `import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";` added to the file's imports.

- [ ] **Step 5: Add the English message keys**

In `packages/locales/messages/en.json`, next to `"activityAuthHealthChanged"`:

```json
  "activityCriticalFailureDetected": { "message": "$1 is not working: $2." },
  "activityCriticalFailureCleared": { "message": "$1 critical failure dismissed; retrying." },
  "criticalFailureReasonNoProgress": { "message": "no progress despite repeated errors" },
  "criticalFailureReasonPageContextChurn": { "message": "a tab kept reopening" },
```

The other nine catalogs are filled in Task 8, which does all localization in one pass.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- eventContract.test.ts activityView.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/shared/src/events.ts packages/popup-ui/src/activity.logic.ts packages/locales/messages/en.json packages/extension/tests/eventContract.test.ts
git commit -m "feat(shared): add critical failure activity events"
```

---

### Task 3: The detector reducers

**Files:**
- Create: `packages/core/src/core/criticalHealth.ts`
- Modify: `packages/core/package.json`
- Test: `packages/extension/tests/criticalHealth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/extension/tests/criticalHealth.test.ts`:

```ts
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import {
  CONTEXT_CHURN_LIMIT,
  CONTEXT_CHURN_WINDOW_MS,
  FAILING_WINDOW_MS,
  MIN_FAILING_TICKS,
  dismissCriticalFailure,
  observeCriticalHealth,
  recordPageContextOpen,
} from "@lurkloot/core/criticalHealth";
import type { SchedulerState } from "@lurkloot/shared/models";

const START = Date.parse("2026-07-25T10:00:00.000Z");

function baseState(): SchedulerState {
  return structuredClone(DEFAULT_STATE);
}

// Drives `ticks` observations five minutes apart, all failing and none progressing.
function runFailingTicks(state: SchedulerState, ticks: number, options?: { progressedOn?: number }): SchedulerState {
  let current = state;
  for (let index = 0; index < ticks; index += 1) {
    current = observeCriticalHealth(current, "twitch", {
      at: START + index * 5 * 60 * 1000,
      failing: true,
      progressed: options?.progressedOn === index,
      preconditionBroke: false,
    }).state;
  }
  return current;
}

describe("critical health detection", () => {
  it("never flags before the failing window elapses", () => {
    const state = runFailingTicks(baseState(), MIN_FAILING_TICKS);

    expect(state.criticalHealth?.twitch?.status).toBe("ok");
    expect(state.criticalHealth?.twitch?.failingMs).toBeLessThan(FAILING_WINDOW_MS);
  });

  it("flags once after sustained failure with no progress", () => {
    const ticks = Math.ceil(FAILING_WINDOW_MS / (5 * 60 * 1000)) + 2;
    const state = runFailingTicks(baseState(), ticks);

    expect(state.criticalHealth?.twitch?.status).toBe("flagged");
    expect(state.criticalHealth?.twitch?.reason).toBe("no_progress");

    const again = observeCriticalHealth(state, "twitch", {
      at: START + ticks * 5 * 60 * 1000,
      failing: true,
      progressed: false,
      preconditionBroke: false,
    });

    expect(again.event).toBeUndefined();
  });

  it("emits the detection event exactly once, at the transition", () => {
    const ticks = Math.ceil(FAILING_WINDOW_MS / (5 * 60 * 1000)) + 2;
    let state = baseState();
    const events: string[] = [];
    for (let index = 0; index < ticks; index += 1) {
      const transition = observeCriticalHealth(state, "twitch", {
        at: START + index * 5 * 60 * 1000,
        failing: true,
        progressed: false,
        preconditionBroke: false,
      });
      state = transition.state;
      if (transition.event) events.push(transition.event.code);
    }

    expect(events).toEqual(["critical_failure_detected"]);
  });

  it("resets the window when progress is observed", () => {
    const ticks = Math.ceil(FAILING_WINDOW_MS / (5 * 60 * 1000));
    const state = runFailingTicks(baseState(), ticks, { progressedOn: ticks - 2 });

    expect(state.criticalHealth?.twitch?.status).toBe("ok");
  });

  it("resets the window when an accrual precondition breaks", () => {
    let state = runFailingTicks(baseState(), 4);
    state = observeCriticalHealth(state, "twitch", {
      at: START + 4 * 5 * 60 * 1000,
      failing: true,
      progressed: false,
      preconditionBroke: true,
    }).state;

    expect(state.criticalHealth?.twitch?.failingMs).toBe(0);
    expect(state.criticalHealth?.twitch?.failingTicks).toBe(0);
  });

  it("resets the window on a clean tick", () => {
    let state = runFailingTicks(baseState(), 4);
    state = observeCriticalHealth(state, "twitch", {
      at: START + 4 * 5 * 60 * 1000,
      failing: false,
      progressed: false,
      preconditionBroke: false,
    }).state;

    expect(state.criticalHealth?.twitch?.failingMs).toBe(0);
  });

  it("caps a single tick delta so a suspended browser cannot flag instantly", () => {
    let state = observeCriticalHealth(baseState(), "twitch", {
      at: START,
      failing: true,
      progressed: false,
      preconditionBroke: false,
    }).state;
    state = observeCriticalHealth(state, "twitch", {
      at: START + 12 * 60 * 60 * 1000,
      failing: true,
      progressed: false,
      preconditionBroke: false,
    }).state;

    expect(state.criticalHealth?.twitch?.status).toBe("ok");
    expect(state.criticalHealth?.twitch?.failingMs).toBeLessThanOrEqual(FAILING_WINDOW_MS);
  });

  it("flags page-context churn immediately and opens the breaker", () => {
    let state = baseState();
    let flagged: string | undefined;
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      const transition = recordPageContextOpen(state, "kick", START + index * 60 * 1000, "background_rejected");
      state = transition.state;
      if (transition.event?.code === "critical_failure_detected") flagged = transition.event.data.reason;
    }

    expect(flagged).toBe("page_context_churn");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(state.criticalHealth?.twitch?.status ?? "ok").toBe("ok");
  });

  it("does not flag opens spread beyond the churn window", () => {
    let state = baseState();
    for (let index = 0; index < CONTEXT_CHURN_LIMIT + 2; index += 1) {
      state = recordPageContextOpen(state, "kick", START + index * (CONTEXT_CHURN_WINDOW_MS / 2), "background_rejected").state;
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(false);
  });

  it("dismissal resets counters, closes the breaker and starts a cooldown", () => {
    let state = baseState();
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      state = recordPageContextOpen(state, "kick", START + index * 60 * 1000, "background_rejected").state;
    }

    const dismissed = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000);

    expect(dismissed.event?.code).toBe("critical_failure_cleared");
    expect(dismissed.state.criticalHealth?.kick?.status).toBe("ok");
    expect(dismissed.state.criticalHealth?.kick?.breakerOpen).toBe(false);
    expect(dismissed.state.criticalHealth?.kick?.contextOpens).toEqual([]);
    expect(Date.parse(dismissed.state.criticalHealth?.kick?.cooldownUntil ?? "")).toBeGreaterThan(START + 10 * 60 * 1000);
  });

  it("refuses to re-flag during the cooldown", () => {
    let state = baseState();
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      state = recordPageContextOpen(state, "kick", START + index * 60 * 1000, "background_rejected").state;
    }
    state = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000).state;
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      state = recordPageContextOpen(state, "kick", START + 11 * 60 * 1000 + index * 1000, "background_rejected").state;
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
  });

  it("keeps the failure ring buffer bounded and newest-last", () => {
    let state = baseState();
    for (let index = 0; index < 40; index += 1) {
      state = observeCriticalHealth(state, "twitch", {
        at: START + index * 60 * 1000,
        failing: true,
        progressed: false,
        preconditionBroke: false,
        record: { kind: "api_error", code: "http_error", status: 503, detail: `failure ${index}` },
      }).state;
    }

    const records = state.criticalHealth?.twitch?.records ?? [];
    expect(records).toHaveLength(30);
    expect(records.at(-1)?.detail).toBe("failure 39");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: FAIL, cannot resolve `@lurkloot/core/criticalHealth`.

- [ ] **Step 3: Write the detector**

Create `packages/core/src/core/criticalHealth.ts`:

```ts
import type { ActivityEvent, PageContextOpenReason } from "@lurkloot/shared/events";
import type { CriticalFailureReason, CriticalHealthState, FailureRecord } from "@lurkloot/shared/criticalHealth";
import { CRITICAL_HEALTH_RECORD_LIMIT, DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";

// Deliberately conservative constants, not settings. The prompt tells the user
// the extension is broken; a false positive is worse than a late one.
export const FAILING_WINDOW_MS = 45 * 60 * 1000;
export const MIN_FAILING_TICKS = 6;
// A single tick may report a huge delta after the browser was suspended. Clamp it
// so wall-clock sleep can never substitute for observed failing time.
export const MAX_TICK_DELTA_MS = 5 * 60 * 1000;
export const CONTEXT_CHURN_WINDOW_MS = 10 * 60 * 1000;
export const CONTEXT_CHURN_LIMIT = 5;
export const COOLDOWN_MS = FAILING_WINDOW_MS;

export interface CriticalHealthObservation {
  at: number;
  // The tick ended in error: session status "error", platform backoff, or
  // discovery/readProgress threw.
  failing: boolean;
  // watchedMinutes increased for the active reward this tick.
  progressed: boolean;
  // An accrual precondition broke mid-window (channel offline, category change,
  // heartbeat unhealthy, fallback, pause, manual watch, target switch).
  preconditionBroke: boolean;
  watchedMinutes?: number;
  record?: Omit<FailureRecord, "at" | "platform">;
}

export interface CriticalHealthTransition {
  state: SchedulerState;
  event?: ActivityEvent;
}

function current(state: SchedulerState, platform: Platform): CriticalHealthState {
  return state.criticalHealth?.[platform] ?? DEFAULT_CRITICAL_HEALTH;
}

function withHealth(state: SchedulerState, platform: Platform, health: CriticalHealthState): SchedulerState {
  return { ...state, criticalHealth: { ...state.criticalHealth, [platform]: health } };
}

function appendRecord(
  records: readonly FailureRecord[],
  platform: Platform,
  at: number,
  record: Omit<FailureRecord, "at" | "platform"> | undefined,
): FailureRecord[] {
  if (!record) return [...records];
  return [...records, { ...record, at: new Date(at).toISOString(), platform }].slice(-CRITICAL_HEALTH_RECORD_LIMIT);
}

function inCooldown(health: CriticalHealthState, at: number): boolean {
  return health.cooldownUntil !== undefined && at < Date.parse(health.cooldownUntil);
}

function flag(
  health: CriticalHealthState,
  platform: Platform,
  at: number,
  reason: CriticalFailureReason,
): { health: CriticalHealthState; event: ActivityEvent } {
  return {
    health: {
      ...health,
      status: "flagged",
      reason,
      flaggedAt: new Date(at).toISOString(),
      breakerOpen: reason === "page_context_churn" ? true : health.breakerOpen,
    },
    event: {
      category: "activity",
      code: "critical_failure_detected",
      level: "error",
      platform,
      data: { reason },
    },
  };
}

export function observeCriticalHealth(
  state: SchedulerState,
  platform: Platform,
  observation: CriticalHealthObservation,
): CriticalHealthTransition {
  const health = current(state, platform);
  const records = appendRecord(health.records, platform, observation.at, observation.record);
  const lastObservedAt = health.lastAccrualAt ? Date.parse(health.lastAccrualAt) : undefined;

  // Any of these means the platform is not in a continuous no-value episode.
  if (!observation.failing || observation.progressed || observation.preconditionBroke) {
    const reset: CriticalHealthState = {
      ...health,
      failingMs: 0,
      failingTicks: 0,
      lastAccrualAt: new Date(observation.at).toISOString(),
      records,
    };
    if (observation.watchedMinutes !== undefined) reset.lastWatchedMinutes = observation.watchedMinutes;
    return { state: withHealth(state, platform, reset) };
  }

  const delta = lastObservedAt === undefined
    ? 0
    : Math.min(Math.max(observation.at - lastObservedAt, 0), MAX_TICK_DELTA_MS);
  const next: CriticalHealthState = {
    ...health,
    failingMs: health.failingMs + delta,
    failingTicks: health.failingTicks + 1,
    lastAccrualAt: new Date(observation.at).toISOString(),
    records,
  };
  if (observation.watchedMinutes !== undefined) next.lastWatchedMinutes = observation.watchedMinutes;

  const ready = next.failingMs >= FAILING_WINDOW_MS && next.failingTicks >= MIN_FAILING_TICKS;
  if (!ready || next.status === "flagged" || inCooldown(next, observation.at)) {
    return { state: withHealth(state, platform, next) };
  }

  const flagged = flag(next, platform, observation.at, "no_progress");
  return { state: withHealth(state, platform, flagged.health), event: flagged.event };
}

export function recordPageContextOpen(
  state: SchedulerState,
  platform: Platform,
  at: number,
  reason: PageContextOpenReason,
): CriticalHealthTransition {
  const health = current(state, platform);
  const opens = [...health.contextOpens, new Date(at).toISOString()]
    .filter((stamp) => at - Date.parse(stamp) <= CONTEXT_CHURN_WINDOW_MS)
    .slice(-CONTEXT_CHURN_LIMIT);
  const next: CriticalHealthState = {
    ...health,
    contextOpens: opens,
    records: appendRecord(health.records, platform, at, { kind: "context_open", code: reason }),
  };

  if (opens.length < CONTEXT_CHURN_LIMIT || next.status === "flagged" || inCooldown(next, at)) {
    return { state: withHealth(state, platform, next) };
  }

  const flagged = flag(next, platform, at, "page_context_churn");
  return { state: withHealth(state, platform, flagged.health), event: flagged.event };
}

export function dismissCriticalFailure(
  state: SchedulerState,
  platform: Platform,
  at: number,
): CriticalHealthTransition {
  const health = current(state, platform);
  if (health.status !== "flagged") return { state };

  const reason = health.reason ?? "no_progress";
  const next: CriticalHealthState = {
    ...DEFAULT_CRITICAL_HEALTH,
    records: health.records,
    dismissedAt: new Date(at).toISOString(),
    cooldownUntil: new Date(at + COOLDOWN_MS).toISOString(),
  };

  return {
    state: withHealth(state, platform, next),
    event: {
      category: "activity",
      code: "critical_failure_cleared",
      level: "info",
      platform,
      data: { reason },
    },
  };
}

export function isPageContextBreakerOpen(state: SchedulerState, platform: Platform): boolean {
  return current(state, platform).breakerOpen;
}
```

- [ ] **Step 4: Export the module**

In `packages/core/package.json`, add to the `exports` map next to `"./authHealth"`:

```json
    "./criticalHealth": "./src/core/criticalHealth.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: PASS, all detection tests green.

- [ ] **Step 6: Confirm the core boundary holds**

Run: `pnpm test -- coreBoundary.test.ts`
Expected: PASS — the new core module imports only `@lurkloot/shared`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/core/criticalHealth.ts packages/core/package.json packages/extension/tests/criticalHealth.test.ts
git commit -m "feat(core): add critical failure detector"
```

---

### Task 4: Persist the state through defaults

**Files:**
- Modify: `packages/core/src/core/defaults.ts`
- Test: `packages/extension/tests/criticalHealth.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/criticalHealth.test.ts`:

```ts
import { mergeSchedulerState } from "@lurkloot/core/defaults";

describe("critical health persistence", () => {
  it("restores a flagged platform but resets its counters across a restart", () => {
    const merged = mergeSchedulerState({
      criticalHealth: {
        kick: {
          status: "flagged",
          reason: "page_context_churn",
          flaggedAt: "2026-07-25T10:00:00.000Z",
          breakerOpen: true,
          failingMs: 999_999,
          failingTicks: 99,
          contextOpens: ["2026-07-25T09:59:00.000Z"],
          records: [{ at: "2026-07-25T09:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" }],
        },
      },
    });

    expect(merged.criticalHealth?.kick?.status).toBe("flagged");
    expect(merged.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(merged.criticalHealth?.kick?.failingMs).toBe(0);
    expect(merged.criticalHealth?.kick?.contextOpens).toEqual([]);
    expect(merged.criticalHealth?.kick?.records).toHaveLength(1);
  });

  it("omits the block entirely when nothing was persisted", () => {
    expect(mergeSchedulerState({}).criticalHealth).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: FAIL — `criticalHealth` comes back `undefined` on the first test.

- [ ] **Step 3: Merge the field**

In `packages/core/src/core/defaults.ts`, add the import:

```ts
import { normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";
import type { CriticalHealthState } from "@lurkloot/shared/criticalHealth";
```

and inside `mergeSchedulerState`, alongside the existing per-field merges, add:

```ts
  const criticalHealthRaw = (value as { criticalHealth?: Record<string, unknown> } | undefined)?.criticalHealth;
  const criticalHealth = criticalHealthRaw && typeof criticalHealthRaw === "object"
    ? (["twitch", "kick"] as const).reduce<Partial<Record<Platform, CriticalHealthState>>>((accumulator, platform) => {
      if (criticalHealthRaw[platform]) accumulator[platform] = normalizeCriticalHealth(criticalHealthRaw[platform]);
      return accumulator;
    }, {})
    : undefined;
```

then include `...(criticalHealth && Object.keys(criticalHealth).length > 0 ? { criticalHealth } : {})` in the returned state object. Follow whatever spread/return shape the surrounding code already uses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- criticalHealth.test.ts storageMigration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/defaults.ts packages/extension/tests/criticalHealth.test.ts
git commit -m "feat(core): persist critical health across restarts"
```

---

### Task 5: The `criticalFailurePromptEnabled` setting

**Files:**
- Modify: `packages/shared/src/models.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/settingsSchema.ts`
- Test: `packages/extension/tests/settingsMigrations.test.ts`, `packages/extension/tests/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/settingsMigrations.test.ts`, inside its top-level `describe`:

```ts
  it("adds the critical failure prompt toggle at version 3", () => {
    const migrated = migrateSettings({ version: 2, running: true });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(true);
    expect(migrated.settings.version).toBe(3);
  });

  it("preserves an explicit opt-out through migration", () => {
    const migrated = migrateSettings({ version: 2, criticalFailurePromptEnabled: false });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(false);
  });
```

Match the existing call shape in that file — if its helper wraps `migrateSettings` differently, use the file's own helper rather than the raw function.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- settingsMigrations.test.ts`
Expected: FAIL — property missing, version still 2.

- [ ] **Step 3: Add the setting to the contract**

In `packages/shared/src/models.ts`, add to `interface EngineSettings`, after `skipUnfinishableRewards`:

```ts
  // Kill switch for the critical-failure detector and its popup prompt. On by
  // default; thresholds themselves are fixed constants in core.
  criticalFailurePromptEnabled: boolean;
```

In `packages/shared/src/settings.ts`, add to `DEFAULT_ENGINE_SETTINGS`:

```ts
  criticalFailurePromptEnabled: true,
```

and to `mergeEngineSettings`'s returned object:

```ts
    criticalFailurePromptEnabled: booleanOr(value?.criticalFailurePromptEnabled, DEFAULT_ENGINE_SETTINGS.criticalFailurePromptEnabled),
```

- [ ] **Step 4: Add the migration**

In `packages/shared/src/settingsSchema.ts`, append to the `MIGRATIONS` registry:

```ts
  { to: 3, migrate: migrateToV3 },
```

and add the migration function next to `migrateToV2`:

```ts
// Migration 3 introduces the critical-failure prompt toggle. Absent means "on":
// existing installs get the detector, and an explicit false is preserved.
function migrateToV3(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(raw, "criticalFailurePromptEnabled")) raw.criticalFailurePromptEnabled = true;
  return raw;
}
```

If the `SettingsMigration.migrate` signature requires the `diagnose` parameter, accept it and leave it unused with a leading underscore, matching how other no-diagnostic migrations in the file do it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- settingsMigrations.test.ts settings.test.ts settingsRegistry.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add packages/shared/src packages/extension/tests/settingsMigrations.test.ts
git commit -m "feat(shared): add criticalFailurePromptEnabled setting"
```

---

### Task 6: Feed the detector from the scheduler

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/scheduler.test.ts`, inside its top-level `describe`, following the file's existing harness for building a state, settings and a stub adapter:

```ts
  it("records a failing tick when discovery throws", async () => {
    const adapter = stubAdapter({
      discoverCampaigns: async () => {
        throw new Error("Twitch inventory query failed");
      },
    });

    const result = await runTick(adapter, { criticalFailurePromptEnabled: true });

    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(1);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)?.kind).toBe("api_error");
  });

  it("does not track anything when the prompt is disabled", async () => {
    const adapter = stubAdapter({
      discoverCampaigns: async () => {
        throw new Error("Twitch inventory query failed");
      },
    });

    const result = await runTick(adapter, { criticalFailurePromptEnabled: false });

    expect(result.state.criticalHealth?.twitch).toBeUndefined();
  });

  it("clears the failing counters after a healthy tick that accrues", async () => {
    const adapter = stubAdapter({});

    let result = await runTick(adapter, { criticalFailurePromptEnabled: true });
    result = await runTick(adapter, { criticalFailurePromptEnabled: true }, result.state);

    expect(result.state.criticalHealth?.twitch?.failingMs).toBe(0);
  });
```

`stubAdapter` and `runTick` are names for the file's existing helpers — use whatever that file already defines rather than introducing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scheduler.test.ts`
Expected: FAIL — `criticalHealth` is undefined on the first test.

- [ ] **Step 3: Wire the observation into the tick**

In `packages/core/src/core/scheduler.ts`, add the import:

```ts
import { observeCriticalHealth } from "./criticalHealth";
import type { CriticalHealthObservation } from "./criticalHealth";
```

Inside the per-platform loop, declare an accumulator before the `try` that wraps discovery:

```ts
      // Collected across the tick and applied exactly once at the end, so the
      // detector sees one observation per platform per tick regardless of which
      // branch the tick took.
      let observation: CriticalHealthObservation | undefined;
```

Set `observation` at each outcome. In the `catch` around `discoverCampaigns`/`readProgress` (the block that currently sets `discoveryFailed = true`), add before the existing `emitDiagnostic` calls:

```ts
        observation = {
          at: Date.now(),
          failing: true,
          progressed: false,
          preconditionBroke: false,
          record: {
            kind: "api_error",
            code: error instanceof SafeFetchError ? safeFetchFailure(error.failure).kind : "unknown_error",
            status: error instanceof SafeFetchError ? safeFetchFailure(error.failure).status : undefined,
            detail: error instanceof Error ? error.message : String(error),
          },
        };
```

In the `isInBackoff(previous)` branch, before `continue`:

```ts
        observation = { at: Date.now(), failing: true, progressed: false, preconditionBroke: false, record: { kind: "api_error", code: "platform_backoff" } };
```

After progress is refreshed successfully, compute the accrual arm from the active reward. Add this immediately after `nextState.campaigns[platform] = campaigns;`:

```ts
        const activeReward = activeRewardFor(campaigns, nextState.sessions[platform]);
        const previousWatchedMinutes = state.criticalHealth?.[platform]?.lastWatchedMinutes;
        const watchedMinutes = activeReward?.watchedMinutes;
        observation = {
          at: Date.now(),
          failing: false,
          progressed: watchedMinutes !== undefined && previousWatchedMinutes !== undefined && watchedMinutes > previousWatchedMinutes,
          preconditionBroke: false,
          watchedMinutes,
        };
```

where `activeRewardFor` is a small local helper added near the other module-level helpers in the file:

```ts
// The reward the session claims to be watching, if it is still present in the
// freshly-read campaign list. Returns undefined when nothing is being farmed,
// which the detector reads as "no watch session sustained".
function activeRewardFor(campaigns: readonly DropCampaign[], session: WatchSession): DropReward | undefined {
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = campaigns.find((candidate) => candidate.id === session.campaignId);
  return campaign?.rewards.find((reward) => reward.id === session.rewardId);
}
```

Wherever the tick sets a session reason that represents an accrual precondition break — `channel_offline`, `channel_mismatch`, `watch_unhealthy`, `manual_watch`, `target_changed`, `higher_priority_reward`, `higher_priority_idle_watchlist` — set `observation = { at: Date.now(), failing: false, progressed: false, preconditionBroke: true }` before continuing. A single assignment placed where the session's `reasonCode` is decided is enough; do not scatter it.

Finally, apply the observation at the end of each platform iteration, before the loop continues to the next platform:

```ts
      if (settings.criticalFailurePromptEnabled && observation) {
        const transition = observeCriticalHealth(nextState, platform, observation);
        nextState = transition.state;
        if (transition.event) emit(transition.event);
      }
```

If `nextState` is declared `const` in that scope, change it to `let`, or apply the transition by assigning `nextState.criticalHealth = transition.state.criticalHealth` — prefer whichever matches the surrounding style. Note the `continue` statements in the loop: the observation must be applied before each one, so extract the block above into a local closure `applyObservation()` and call it at each exit point rather than duplicating it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- scheduler.test.ts criticalHealth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(core): feed critical health observations from the scheduler"
```

---

### Task 7: Page-context churn recording and the circuit breaker

**Files:**
- Modify: `packages/core/src/core/tabs.ts:818` (the `browserApi.tabs.create` call in `findOrCreatePageContextTab`)
- Test: `packages/extension/tests/criticalHealth.test.ts`

`tabs.ts` keeps module-level maps and has no access to `SchedulerState`, so the breaker is exposed as a tiny module-level registry that the scheduler keeps in sync with the persisted state. This keeps the deep page-context call sites unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/criticalHealth.test.ts`:

```ts
import { isPageContextBreakerOpen } from "@lurkloot/core/criticalHealth";
import { pageContextBreakerOpen, syncPageContextBreakers } from "@lurkloot/core/tabs";

describe("page context circuit breaker", () => {
  it("mirrors the persisted breaker state", () => {
    let state = baseState();
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      state = recordPageContextOpen(state, "kick", START + index * 60 * 1000, "background_rejected").state;
    }

    syncPageContextBreakers(state);

    expect(isPageContextBreakerOpen(state, "kick")).toBe(true);
    expect(pageContextBreakerOpen("kick")).toBe(true);
    expect(pageContextBreakerOpen("twitch")).toBe(false);
  });

  it("closes again once the failure is dismissed", () => {
    let state = baseState();
    for (let index = 0; index < CONTEXT_CHURN_LIMIT; index += 1) {
      state = recordPageContextOpen(state, "kick", START + index * 60 * 1000, "background_rejected").state;
    }
    syncPageContextBreakers(state);
    state = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000).state;
    syncPageContextBreakers(state);

    expect(pageContextBreakerOpen("kick")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- criticalHealth.test.ts`
Expected: FAIL — `syncPageContextBreakers` is not exported from `@lurkloot/core/tabs`.

- [ ] **Step 3: Add the breaker registry to `tabs.ts`**

In `packages/core/src/core/tabs.ts`, next to the existing `retainedPageContextTabs` map:

```ts
// Mirrors SchedulerState.criticalHealth[platform].breakerOpen. The page-context
// call sites are several layers deep and have no access to scheduler state, so
// the scheduler pushes the flag here once per tick instead.
const openPageContextBreakers = new Set<Platform>();

export function syncPageContextBreakers(state: { criticalHealth?: Partial<Record<Platform, { breakerOpen: boolean }>> }): void {
  for (const platform of ["twitch", "kick"] as const) {
    if (state.criticalHealth?.[platform]?.breakerOpen) openPageContextBreakers.add(platform);
    else openPageContextBreakers.delete(platform);
  }
}

export function pageContextBreakerOpen(platform: Platform): boolean {
  return openPageContextBreakers.has(platform);
}

function platformForOrigin(origin: string): Platform | undefined {
  if (origin === "https://kick.com") return "kick";
  if (origin === "https://www.twitch.tv" || origin === "https://twitch.tv") return "twitch";
  return undefined;
}
```

Then gate creation in `findOrCreatePageContextTab`, immediately before `const tab = await browserApi.tabs.create(...)`:

```ts
  const contextPlatform = retain?.platform ?? platformForOrigin(origin);
  if (contextPlatform && openPageContextBreakers.has(contextPlatform)) {
    throw new SafeFetchError({
      kind: "security_policy_blocked",
      reason: "Page context creation is suspended after repeated reopening",
    });
  }
```

- [ ] **Step 4: Call the sync from the scheduler**

In `packages/core/src/core/scheduler.ts`, import `syncPageContextBreakers` from `./tabs` and call it once at the top of the tick, after the state has been merged and before the per-platform loop:

```ts
  syncPageContextBreakers(nextState);
```

- [ ] **Step 5: Record opens into the detector**

`tabs.ts` already emits `page_context_opened`. Rather than threading state into `tabs.ts`, fold those events into the detector where they are handled. In `packages/core/src/background/controller.ts`, in the path that receives engine events, add before the event is stored:

```ts
      if (event.category === "activity" && event.code === "page_context_opened" && settings.criticalFailurePromptEnabled) {
        const transition = recordPageContextOpen(state, event.platform, Date.now(), event.data.reason);
        state = transition.state;
        if (transition.event) emit(transition.event);
      }
```

with `import { recordPageContextOpen } from "@lurkloot/core/criticalHealth";` — or the relative path `../core/criticalHealth` given the controller lives inside core. Persist `state` through the controller's normal save path so the breaker survives a restart.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- criticalHealth.test.ts backgroundController.test.ts coreBoundary.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/extension/tests/criticalHealth.test.ts
git commit -m "feat(core): stop page context churn with a circuit breaker"
```

---

### Task 8: The failure report builder

**Files:**
- Create: `packages/shared/src/failureReport.ts`
- Test: `packages/extension/tests/failureReport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/failureReport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFailureReport } from "@lurkloot/shared/failureReport";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";

const INPUT = {
  platform: "kick" as const,
  version: "1.11.0",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  locale: "en",
  at: "2026-07-25T12:00:00.000Z",
  settings: DEFAULT_SETTINGS,
  state: {
    ...DEFAULT_STATE,
    criticalHealth: {
      kick: {
        status: "flagged" as const,
        reason: "page_context_churn" as const,
        flaggedAt: "2026-07-25T11:59:00.000Z",
        failingMs: 0,
        failingTicks: 0,
        contextOpens: ["2026-07-25T11:58:00.000Z"],
        breakerOpen: true,
        records: [
          { at: "2026-07-25T11:58:00.000Z", platform: "kick" as const, kind: "context_open" as const, code: "background_rejected" },
        ],
      },
    },
  },
  events: [],
};

describe("failure report", () => {
  it("includes environment, reason and the failure records", () => {
    const report = buildFailureReport(INPUT);

    expect(report).toContain("1.11.0");
    expect(report).toContain("page_context_churn");
    expect(report).toContain("background_rejected");
    expect(report).toContain("Mozilla/5.0");
  });

  it("stays useful when the ring buffer is empty", () => {
    const report = buildFailureReport({
      ...INPUT,
      state: {
        ...INPUT.state,
        criticalHealth: { kick: { ...INPUT.state.criticalHealth.kick, records: [] } },
      },
    });

    expect(report).toContain("page_context_churn");
    expect(report).toContain("_none recorded_");
  });

  it("never leaks credentials from settings", () => {
    const report = buildFailureReport(INPUT);

    expect(report).not.toMatch(/authToken|sessionToken|cookie/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- failureReport.test.ts`
Expected: FAIL, cannot resolve `@lurkloot/shared/failureReport`.

- [ ] **Step 3: Write the builder**

Create `packages/shared/src/failureReport.ts`:

```ts
import type { CriticalHealthState } from "./criticalHealth";
import type { ActivityHistoryRecord } from "./events";
import type { EngineSettings, Platform, SchedulerState } from "./models";

export interface FailureReportInput {
  platform: Platform;
  version: string;
  userAgent: string;
  locale: string;
  at: string;
  settings: EngineSettings;
  state: SchedulerState;
  events: readonly ActivityHistoryRecord[];
}

const EVENT_LIMIT = 40;

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

function bullets(entries: readonly [string, unknown][]): string {
  return entries.map(([label, value]) => `- **${label}:** ${value ?? "—"}`).join("\n");
}

function healthSummary(health: CriticalHealthState | undefined): string {
  if (!health) return "_no detector state_";
  return bullets([
    ["status", health.status],
    ["reason", health.reason],
    ["flagged at", health.flaggedAt],
    ["failing time (ms)", health.failingMs],
    ["failing ticks", health.failingTicks],
    ["last watched minutes", health.lastWatchedMinutes],
    ["page context opens in window", health.contextOpens.length],
    ["breaker open", health.breakerOpen],
    ["cooldown until", health.cooldownUntil],
  ]);
}

function records(health: CriticalHealthState | undefined): string {
  if (!health || health.records.length === 0) return "_none recorded_";
  return health.records
    .map((record) => `- \`${record.at}\` ${record.platform} ${record.kind}${record.code ? ` ${record.code}` : ""}${record.status ? ` (${record.status})` : ""}${record.detail ? ` — ${record.detail}` : ""}`)
    .join("\n");
}

function events(entries: readonly ActivityHistoryRecord[]): string {
  if (entries.length === 0) return "_none recorded_";
  return entries
    .slice(-EVENT_LIMIT)
    .map((entry) => {
      const label = "legacy" in entry || entry.category === "diagnostic" ? entry.message : entry.code;
      return `- \`${entry.at}\` [${entry.level}] ${label}`;
    })
    .join("\n");
}

// Farming-relevant settings only, all booleans and enums. Channel lists,
// credentials and anything free-form are deliberately excluded.
function settingsSummary(settings: EngineSettings, platform: Platform): string {
  return bullets([
    ["running", settings.running],
    ["tablessMode", settings.tablessMode],
    ["autoClaim", settings.autoClaim],
    ["pauseOnManualWatch", settings.pauseOnManualWatch],
    ["priorityMode", settings.priorityMode],
    ["platform enabled", settings.platform[platform].enabled],
    ["farmAllCategories", settings.platform[platform].farmAllCategories],
    ["compatibility profile", settings.compatibility[platform].profile],
    ["criticalFailurePromptEnabled", settings.criticalFailurePromptEnabled],
  ]);
}

export function buildFailureReport(input: FailureReportInput): string {
  const health = input.state.criticalHealth?.[input.platform];
  const session = input.state.sessions[input.platform];
  const auth = input.state.authHealth[input.platform];

  return [
    "# Lurkloot critical failure report",
    "",
    section("Environment", bullets([
      ["version", input.version],
      ["platform", input.platform],
      ["locale", input.locale],
      ["reported at", input.at],
      ["user agent", input.userAgent],
    ])),
    section("Detector", healthSummary(health)),
    section("Session", bullets([
      ["status", session.status],
      ["reason code", session.reasonCode],
      ["watch mode", session.watchMode],
      ["tabless fallback", session.tablessFallback],
      ["last heartbeat ok", session.lastHeartbeatOk],
      ["error checks", session.errorChecks],
      ["retry after", session.retryAfter],
      ["auth status", auth.status],
      ["auth reason", auth.reasonCode],
    ])),
    section("Settings", settingsSummary(input.settings, input.platform)),
    section("Failure records", records(health)),
    section("Recent events", events(input.events)),
  ].join("\n");
}
```

If any referenced `WatchSession` field name differs, use the real name from `packages/shared/src/models.ts` — the shape is authoritative there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- failureReport.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/failureReport.ts packages/extension/tests/failureReport.test.ts
git commit -m "feat(shared): add critical failure report builder"
```

---

### Task 9: The popup panel

**Files:**
- Create: `packages/popup-ui/src/criticalFailure.tsx`
- Modify: `packages/popup-ui/src/constants.ts`
- Test: `packages/extension/tests/criticalFailureView.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/criticalFailureView.test.tsx`, following the render/i18n harness used by `packages/extension/tests/popupAuthHealth.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CriticalFailurePanel } from "@lurkloot/popup-ui/criticalFailure";

function renderPanel(overrides?: Partial<Parameters<typeof CriticalFailurePanel>[0]>) {
  const props = {
    platform: "kick" as const,
    reason: "page_context_churn" as const,
    buildReport: () => "REPORT BODY",
    onDismiss: vi.fn(),
    openLink: vi.fn(),
    writeClipboard: vi.fn(async () => true),
    ...overrides,
  };
  render(<CriticalFailurePanel {...props} />);
  return props;
}

describe("critical failure panel", () => {
  it("copies the report and opens a prefilled issue", async () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /copy logs/i }));
    await vi.waitFor(() => expect(props.writeClipboard).toHaveBeenCalledWith("REPORT BODY"));

    const opened = (props.openLink as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(opened).toContain("https://github.com/jamezrin/lurkloot/issues/new");
    expect(opened).toContain("title=");
  });

  it("does not open an issue when the clipboard write fails", async () => {
    const props = renderPanel({ writeClipboard: vi.fn(async () => false) });

    fireEvent.click(screen.getByRole("button", { name: /copy logs/i }));

    await vi.waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("REPORT BODY"));
    expect(props.openLink).not.toHaveBeenCalled();
  });

  it("dismisses on request", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- criticalFailureView.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the panel**

Create `packages/popup-ui/src/criticalFailure.tsx`:

```tsx
import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";
import type { Platform } from "@lurkloot/shared/models";
import { GITHUB_NEW_ISSUE_URL_BASE } from "./constants";
import { openHttpsLink } from "./links";
import { useI18n } from "./context";
import { cn } from "./primitives";

export interface CriticalFailurePanelProps {
  platform: Platform;
  reason: CriticalFailureReason;
  buildReport: () => string;
  onDismiss: () => void;
  openLink: (url: string) => void;
  writeClipboard: (text: string) => Promise<boolean>;
}

function issueUrl(platform: Platform, reason: CriticalFailureReason): string {
  const title = `Critical failure: ${reason} on ${platform}`;
  const body = "<!-- Paste the copied report below. -->\n\n";
  return `${GITHUB_NEW_ISSUE_URL_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function CriticalFailurePanel({
  platform,
  reason,
  buildReport,
  onDismiss,
  openLink,
  writeClipboard,
}: CriticalFailurePanelProps): React.ReactElement {
  const { t } = useI18n();
  const [fallbackReport, setFallbackReport] = useState<string | null>(null);

  async function copyAndOpen(): Promise<void> {
    const report = buildReport();
    // The clipboard write must happen inside the click gesture, and the issue is
    // only opened once it succeeds — sending the user to a blank issue form with
    // an empty clipboard is worse than showing them the text to copy by hand.
    if (await writeClipboard(report)) {
      setFallbackReport(null);
      openHttpsLink(issueUrl(platform, reason), openLink);
      return;
    }
    setFallbackReport(report);
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950/40">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <div className="space-y-1">
          <p className="font-semibold text-red-900 dark:text-red-200">{t("criticalFailureTitle")}</p>
          <p className="text-red-800 dark:text-red-300">
            {t(reason === "page_context_churn" ? "criticalFailureBodyPageContextChurn" : "criticalFailureBodyNoProgress")}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyAndOpen()}
          className={cn("rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700")}
        >
          {t("criticalFailureCopyAndReport")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className={cn("rounded-full border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-800 transition hover:bg-red-100 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/40")}
        >
          {t("criticalFailureDismiss")}
        </button>
      </div>
      {fallbackReport ? (
        <div className="mt-3 space-y-1">
          <p className="text-xs text-red-800 dark:text-red-300">{t("criticalFailureClipboardFallback")}</p>
          <textarea
            readOnly
            value={fallbackReport}
            onFocus={(event) => event.currentTarget.select()}
            className="h-32 w-full rounded-lg border border-red-200 bg-white p-2 font-mono text-[10px] dark:border-red-900 dark:bg-zinc-900"
          />
        </div>
      ) : null}
    </div>
  );
}
```

Use whatever hook the popup already provides for translations — if `useI18n` is not the existing name, use the real one from `packages/popup-ui/src/context.tsx` and match how sibling components such as `updateNotice.tsx` consume it.

- [ ] **Step 4: Add the URL base constant**

In `packages/popup-ui/src/constants.ts`, next to `GITHUB_NEW_ISSUE_URL`:

```ts
// The chooser URL cannot carry a prefilled title/body; the critical failure
// prompt targets the raw new-issue form instead.
export const GITHUB_NEW_ISSUE_URL_BASE = "https://github.com/jamezrin/lurkloot/issues/new";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- criticalFailureView.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/popup-ui/src/criticalFailure.tsx packages/popup-ui/src/constants.ts packages/extension/tests/criticalFailureView.test.tsx
git commit -m "feat(popup): add critical failure panel"
```

---

### Task 10: Wire the panel into the popup

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx:622`, `packages/popup-ui/src/types.ts:113`, `packages/shared/src/messages.ts:21`, `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/criticalFailureView.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/criticalFailureView.test.tsx`, using the same `Popup` render harness as `packages/extension/tests/dropsView.test.tsx`:

```tsx
  it("replaces the drops list for the flagged platform only", async () => {
    const snapshot = snapshotWithCampaigns();
    snapshot.state.criticalHealth = {
      kick: {
        status: "flagged",
        reason: "page_context_churn",
        flaggedAt: "2026-07-25T11:59:00.000Z",
        failingMs: 0,
        failingTicks: 0,
        contextOpens: [],
        breakerOpen: true,
        records: [],
      },
    };

    renderPopup(snapshot, { platform: "kick" });

    expect(await screen.findByRole("button", { name: /copy logs/i })).toBeInTheDocument();
    expect(screen.queryByTestId("drops-panel")).not.toBeInTheDocument();
  });
```

`snapshotWithCampaigns` and `renderPopup` are names for that file's existing helpers — reuse them rather than writing new ones, and use whatever selector that suite already uses to assert the drops list is present.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- criticalFailureView.test.tsx`
Expected: FAIL — the drops panel still renders.

- [ ] **Step 3: Add the dismiss runtime message**

In `packages/shared/src/messages.ts`, extend the `RuntimeMessage` union:

```ts
  | { type: "dismissCriticalFailure"; platform: Platform }
```

In `packages/core/src/background/controller.ts`, handle it alongside the other message cases:

```ts
    case "dismissCriticalFailure": {
      const transition = dismissCriticalFailure(state, message.platform, Date.now());
      state = transition.state;
      if (transition.event) emit(transition.event);
      syncPageContextBreakers(state);
      await persistState(state);
      return snapshot();
    }
```

using the controller's own names for `persistState`/`snapshot`/`emit`, and importing `dismissCriticalFailure` from `../core/criticalHealth` and `syncPageContextBreakers` from `../core/tabs`.

- [ ] **Step 4: Add the clipboard adapter hook**

In `packages/popup-ui/src/types.ts`, add to `interface PopupAdapter`:

```ts
  // Optional: write text to the system clipboard, returning whether it worked.
  // The demo host omits it, which makes the failure panel fall back to a
  // selectable textarea instead of pretending the copy succeeded.
  writeClipboard?(text: string): Promise<boolean>;
```

In the extension's popup adapter (`packages/extension/entrypoints/popup/`), implement it:

```ts
  async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
```

- [ ] **Step 5: Render the panel**

In `packages/popup-ui/src/Popup.tsx`, add the imports:

```ts
import { CriticalFailurePanel } from "./criticalFailure";
import { buildFailureReport } from "@lurkloot/shared/failureReport";
```

derive the flag near the other snapshot-derived values:

```ts
  const criticalFailure = snapshot?.state.criticalHealth?.[platform];
  const criticalFailureActive = settings.criticalFailurePromptEnabled && criticalFailure?.status === "flagged";
```

and wrap the drops branch at line 622 so the panel takes its place:

```tsx
                    {tab === "drops" ? (
                      criticalFailureActive && criticalFailure?.reason ? (
                        <CriticalFailurePanel
                          platform={platform}
                          reason={criticalFailure.reason}
                          buildReport={() => buildFailureReport({
                            platform,
                            version: adapter.version,
                            userAgent: adapter.getUiLanguage ? navigator.userAgent : "unknown",
                            locale,
                            at: new Date().toISOString(),
                            settings,
                            state: snapshot!.state,
                            events: activityStream.events,
                          })}
                          onDismiss={() => void adapter.send({ type: "dismissCriticalFailure", platform }).then(() => refreshNow())}
                          openLink={adapter.openLink}
                          writeClipboard={adapter.writeClipboard ?? (async () => false)}
                        />
                      ) : (
                        <DropsPanel
```

closing the extra parenthesis after the existing `DropsPanel` element. Use `activityStream`'s real event array property name from `activity.logic.ts`, and `refreshNow` as it is already defined in `Popup.tsx`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- criticalFailureView.test.tsx dropsView.test.tsx popupSettingsLifecycle.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/popup-ui/src packages/shared/src/messages.ts packages/core/src/background/controller.ts packages/extension/entrypoints packages/extension/tests/criticalFailureView.test.tsx
git commit -m "feat(popup): show the critical failure panel in place of drops"
```

---

### Task 11: Localization

**Files:**
- Modify: all ten catalogs in `packages/locales/messages/`
- Test: `packages/extension/tests/i18n.test.ts`

- [ ] **Step 1: Confirm the key set**

The full set of new keys, with their English values:

```json
  "criticalFailureTitle": { "message": "Lurkloot has stopped working" },
  "criticalFailureBodyNoProgress": { "message": "Repeated errors and no drop progress for a long time. Something on this platform likely changed and the extension can no longer earn drops." },
  "criticalFailureBodyPageContextChurn": { "message": "A background tab kept reopening over and over. Reopening has been stopped so you can use your browser normally." },
  "criticalFailureCopyAndReport": { "message": "Copy logs & open issue" },
  "criticalFailureDismiss": { "message": "Dismiss and try again" },
  "criticalFailureClipboardFallback": { "message": "Could not copy automatically. Select and copy this, then open an issue." },
  "activityCriticalFailureDetected": { "message": "$1 is not working: $2." },
  "activityCriticalFailureCleared": { "message": "$1 critical failure dismissed; retrying." },
  "criticalFailureReasonNoProgress": { "message": "no progress despite repeated errors" },
  "criticalFailureReasonPageContextChurn": { "message": "a tab kept reopening" }
```

The last four were added to `en.json` in Task 2; add the first six there now, and all ten to every other catalog.

- [ ] **Step 2: Run the i18n test to see the gap**

Run: `pnpm test -- i18n.test.ts`
Expected: FAIL if that suite asserts key parity across catalogs; if it does not, run `node -e` to diff the key sets manually:

```bash
node -e 'const fs=require("fs");const en=Object.keys(JSON.parse(fs.readFileSync("packages/locales/messages/en.json")));for(const f of fs.readdirSync("packages/locales/messages")){const k=new Set(Object.keys(JSON.parse(fs.readFileSync("packages/locales/messages/"+f))));const missing=en.filter(x=>!k.has(x));if(missing.length)console.log(f,missing.join(","));}'
```

- [ ] **Step 3: Translate into all catalogs**

Add all ten keys to `es`, `fr`, `it`, `ru`, `de`, `hi`, `pt_BR`, `ar`, `tr`. Translate the copy properly — do not paste English. Keep the `$1`/`$2` placeholders in the same order and preserve the same message keys. `ar` is RTL; write natural Arabic, and do not add directional marks the other strings in that file do not use.

- [ ] **Step 4: Verify parity**

Run the `node -e` command from Step 2 again.
Expected: no output — every catalog has every key.

Run: `pnpm test -- i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/locales/messages
git commit -m "feat(locales): localize the critical failure prompt"
```

---

### Task 12: Full verification

**Files:** none

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: PASS, no failures.

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full check**

Run: `pnpm check`
Expected: script tests, workspace typechecks, extension tests and the Astro site build all pass. The site imports the real popup UI, so a broken `Popup.tsx` fails here.

- [ ] **Step 4: Build both browsers**

Run: `pnpm verify`
Expected: `pnpm check` plus Chromium and Firefox builds succeed.

- [ ] **Step 5: Manual smoke test**

Run `pnpm dev`, load the extension, and force the page-context churn path (for example by repeatedly closing the Kick managed tab). Confirm the panel replaces the drops list for Kick only, that Twitch is unaffected, that the tab stops reopening, that the copy button copies a readable report and opens a prefilled issue, and that dismissing restores the drops list.

- [ ] **Step 6: Commit any fixes and push**

```bash
git add -A
git commit -m "test: verify critical failure prompt end to end"
git push -u origin feat/critical-failure-prompt
```

---

## Self-review notes

Spec coverage checked section by section: detection triggers (Tasks 3, 6, 7), state and persistence (Tasks 1, 4), always-on ring buffer (Tasks 1, 3), dismissal and cooldown (Tasks 3, 10), popup UI and clipboard fallback (Tasks 9, 10), report builder (Task 8), settings kill switch (Task 5), localization (Tasks 2, 11), testing (every task plus Task 12).

Known integration risk: Task 6 touches `scheduler.ts`, a 1135-line file with several `continue` paths through the per-platform loop. The observation must be applied at every exit point — hence the `applyObservation()` closure. If that file proves hard to thread cleanly, extracting the per-platform body into its own function is a reasonable in-scope improvement.

Names used consistently throughout: `CriticalHealthState`, `FailureRecord`, `CriticalFailureReason`, `observeCriticalHealth`, `recordPageContextOpen`, `dismissCriticalFailure`, `isPageContextBreakerOpen`, `syncPageContextBreakers`, `pageContextBreakerOpen`, `buildFailureReport`, `CriticalFailurePanel`, `criticalFailurePromptEnabled`.
