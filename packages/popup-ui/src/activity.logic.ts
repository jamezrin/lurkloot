import type {
  ActivityHistoryRecord,
  FarmingStopReason,
  StoredEngineEvent,
} from "@lurkloot/shared/events";
import type { ActivityPage } from "@lurkloot/shared/messages";
import type { Platform } from "@lurkloot/shared/models";
import type { TFunction } from "./types";

export type ActivityStream = {
  events: ActivityHistoryRecord[];
  initialized: boolean;
  nextCursor?: string;
};

export type ActivityRequestScope = {
  generation: number;
  platform: Platform;
};

export type ActivityRefreshSequence = { latest: number };

export function createActivityRefreshSequence(): ActivityRefreshSequence {
  return { latest: 0 };
}

export function beginActivityRefresh(sequence: ActivityRefreshSequence): number {
  sequence.latest += 1;
  return sequence.latest;
}

export function isLatestActivityRefresh(sequence: ActivityRefreshSequence, request: number): boolean {
  return sequence.latest === request;
}

export function createActivityStream(): ActivityStream {
  return { events: [], initialized: false };
}

export function applyActivityPage(
  current: ActivityStream,
  page: ActivityPage,
  kind: "refresh" | "page",
): ActivityStream {
  const currentIds = new Set(current.events.map((event) => event.id));
  const refreshOverlapsCoverage = page.events.some((event) => currentIds.has(event.id));
  const adoptRefreshCursor = !current.initialized
    || Boolean(page.nextCursor && !refreshOverlapsCoverage);

  return {
    events: mergeActivityPages(current.events, page.events),
    initialized: true,
    nextCursor: kind === "page" || adoptRefreshCursor ? page.nextCursor : current.nextCursor,
  };
}

export function createActivityRequestScope(platform: Platform): ActivityRequestScope {
  return { generation: 0, platform };
}

export function advanceActivityRequestScope(
  current: ActivityRequestScope,
  platform: Platform = current.platform,
): ActivityRequestScope {
  return { generation: current.generation + 1, platform };
}

export function isActivityRequestCurrent(
  request: ActivityRequestScope,
  current: ActivityRequestScope,
): boolean {
  return request.generation === current.generation && request.platform === current.platform;
}

export function applyActivityPageForRequest(
  current: ActivityStream,
  page: ActivityPage,
  kind: "refresh" | "page",
  request: ActivityRequestScope,
  active: ActivityRequestScope,
): ActivityStream {
  return isActivityRequestCurrent(request, active)
    ? applyActivityPage(current, page, kind)
    : current;
}

export function applyActivityRefreshForRequest(
  current: ActivityStream,
  page: ActivityPage,
  request: ActivityRequestScope,
  active: ActivityRequestScope,
  sequence: ActivityRefreshSequence,
  refreshRequest: number,
): ActivityStream {
  return isLatestActivityRefresh(sequence, refreshRequest)
    ? applyActivityPageForRequest(current, page, "refresh", request, active)
    : current;
}

function formatStopReason(reason: FarmingStopReason, t: TFunction): string {
  switch (reason) {
    case "automation_disabled": return t("activityReasonAutomationDisabled");
    case "platform_disabled": return t("activityReasonPlatformDisabled");
    case "platform_backoff": return t("activityReasonPlatformBackoff");
    case "platform_error": return t("activityReasonPlatformError");
    case "campaign_ineligible": return t("activityReasonCampaignIneligible");
    case "channel_excluded": return t("activityReasonChannelExcluded");
    case "channel_offline": return t("activityReasonChannelOffline");
    case "channel_mismatch": return t("activityReasonChannelMismatch");
    case "watch_unhealthy": return t("activityReasonWatchUnhealthy");
    case "higher_priority_reward": return t("activityReasonHigherPriorityReward");
    case "higher_priority_watch_queue": return t("activityReasonHigherPriorityWatchQueue");
    case "watch_requirement_completed": return t("activityReasonWatchRequirementCompleted");
    case "runtime_restart": return t("activityReasonRuntimeRestart");
    case "target_changed": return t("activityReasonTargetChanged");
    case "manual_watch": return t("activityReasonManualWatch");
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatCurrentActivity(event: StoredEngineEvent & { category: "activity" }, t: TFunction): string {
  switch (event.code) {
    case "farming_started":
      return t("activityFarmingStarted", [event.data.rewardName, event.data.campaignName]);
    case "farming_stopped":
      return t("activityFarmingStopped", [
        event.data.rewardName,
        event.data.campaignName,
        formatStopReason(event.data.reason, t),
      ]);
    case "reward_claimed":
      return t("activityRewardClaimed", [event.data.rewardName, event.data.campaignName]);
    case "interruption": {
      const reason = formatStopReason(event.data.reason, t);
      return event.data.detail
        ? t("activityInterruptionWithDetail", [reason, event.data.detail])
        : t("activityInterruption", reason);
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function formatActivityEvent(event: ActivityHistoryRecord, t: TFunction): string {
  if ("legacy" in event || event.category === "diagnostic") return event.message;
  return formatCurrentActivity(event, t);
}

export function mergeActivityPages(
  current: readonly ActivityHistoryRecord[],
  incoming: readonly ActivityHistoryRecord[],
): ActivityHistoryRecord[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) =>
    right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
}
