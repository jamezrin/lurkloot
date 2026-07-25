import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_HEALTH, normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";
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
