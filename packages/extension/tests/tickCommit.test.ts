import { describe, expect, it } from "vitest";
import type { DropCampaign, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { rebaseTickState, tickEffectFacts } from "@lurkloot/core/background/tickCommit";
import {
  dismissCriticalFailure,
  observeCriticalHealth,
  recordManagedTabOpen,
  recordRejectedManagedPageContext,
} from "@lurkloot/core/criticalHealth";
import { DEFAULT_STATE } from "../src/core/storage";

// The scheduler tick's commit (#599): a three-way merge of the state the tick
// read, the tick's result and what another writer stored meanwhile.

const watching: WatchSession = {
  platform: "twitch",
  status: "watching",
  offlineChecks: 0,
  channel: { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
  campaignId: "drops",
  rewardId: "reward",
  watchMode: "tab",
  tabId: 10,
  tabManagedByExtension: true,
  playbackChecks: 2,
};

const drops = (status: "in_progress" | "claimable" | "claimed"): DropCampaign => ({
  id: "drops",
  platform: "twitch",
  name: "Drops",
  status: "active",
  rewards: [
    {
      id: "reward",
      name: "Reward",
      requiredMinutes: 60,
      watchedMinutes: 60,
      status,
      claimId: "claim-1",
    },
  ],
});

const before: SchedulerState = {
  ...DEFAULT_STATE,
  authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
  sessions: { ...DEFAULT_STATE.sessions, twitch: watching },
  campaigns: { twitch: [drops("claimable")], kick: [] },
  managedWatchTabs: {
    twitch: {
      platform: "twitch",
      tabId: 10,
      channelUrl: "https://www.twitch.tv/creator",
      ownedByExtension: true,
    },
  },
};

const draft: SchedulerState = {
  ...before,
  sessions: {
    ...before.sessions,
    twitch: {
      ...watching,
      message: "Keeping current watch tab",
      lastCheckedAt: "2026-09-26T12:00:00.000Z",
    },
  },
};

const playing = {
  videoCount: 1,
  mutedVideoCount: 0,
  unmutedVideoCount: 1,
  playingVideoCount: 1,
  blockedPlaybackCount: 0,
  documentHidden: false,
  platform: "twitch" as const,
  checkedAt: "2026-09-26T12:00:01.000Z",
};

describe("tick commit rebase", () => {
  it("commits the tick's result when nothing else changed", () => {
    expect(rebaseTickState(draft, before, before, "twitch")).toEqual({
      status: "current",
      state: draft,
    });
  });

  it("keeps another writer's change to a key the tick left alone", () => {
    const manualWatch = {
      twitch: { active: true, checkedAt: "2026-09-26T12:00:01.000Z", tabId: 5 },
    } as SchedulerState["manualWatch"];
    const latest = { ...before, manualWatch };
    const rebased = rebaseTickState(draft, before, latest, "twitch");
    expect(rebased).toMatchObject({
      status: "current",
      state: { manualWatch, sessions: { twitch: draft.sessions.twitch } },
    });
  });

  it("applies playback telemetry for the tab the tick still watches", () => {
    const latest = {
      ...before,
      sessions: {
        ...before.sessions,
        twitch: { ...watching, playback: playing, playbackChecks: 0 },
      },
    };
    const rebased = rebaseTickState(draft, before, latest, "twitch");
    expect(rebased).toMatchObject({
      status: "current",
      state: {
        sessions: {
          twitch: { message: "Keeping current watch tab", playback: playing, playbackChecks: 0 },
        },
      },
    });
  });

  it("drops telemetry for a tab the tick moved away from", () => {
    const moved = {
      ...draft,
      sessions: { ...draft.sessions, twitch: { ...draft.sessions.twitch, tabId: 11 } },
    };
    const latest = {
      ...before,
      sessions: { ...before.sessions, twitch: { ...watching, playback: playing } },
    };
    const rebased = rebaseTickState(moved, before, latest, "twitch");
    expect(rebased.status).toBe("current");
    expect(rebased.status === "current" && rebased.state.sessions.twitch.playback).toBeUndefined();
  });

  it("leaves heartbeat fields to the heartbeat's own commit", () => {
    const latest = {
      ...before,
      sessions: {
        ...before.sessions,
        twitch: { ...watching, lastHeartbeatAt: "2026-09-26T12:00:02.000Z", lastHeartbeatOk: true },
      },
    };
    expect(rebaseTickState(draft, before, latest, "twitch").status).toBe("current");
  });

  it("drops the decision when another writer changed the session otherwise", () => {
    const latest = {
      ...before,
      sessions: {
        ...before.sessions,
        twitch: {
          platform: "twitch" as const,
          status: "paused" as const,
          offlineChecks: 0,
          reasonCode: "manual_tab_close" as const,
        },
      },
    };
    expect(rebaseTickState(draft, before, latest, "twitch")).toEqual({
      status: "conflict",
      reason: "the watch session changed",
    });
  });

  it("keeps the tick observation and a concurrently committed rejection flag", () => {
    const now = Date.now();
    const pageContext = {
      source: "page_context",
      reason: "integrity_rejection_recovery",
    } as const;
    let baseline = before;
    for (const minutes of [120, 90, 60, 30]) {
      const at = now - minutes * 60_000;
      baseline = recordManagedTabOpen(baseline, "twitch", at, pageContext).state;
      baseline = recordRejectedManagedPageContext(baseline, "twitch", at).state;
    }
    const tick = observeCriticalHealth(
      recordManagedTabOpen({ ...draft, criticalHealth: baseline.criticalHealth }, "twitch", now, {
        source: "watch_tab",
      }).state,
      "twitch",
      { at: now, failing: false, progressed: true, preconditionBroke: false, watchedMinutes: 7 },
    ).state;
    const latest = recordRejectedManagedPageContext(
      recordManagedTabOpen(baseline, "twitch", now - 1, pageContext).state,
      "twitch",
      now - 1,
    ).state;
    const rebased = rebaseTickState(tick, baseline, latest, "twitch");
    expect(rebased).toMatchObject({
      status: "current",
      state: {
        sessions: draft.sessions,
        criticalHealth: {
          twitch: {
            status: "flagged",
            reason: "page_context_churn",
            flaggedAt: new Date(now - 1).toISOString(),
            breakerOpen: true,
            lastWatchedMinutes: 7,
            managedTabOpens: [new Date(now - 1).toISOString(), new Date(now).toISOString()],
            rejectedPageContextOpens: latest.criticalHealth?.twitch?.rejectedPageContextOpens,
            records: [
              ...latest.criticalHealth!.twitch!.records,
              { kind: "watch_tab_open", at: new Date(now).toISOString() },
            ],
          },
        },
      },
    });
    expect(rebased.status === "current" && rebased.event).toBeUndefined();
  });

  it("trips the breaker when opens committed separately reach the shared limit", () => {
    const now = Date.now();
    const pageContext = { source: "page_context", reason: "background_rejected" } as const;
    const baseline = [3, 2, 1].reduce(
      (state, seconds) =>
        recordManagedTabOpen(state, "twitch", now - seconds * 1000, pageContext).state,
      before,
    );
    const tick = recordManagedTabOpen(
      { ...draft, criticalHealth: baseline.criticalHealth },
      "twitch",
      now,
      { source: "watch_tab" },
    ).state;
    const latest = recordManagedTabOpen(baseline, "twitch", now, pageContext).state;
    expect(tick.criticalHealth?.twitch?.breakerOpen).toBe(false);
    expect(latest.criticalHealth?.twitch?.breakerOpen).toBe(false);
    expect(rebaseTickState(tick, baseline, latest, "twitch")).toMatchObject({
      status: "current",
      state: {
        criticalHealth: { twitch: { breakerOpen: true, reason: "page_context_churn" } },
      },
      event: { code: "critical_failure_detected", data: { reason: "page_context_churn" } },
    });
  });

  it("keeps a dismissal when a tick observed critical health before it was reset", () => {
    const now = Date.now();
    const baseline = [4, 3, 2, 1, 0].reduce(
      (state, seconds) =>
        recordManagedTabOpen(state, "twitch", now - seconds * 1000, { source: "watch_tab" }).state,
      before,
    );
    const tick = observeCriticalHealth(baseline, "twitch", {
      at: now,
      failing: true,
      progressed: false,
      preconditionBroke: false,
    }).state;
    const latest = dismissCriticalFailure(baseline, "twitch", now).state;
    expect(rebaseTickState(tick, baseline, latest, "twitch")).toMatchObject({ status: "conflict" });
  });

  it("carries another writer's claim into the tick's inventory", () => {
    const latest = { ...before, campaigns: { ...before.campaigns, twitch: [drops("claimed")] } };
    const refreshed = {
      ...draft,
      campaigns: {
        ...draft.campaigns,
        twitch: [{ ...drops("claimable"), name: "Drops (refreshed)" }],
      },
    };
    const rebased = rebaseTickState(refreshed, before, latest, "twitch");
    expect(rebased).toMatchObject({
      status: "current",
      state: {
        campaigns: { twitch: [{ name: "Drops (refreshed)", rewards: [{ status: "claimed" }] }] },
      },
    });
  });
});

describe("facts of a dropped tick", () => {
  it("records the tick's claims and closed tab, and hands back the tab it opened", () => {
    const tickResult: SchedulerState = {
      ...draft,
      campaigns: { ...draft.campaigns, twitch: [drops("claimed")] },
      sessions: { ...draft.sessions, twitch: { ...watching, tabId: 11 } },
      managedWatchTabs: {
        twitch: {
          platform: "twitch",
          tabId: 11,
          channelUrl: "https://www.twitch.tv/creator",
          ownedByExtension: true,
        },
      },
    };
    const latest = {
      ...before,
      manualClosePause: {
        twitch: { platform: "twitch" as const, closedAt: "2026-09-26T12:00:01.000Z" },
      },
    };
    const facts = tickEffectFacts(tickResult, before, latest, "twitch");

    expect(facts.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
    expect(facts.state.manualClosePause).toEqual(latest.manualClosePause);
    expect(facts.state.sessions.twitch).toEqual(latest.sessions.twitch);
    // The tick replaced tab 10, so storage no longer tracks a tab that is gone.
    expect(facts.state.managedWatchTabs?.twitch).toBeUndefined();
    expect(facts.openedTab).toMatchObject({
      tabId: 11,
      tabManagedByExtension: true,
      status: "watching",
    });
  });

  it("records the challenge poll a superseded tick made, unless a newer one was committed", () => {
    const polled = {
      ...draft,
      gamification: { kick: { lastCheckedAt: "2026-09-26T12:00:00.000Z" } },
    };

    const facts = tickEffectFacts(polled, before, before, "kick");
    expect(facts.state.gamification?.kick).toEqual({ lastCheckedAt: "2026-09-26T12:00:00.000Z" });

    const newer = {
      ...before,
      gamification: { kick: { lastCheckedAt: "2026-09-26T12:05:00.000Z" } },
    };
    expect(tickEffectFacts(polled, before, newer, "kick").state.gamification?.kick).toEqual({
      lastCheckedAt: "2026-09-26T12:05:00.000Z",
    });
  });
});
