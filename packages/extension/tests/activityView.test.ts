import { describe, expect, it, vi } from "vitest";
import type { ActivityHistoryRecord, FarmingStopReason } from "@lurkloot/shared/events";
import {
  advanceActivityRequestScope,
  beginActivityRefresh,
  applyActivityPage,
  applyActivityPageForRequest,
  applyActivityRefreshForRequest,
  createActivityRequestScope,
  createActivityRefreshSequence,
  createActivityStream,
  formatActivityEvent,
  isActivityRequestCurrent,
  isLatestActivityRefresh,
  mergeActivityPages,
} from "../../popup-ui/src/activity.logic";

const at = "2026-07-14T12:00:00.000Z";

function event(id: string, eventAt = at): ActivityHistoryRecord {
  return {
    id,
    at: eventAt,
    category: "activity",
    code: "interruption",
    level: "warn",
    data: { reason: "runtime_restart" },
  };
}

describe("activity view model", () => {
  it("formats current activity wording from code and payload", () => {
    const t = vi.fn((key: string, substitutions?: string | string[]) =>
      `${key}:${Array.isArray(substitutions) ? substitutions.join("|") : substitutions ?? ""}`);
    const stopped: ActivityHistoryRecord = {
      id: "stopped",
      at,
      category: "activity",
      code: "farming_stopped",
      level: "warn",
      platform: "twitch",
      data: {
        campaignId: "campaign",
        campaignName: "Campaign",
        rewardId: "reward",
        rewardName: "Reward",
        reason: "runtime_restart",
      },
    };

    expect(formatActivityEvent(stopped, t)).toBe(
      "activityFarmingStopped:Reward|Campaign|activityReasonRuntimeRestart:",
    );
    expect(t).toHaveBeenCalledWith("activityReasonRuntimeRestart");
  });

  it("formats every farming stop reason through its locale key", () => {
    const t = vi.fn((key: string) => key);
    const reasons: FarmingStopReason[] = [
      "automation_disabled",
      "platform_disabled",
      "platform_backoff",
      "platform_error",
      "campaign_ineligible",
      "channel_excluded",
      "channel_offline",
      "channel_mismatch",
      "watch_unhealthy",
      "higher_priority_reward",
      "higher_priority_watch_queue",
      "watch_requirement_completed",
      "runtime_restart",
      "target_changed",
      "manual_watch",
    ];

    for (const reason of reasons) {
      formatActivityEvent({
        id: reason,
        at,
        category: "activity",
        code: "interruption",
        level: "warn",
        data: { reason },
      }, t);
    }

    expect(t.mock.calls.map(([key]) => key)).toEqual([
      "activityReasonAutomationDisabled", "activityInterruption",
      "activityReasonPlatformDisabled", "activityInterruption",
      "activityReasonPlatformBackoff", "activityInterruption",
      "activityReasonPlatformError", "activityInterruption",
      "activityReasonCampaignIneligible", "activityInterruption",
      "activityReasonChannelExcluded", "activityInterruption",
      "activityReasonChannelOffline", "activityInterruption",
      "activityReasonChannelMismatch", "activityInterruption",
      "activityReasonWatchUnhealthy", "activityInterruption",
      "activityReasonHigherPriorityReward", "activityInterruption",
      "activityReasonHigherPriorityWatchQueue", "activityInterruption",
      "activityReasonWatchRequirementCompleted", "activityInterruption",
      "activityReasonRuntimeRestart", "activityInterruption",
      "activityReasonTargetChanged", "activityInterruption",
      "activityReasonManualWatch", "activityInterruption",
    ]);
  });

  it("uses stored prose only for diagnostics and legacy fallback", () => {
    const t = vi.fn((key: string) => key);
    const diagnostic: ActivityHistoryRecord = {
      id: "diagnostic",
      at,
      category: "diagnostic",
      level: "debug",
      message: "network detail",
    };
    const legacy: ActivityHistoryRecord = {
      id: "legacy",
      at,
      level: "info",
      message: "old activity",
      legacy: true,
    };

    expect(formatActivityEvent(diagnostic, t)).toBe("network detail");
    expect(formatActivityEvent(legacy, t)).toBe("old activity");
    expect(t).not.toHaveBeenCalled();
  });

  it("merges refreshed and paged results without duplicates", () => {
    expect(mergeActivityPages([event("2"), event("1")], [event("3"), event("2")])
      .map((entry) => entry.id)).toEqual(["3", "2", "1"]);
  });

  it("reopens pagination when a refresh creates a gap after exhaustion", () => {
    let stream = applyActivityPage(
      createActivityStream(),
      { events: [event("3"), event("2")], nextCursor: "after-2" },
      "refresh",
    );
    expect(stream.initialized).toBe(true);
    expect(stream.nextCursor).toBe("after-2");

    stream = applyActivityPage(stream, { events: [event("1")] }, "page");
    expect(stream.nextCursor).toBeUndefined();

    stream = applyActivityPage(
      stream,
      { events: [event("5"), event("4")], nextCursor: "after-4" },
      "refresh",
    );
    expect(stream.events.map((entry) => entry.id)).toEqual(["5", "4", "3", "2", "1"]);
    expect(stream.nextCursor).toBe("after-4");
  });

  it("keeps exhausted coverage when a refreshed page overlaps loaded history", () => {
    const exhausted = applyActivityPage(
      applyActivityPage(createActivityStream(), { events: [event("3"), event("2")], nextCursor: "after-2" }, "refresh"),
      { events: [event("1")] },
      "page",
    );

    const refreshed = applyActivityPage(
      exhausted,
      { events: [event("4"), event("3")], nextCursor: "after-3" },
      "refresh",
    );
    expect(refreshed.nextCursor).toBeUndefined();
  });

  it("replaces stale duplicate content with the incoming record", () => {
    const stale: ActivityHistoryRecord = { id: "same", at, level: "info", message: "stale", legacy: true };
    const fresh: ActivityHistoryRecord = { ...stale, message: "fresh" };

    expect(mergeActivityPages([stale], [fresh])).toEqual([fresh]);
  });

  it("invalidates requests across platform resets and clear generations", () => {
    const twitch = createActivityRequestScope("twitch");
    const kick = advanceActivityRequestScope(twitch, "kick");
    const afterClear = advanceActivityRequestScope(kick);

    expect(isActivityRequestCurrent(twitch, kick)).toBe(false);
    expect(isActivityRequestCurrent(kick, afterClear)).toBe(false);
    expect(isActivityRequestCurrent(afterClear, afterClear)).toBe(true);
  });

  it("rejects an older refresh response after a newer refresh was issued", () => {
    const sequence = createActivityRefreshSequence();
    const scope = createActivityRequestScope("twitch");
    const older = beginActivityRefresh(sequence);
    const newer = beginActivityRefresh(sequence);
    const current = applyActivityRefreshForRequest(
      createActivityStream(),
      { events: [event("newer")], nextCursor: "newer-cursor" },
      scope,
      scope,
      sequence,
      newer,
    );

    expect(isLatestActivityRefresh(sequence, older)).toBe(false);
    expect(isLatestActivityRefresh(sequence, newer)).toBe(true);
    expect(applyActivityRefreshForRequest(
      current,
      { events: [event("older")], nextCursor: "older-cursor" },
      scope,
      scope,
      sequence,
      older,
    )).toBe(current);
    expect(current.nextCursor).toBe("newer-cursor");
  });

  it("ignores stale platform pages and stale loading completions", () => {
    const twitchRequest = createActivityRequestScope("twitch");
    const currentScope = advanceActivityRequestScope(twitchRequest, "kick");
    const current = applyActivityPage(createActivityStream(), { events: [event("kick-current")] }, "refresh");
    const platformLessStale: ActivityHistoryRecord = {
      id: "platform-less-stale",
      at,
      category: "diagnostic",
      level: "debug",
      message: "stale",
    };

    expect(applyActivityPageForRequest(
      current,
      { events: [platformLessStale], nextCursor: "stale-cursor" },
      "page",
      twitchRequest,
      currentScope,
    )).toBe(current);
    expect(isActivityRequestCurrent(twitchRequest, currentScope)).toBe(false);
  });

  it("orders merged streams newest first and uses id as a stable tie-breaker", () => {
    expect(mergeActivityPages(
      [event("a", "2026-07-14T11:00:00.000Z")],
      [event("c"), event("b")],
    ).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });
});
