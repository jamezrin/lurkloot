// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchStreakAttempt, WatchStreakState } from "@lurkloot/shared/models";
import {
  channelStreakRun,
  localDayKey,
  mergeWatchStreakHistory,
  pruneWatchStreakHistory,
  shiftDayKey,
  summarizeWatchStreakHistory,
  WATCH_STREAK_HISTORY_DAYS,
  type WatchStreakHistory,
} from "@lurkloot/shared/watchStreakHistory";
import {
  mergeWatchStreakState,
  normalizeWatchStreakState,
  pruneWatchStreaks,
  WATCH_STREAK_RETENTION_MS,
} from "@lurkloot/core/watchStreaks";
import { I18nContext } from "../../popup-ui/src/context";
import { WatchStreakHistoryCard } from "../../popup-ui/src/watchStreakHistory";
import type { TFunction } from "../../popup-ui/src/types";

const NOW = new Date(2026, 10, 27, 15, 0).getTime();
const TODAY = localDayKey(NOW);
const day = (offset: number) => shiftDayKey(TODAY, offset);

function attempt(overrides: Partial<WatchStreakAttempt>): WatchStreakAttempt {
  const at = new Date(NOW - 60 * 60_000).toISOString();
  return {
    accountId: "1",
    channelId: "100",
    broadcastId: "b1",
    username: "alpha",
    outcome: "credited",
    watchedMs: 0,
    unhealthyChecks: 0,
    failedRounds: 0,
    startedAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("watch-streak day history (#897)", () => {
  it("keys days by the local calendar, across a month end", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("folds finished attempts into the history and keeps them past attempt pruning", () => {
    const old = new Date(NOW - WATCH_STREAK_RETENTION_MS - 3_600_000).toISOString();
    const state: WatchStreakState = {
      attempts: [
        attempt({ startedAt: old, updatedAt: old, broadcastId: "old" }),
        attempt({ broadcastId: "missed", username: "beta", outcome: "not_confirmed" }),
        attempt({ broadcastId: "fail", username: "gamma", outcome: "playback_failed" }),
        attempt({ broadcastId: "open", username: "delta", outcome: "pending" }),
      ],
    };
    const pruned = pruneWatchStreaks(state, NOW);
    expect(pruned.attempts.map((entry) => entry.broadcastId)).toEqual(["missed", "fail", "open"]);
    expect(pruned.history).toEqual({
      alpha: { [localDayKey(Date.parse(old))]: "credited" },
      beta: { [TODAY]: "missed" },
      gamma: { [TODAY]: "missed" },
    });
  });

  it("never turns a credited day back into a miss", () => {
    const state: WatchStreakState = {
      attempts: [attempt({ broadcastId: "late", outcome: "not_confirmed" })],
      history: { alpha: { [TODAY]: "credited" } },
    };
    expect(pruneWatchStreaks(state, NOW).history).toEqual({ alpha: { [TODAY]: "credited" } });
    expect(
      mergeWatchStreakHistory({ alpha: { [TODAY]: "credited" } }, { alpha: { [TODAY]: "missed" } }),
    ).toEqual({ alpha: { [TODAY]: "credited" } });
  });

  it("keeps both sides' days when a tick's state merges with the stored one", () => {
    const merged = mergeWatchStreakState(
      { attempts: [], history: { alpha: { [day(-2)]: "credited" } } },
      { attempts: [], history: { beta: { [day(-1)]: "missed" } } },
    );
    expect(merged?.history).toEqual({
      alpha: { [day(-2)]: "credited" },
      beta: { [day(-1)]: "missed" },
    });
  });

  it("drops days past the window and channels left with none", () => {
    const history: WatchStreakHistory = {
      alpha: { [day(-WATCH_STREAK_HISTORY_DAYS)]: "credited", [day(-1)]: "credited" },
      beta: { [day(-WATCH_STREAK_HISTORY_DAYS - 5)]: "missed" },
    };
    expect(pruneWatchStreakHistory(history, NOW)).toEqual({ alpha: { [day(-1)]: "credited" } });
  });

  it("restores only well-formed history from storage", () => {
    const restored = normalizeWatchStreakState({
      attempts: [],
      history: {
        alpha: { [TODAY]: "credited", "2026-13-40": "credited", [day(-1)]: "won" },
        "Bad Name": { [TODAY]: "credited" },
        beta: "nope",
      },
    });
    expect(restored?.history).toEqual({ alpha: { [TODAY]: "credited" } });
  });

  it("counts a channel's run across offline days and flags a latest miss", () => {
    expect(
      channelStreakRun({ [day(-5)]: "credited", [day(-3)]: "credited", [day(-1)]: "credited" }),
    ).toEqual({ run: 3, atRisk: false });
    expect(
      channelStreakRun({ [day(-4)]: "missed", [day(-3)]: "credited", [day(-1)]: "credited" }),
    ).toEqual({ run: 2, atRisk: false });
    expect(
      channelStreakRun({ [day(-3)]: "credited", [day(-2)]: "credited", [day(-1)]: "missed" }),
    ).toEqual({ run: 2, atRisk: true });
    expect(channelStreakRun(undefined)).toEqual({ run: 0, atRisk: false });
  });

  it("summarizes totals and day runs, without today breaking the current run", () => {
    const summary = summarizeWatchStreakHistory(
      {
        alpha: {
          [day(-1)]: "credited",
          [day(-2)]: "credited",
          [day(-10)]: "credited",
          [day(-11)]: "credited",
          [day(-12)]: "credited",
        },
        beta: { [day(-1)]: "credited", [day(-5)]: "missed" },
      },
      NOW,
    );
    expect(summary.totalCredited).toBe(6);
    expect(summary.credited[day(-1)]).toBe(2);
    expect(summary.currentDayRun).toBe(2);
    expect(summary.bestDayRun).toBe(3);
    expect([...summary.missedOnly]).toEqual([day(-5)]);
  });
});

describe("watch-streak history card", () => {
  let root: Root | undefined;
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
  });

  const t: TFunction = (key, substitutions) => {
    const value = Array.isArray(substitutions) ? substitutions.join(", ") : substitutions;
    return value === undefined ? key : `${key}:${value}`;
  };

  function mount(history: WatchStreakHistory | undefined) {
    document.body.innerHTML = "<div id=app></div>";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.getElementById("app")!;
    act(() => {
      root = createRoot(container);
      root.render(
        <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>
          <WatchStreakHistoryCard
            history={history}
            channels={["alpha", "beta"]}
            statuses={{ alpha: "watching" }}
            now={NOW}
          />
        </I18nContext.Provider>,
      );
    });
    return container;
  }

  it("draws the heatmap, the stats and a strip per maintained channel", () => {
    const container = mount({
      alpha: { [day(-2)]: "credited", [day(-1)]: "credited" },
      beta: { [day(-3)]: "credited", [day(-1)]: "missed" },
    });
    const heatDays = container.querySelectorAll("[data-watch-streak-heatmap] [data-day]");
    // Every past day of the twelve weeks up to today, never a future one.
    expect(heatDays.length).toBeGreaterThan(77);
    expect(heatDays.length).toBeLessThanOrEqual(84);
    expect([...heatDays].at(-1)?.getAttribute("data-day")).toBe(TODAY);
    expect(
      container
        .querySelector(`[data-watch-streak-heatmap] [data-day="${day(-1)}"]`)
        ?.getAttribute("data-count"),
    ).toBe("1");
    expect(container.querySelector('[data-watch-streak-stat="total"] dd')?.textContent).toBe("3");

    const alpha = container.querySelector('[data-watch-streak-channel="alpha"]')!;
    expect(alpha.querySelectorAll("[data-day]")).toHaveLength(14);
    expect(alpha.querySelector(`[data-day="${TODAY}"]`)?.getAttribute("data-outcome")).toBe(
      "watching",
    );
    expect(
      alpha.querySelector("[data-watch-streak-run]")?.getAttribute("data-watch-streak-run"),
    ).toBe("2");
    const beta = container.querySelector('[data-watch-streak-channel="beta"]')!;
    expect(beta.querySelector(`[data-day="${day(-1)}"]`)?.getAttribute("data-outcome")).toBe(
      "missed",
    );
    expect(
      beta.querySelector("[data-watch-streak-run]")?.getAttribute("data-watch-streak-run"),
    ).toBe("1");
  });

  it("explains an empty history", () => {
    const container = mount(undefined);
    expect(container.textContent).toContain("watchStreakHistoryEmpty");
  });
});
