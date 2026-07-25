import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_HEALTH, normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import {
  FAILING_WINDOW_MS,
  MAX_TICK_DELTA_MS,
  MIN_FAILING_TICKS,
  dismissCriticalFailure,
  observeCriticalHealth,
  TAB_CHURN_LIMIT,
  TAB_CHURN_WINDOW_MS,
  recordManagedTabOpen,
} from "@lurkloot/core/criticalHealth";
import type { SchedulerState } from "@lurkloot/shared/models";

const START = Date.parse("2026-07-25T10:00:00.000Z");

const PAGE_CONTEXT = { source: "page_context", reason: "background_rejected" } as const;
const WATCH_TAB = { source: "watch_tab" } as const;

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

describe("critical health normalization", () => {
  it("defaults to an unflagged, closed-breaker state", () => {
    expect(DEFAULT_CRITICAL_HEALTH).toEqual({
      status: "ok",
      failingMs: 0,
      failingTicks: 0,
      managedTabOpens: [],
      breakerOpen: false,
      records: [],
    });
  });

  it("freezes the default so platforms cannot share a mutated singleton", () => {
    expect(Object.isFrozen(DEFAULT_CRITICAL_HEALTH)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CRITICAL_HEALTH.managedTabOpens)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CRITICAL_HEALTH.records)).toBe(true);
  });

  it("restores a persisted flag while discarding malformed counters", () => {
    const restored = normalizeCriticalHealth({
      status: "flagged",
      reason: "page_context_churn",
      flaggedAt: "2026-07-25T10:00:00.000Z",
      failingMs: "nonsense",
      failingTicks: -4,
      managedTabOpens: ["2026-07-25T09:59:00.000Z", 42],
      breakerOpen: true,
      records: [{ at: "2026-07-25T09:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" }],
    });

    expect(restored.status).toBe("flagged");
    expect(restored.reason).toBe("page_context_churn");
    expect(restored.breakerOpen).toBe(true);
    expect(restored.failingMs).toBe(0);
    expect(restored.failingTicks).toBe(0);
    expect(restored.managedTabOpens).toEqual([]);
    expect(restored.records).toHaveLength(1);
  });

  it("drops an unknown status and every malformed record", () => {
    const restored = normalizeCriticalHealth({ status: "exploded", records: [{ kind: "api_error" }, "junk"] });

    expect(restored.status).toBe("ok");
    expect(restored.records).toEqual([]);
  });
});

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

  it("does not flag on too few ticks even when the clock runs far past the window", () => {
    let state = baseState();
    for (let index = 0; index < MIN_FAILING_TICKS - 1; index += 1) {
      state = observeCriticalHealth(state, "twitch", {
        at: START + index * 4 * FAILING_WINDOW_MS,
        failing: true,
        progressed: false,
        preconditionBroke: false,
      }).state;
    }

    expect(state.criticalHealth?.twitch?.failingTicks).toBeLessThan(MIN_FAILING_TICKS);
    expect(state.criticalHealth?.twitch?.status).toBe("ok");
  });

  it("flags on the exact tick the window closes, not before", () => {
    // Ticks arrive at the clamp ceiling, the fastest the window can legally close.
    const tickMs = MAX_TICK_DELTA_MS;
    // The first tick charges no time, so the window closes one tick after the quotient.
    const expected = FAILING_WINDOW_MS / tickMs + 1;
    let state = baseState();
    let flaggedOn: number | undefined;
    let statusBeforeFlag: string | undefined;
    for (let index = 0; index < expected; index += 1) {
      const before = state.criticalHealth?.twitch?.status ?? "ok";
      const transition = observeCriticalHealth(state, "twitch", {
        at: START + index * tickMs,
        failing: true,
        progressed: false,
        preconditionBroke: false,
      });
      state = transition.state;
      if (transition.event && flaggedOn === undefined) {
        flaggedOn = index + 1;
        statusBeforeFlag = before;
      }
    }

    expect(flaggedOn).toBe(expected);
    expect(statusBeforeFlag).toBe("ok");
    expect(state.criticalHealth?.twitch?.status).toBe("flagged");
    // The clamp makes the tick floor a consequence of the window, never the binding constraint.
    expect(state.criticalHealth?.twitch?.failingTicks).toBeGreaterThanOrEqual(MIN_FAILING_TICKS);
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
    expect(state.criticalHealth?.twitch?.failingMs).toBe(MAX_TICK_DELTA_MS);
  });

  it("flags page-context churn immediately and opens the breaker", () => {
    let state = baseState();
    let flagged: string | undefined;
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      const transition = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, PAGE_CONTEXT);
      state = transition.state;
      if (transition.event?.code === "critical_failure_detected") flagged = transition.event.data.reason;
    }

    expect(flagged).toBe("page_context_churn");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(state.criticalHealth?.twitch?.status ?? "ok").toBe("ok");
  });

  it("does not flag opens spread beyond the churn window", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT + 2; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * (TAB_CHURN_WINDOW_MS / 2), PAGE_CONTEXT).state;
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(false);
  });

  it("dismissal resets counters, closes the breaker and starts a cooldown", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, PAGE_CONTEXT).state;
    }

    const dismissed = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000);

    expect(dismissed.event?.code).toBe("critical_failure_cleared");
    expect(dismissed.state.criticalHealth?.kick?.status).toBe("ok");
    expect(dismissed.state.criticalHealth?.kick?.breakerOpen).toBe(false);
    expect(dismissed.state.criticalHealth?.kick?.managedTabOpens).toEqual([]);
    expect(Date.parse(dismissed.state.criticalHealth?.kick?.cooldownUntil ?? "")).toBeGreaterThan(START + 10 * 60 * 1000);
  });

  it("refuses to re-flag during the cooldown", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, PAGE_CONTEXT).state;
    }
    state = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000).state;
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + 11 * 60 * 1000 + index * 1000, PAGE_CONTEXT).state;
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
  });

  it("opens the breaker on churn even when already flagged for another reason", () => {
    const ticks = Math.ceil(FAILING_WINDOW_MS / (5 * 60 * 1000)) + 2;
    let state = runFailingTicks(baseState(), ticks);
    expect(state.criticalHealth?.twitch?.reason).toBe("no_progress");

    const events: string[] = [];
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      const transition = recordManagedTabOpen(state, "twitch", START + (ticks + index) * 60 * 1000, WATCH_TAB);
      state = transition.state;
      if (transition.event) events.push(transition.event.code);
    }

    expect(state.criticalHealth?.twitch?.breakerOpen).toBe(true);
    expect(state.criticalHealth?.twitch?.reason).toBe("no_progress");
    expect(events).toEqual([]);
  });

  it("opens the breaker on churn during a post-dismissal cooldown", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, PAGE_CONTEXT).state;
    }
    state = dismissCriticalFailure(state, "kick", START + 10 * 60 * 1000).state;
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(false);

    const events: string[] = [];
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      const transition = recordManagedTabOpen(state, "kick", START + 11 * 60 * 1000 + index * 1000, PAGE_CONTEXT);
      state = transition.state;
      if (transition.event) events.push(transition.event.code);
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(events).toEqual([]);
  });

  it("flags watch-tab churn on its own", () => {
    let state = baseState();
    let flagged: string | undefined;
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      const transition = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, WATCH_TAB);
      state = transition.state;
      if (transition.event?.code === "critical_failure_detected") flagged = transition.event.data.reason;
    }

    expect(flagged).toBe("page_context_churn");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(state.criticalHealth?.kick?.records.map((record) => record.kind)).toEqual(
      Array.from({ length: TAB_CHURN_LIMIT }, () => "watch_tab_open"),
    );
  });

  it("counts both tab kinds against one shared churn window", () => {
    let state = baseState();
    const events: string[] = [];
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      // Alternate the sources so neither kind reaches the limit on its own.
      const open = index % 2 === 0 ? WATCH_TAB : PAGE_CONTEXT;
      const transition = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, open);
      state = transition.state;
      if (transition.event) events.push(transition.event.code);
    }

    expect(events).toEqual(["critical_failure_detected"]);
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(state.criticalHealth?.kick?.managedTabOpens).toHaveLength(TAB_CHURN_LIMIT);
  });

  it("does not flag watch-tab opens spread beyond the churn window", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT + 2; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * (TAB_CHURN_WINDOW_MS / 2), WATCH_TAB).state;
    }

    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(false);
  });

  it("keeps the breaker open on further opens inside the window", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, WATCH_TAB).state;
    }
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);

    state = recordManagedTabOpen(state, "kick", START + (TAB_CHURN_LIMIT + 1) * 60 * 1000, WATCH_TAB).state;

    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
  });

  it("does not close the breaker on an isolated open below the threshold", () => {
    let state = baseState();
    // Cooldown first, so the storm opens the breaker without flagging it.
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 1000, PAGE_CONTEXT).state;
    }
    state = dismissCriticalFailure(state, "kick", START + 60 * 1000).state;
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + 61 * 1000 + index * 1000, WATCH_TAB).state;
    }
    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);

    // A lone open long after the others: below the threshold, but recording never releases.
    state = recordManagedTabOpen(state, "kick", START + 61 * 1000 + TAB_CHURN_WINDOW_MS + 5000, WATCH_TAB).state;

    expect(state.criticalHealth?.kick?.managedTabOpens).toHaveLength(1);
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
  });

  it("counts an open landing exactly on the window boundary", () => {
    let state = baseState();
    state = recordManagedTabOpen(state, "kick", START, WATCH_TAB).state;
    for (let index = 1; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + TAB_CHURN_WINDOW_MS, WATCH_TAB).state;
    }

    // The oldest open sits at exactly TAB_CHURN_WINDOW_MS, which the window includes.
    expect(state.criticalHealth?.kick?.managedTabOpens).toHaveLength(TAB_CHURN_LIMIT);
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);
  });

  it("closes the breaker once the churn evidence ages out, without a prompt", () => {
    let state = baseState();
    // Inside a post-dismissal cooldown, so the storm opens the breaker without flagging.
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, PAGE_CONTEXT).state;
    }
    state = dismissCriticalFailure(state, "kick", START + 6 * 60 * 1000).state;
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + 7 * 60 * 1000 + index * 1000, WATCH_TAB).state;
    }
    expect(state.criticalHealth?.kick?.status).toBe("ok");
    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);

    // A tick while the storm is still live must not release it.
    const during = observeCriticalHealth(state, "kick", {
      at: START + 8 * 60 * 1000,
      failing: false,
      progressed: false,
      preconditionBroke: false,
    }).state;
    expect(during.criticalHealth?.kick?.breakerOpen).toBe(true);

    const after = observeCriticalHealth(during, "kick", {
      // Past the newest open (START + 7min + 4s) by more than a full window.
      at: START + 7 * 60 * 1000 + TAB_CHURN_LIMIT * 1000 + TAB_CHURN_WINDOW_MS,
      failing: false,
      progressed: false,
      preconditionBroke: false,
    }).state;

    expect(after.criticalHealth?.kick?.breakerOpen).toBe(false);
    expect(after.criticalHealth?.kick?.managedTabOpens).toEqual([]);
    expect(after.criticalHealth?.kick?.status).toBe("ok");
  });

  it("keeps a flagged platform's breaker open even after the evidence ages out", () => {
    let state = baseState();
    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      state = recordManagedTabOpen(state, "kick", START + index * 60 * 1000, WATCH_TAB).state;
    }
    expect(state.criticalHealth?.kick?.status).toBe("flagged");

    state = observeCriticalHealth(state, "kick", {
      at: START + 2 * TAB_CHURN_WINDOW_MS,
      failing: false,
      progressed: false,
      preconditionBroke: false,
    }).state;

    expect(state.criticalHealth?.kick?.breakerOpen).toBe(true);

    const dismissed = dismissCriticalFailure(state, "kick", START + 3 * TAB_CHURN_WINDOW_MS).state;
    expect(dismissed.criticalHealth?.kick?.breakerOpen).toBe(false);
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
          managedTabOpens: ["2026-07-25T09:59:00.000Z"],
          records: [{ at: "2026-07-25T09:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" }],
        },
      },
    });

    expect(merged.criticalHealth?.kick?.status).toBe("flagged");
    expect(merged.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(merged.criticalHealth?.kick?.failingMs).toBe(0);
    expect(merged.criticalHealth?.kick?.managedTabOpens).toEqual([]);
    expect(merged.criticalHealth?.kick?.records).toHaveLength(1);
  });

  it("omits the block entirely when nothing was persisted", () => {
    expect(mergeSchedulerState({}).criticalHealth).toBeUndefined();
  });

  it("omits the block when the persisted map is an empty object", () => {
    expect(mergeSchedulerState({ criticalHealth: {} }).criticalHealth).toBeUndefined();
  });

  it("keeps each platform independent", () => {
    const merged = mergeSchedulerState({
      criticalHealth: {
        kick: { status: "flagged", reason: "page_context_churn", breakerOpen: true, records: [] },
      },
    } as unknown as Partial<SchedulerState>);

    expect(merged.criticalHealth?.kick?.status).toBe("flagged");
    expect(merged.criticalHealth?.twitch).toBeUndefined();
  });

  it("discards a malformed platform block", () => {
    const merged = mergeSchedulerState({ criticalHealth: { kick: "not an object" } } as unknown as Partial<SchedulerState>);

    expect(merged.criticalHealth?.kick?.status).toBe("ok");
  });
});
