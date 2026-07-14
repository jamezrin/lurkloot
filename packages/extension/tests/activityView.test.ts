import { describe, expect, it, vi } from "vitest";
import type { ActivityHistoryRecord, FarmingStopReason } from "@lurkloot/shared/events";
import { formatActivityEvent, mergeActivityPages } from "../../popup-ui/src/activity.logic";

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

  it("orders merged streams newest first and uses id as a stable tie-breaker", () => {
    expect(mergeActivityPages(
      [event("a", "2026-07-14T11:00:00.000Z")],
      [event("c"), event("b")],
    ).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });
});
