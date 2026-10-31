import { describe, expect, it } from "vitest";
import type { StoredEngineEvent } from "@lurkloot/shared/events";
import { type FarmingSessionSummary, foldSessionEvent } from "@lurkloot/shared/farmingSessions";

let sequence = 0;
// Typed loosely: Omit over the event union would drop the session stamp.
function stored(event: Record<string, unknown>, at = "2026-10-30T10:00:00.000Z") {
  sequence += 1;
  return { ...event, id: `e${sequence}`, at } as StoredEngineEvent;
}

const started = stored({
  category: "activity",
  code: "session_started",
  level: "info",
  platform: "twitch",
  sessionId: "s1",
  data: { sessionId: "s1", startedAt: "2026-10-30T10:00:00.000Z" },
});

function gain(reason: string, amount: number, sessionId: string | null = "s1", login?: string) {
  return stored({
    category: "activity",
    code: "points_earned",
    level: "info",
    platform: "twitch",
    sessionId,
    data: { channelId: "1", reason, amount, ...(login ? { channelLogin: login } : {}) },
  });
}

const drop = stored({
  category: "activity",
  code: "reward_claimed",
  level: "info",
  platform: "twitch",
  sessionId: "s1",
  data: { campaignId: "c", campaignName: "C", rewardId: "r", rewardName: "R", method: "automatic" },
});

const ended = stored(
  {
    category: "activity",
    code: "session_ended",
    level: "info",
    platform: "twitch",
    sessionId: "s1",
    data: {
      sessionId: "s1",
      startedAt: "2026-10-30T10:00:00.000Z",
      endedAt: "2026-10-30T12:00:00.000Z",
      reason: "disabled",
    },
  },
  "2026-10-30T12:00:00.000Z",
);

function fold(events: StoredEngineEvent[]): FarmingSessionSummary | undefined {
  return events.reduce<FarmingSessionSummary | undefined>(foldSessionEvent, undefined);
}

describe("farming session fold", () => {
  it("sums points per channel and reason, counts rewards and records the end", () => {
    const summary = fold([
      started,
      gain("WATCH", 50),
      gain("CLAIM", 50, "s1", "shroud"),
      gain("WATCH_STREAK", 450),
      drop,
      ended,
    ]);

    expect(summary).toEqual({
      id: "s1",
      platform: "twitch",
      startedAt: "2026-10-30T10:00:00.000Z",
      endedAt: "2026-10-30T12:00:00.000Z",
      tallies: {
        "channel_points:1": {
          kind: "channel_points",
          subject: { id: "1", login: "shroud" },
          total: 550,
          breakdown: {
            WATCH: { count: 1, amount: 50 },
            CLAIM: { count: 1, amount: 50 },
            WATCH_STREAK: { count: 1, amount: 450 },
          },
        },
      },
      rewardCounts: { drop: 1 },
    });
  });

  it("leaves a summary unchanged for an event outside any session", () => {
    const summary = fold([started]);
    expect(foldSessionEvent(summary, gain("WATCH", 50, null))).toBe(summary);
  });

  it("never mutates the summary it is given", () => {
    const summary = Object.freeze(fold([started, gain("WATCH", 50)])!);
    expect(() => foldSessionEvent(summary, gain("WATCH", 10))).not.toThrow();
    expect(summary.tallies["channel_points:1"]!.total).toBe(50);
  });

  it("starts a summary from a stamped event that arrives before its session_started", () => {
    expect(fold([gain("WATCH", 20)])).toMatchObject({
      id: "s1",
      platform: "twitch",
      startedAt: "2026-10-30T10:00:00.000Z",
      tallies: { "channel_points:1": { total: 20 } },
    });
  });
});
