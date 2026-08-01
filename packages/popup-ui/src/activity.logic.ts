import type {
  ActivityHistoryRecord,
  PageContextCloseReason,
  PageContextOpenReason,
  FarmingStopReason,
  StoredEngineEvent,
} from "@lurkloot/shared/events";
import type { ActivityPage } from "@lurkloot/shared/messages";
import type { Platform } from "@lurkloot/shared/models";
import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";
import type { TFunction } from "./types";

export type ActivityStream = {
  events: ActivityHistoryRecord[];
  initialized: boolean;
  nextCursor?: string;
};

export type ActivityRequestScope = {
  generation: number;
  platform: Platform;
  query: string;
};

export type ActivityCardIcon =
  | "gift"
  | "play"
  | "pause"
  | "trophy"
  | "triangle"
  | "monitor-up"
  | "monitor-down"
  | "shield"
  | "octagon-alert"
  | "refresh";

export type ActivityCardTone = "success" | "accent" | "danger" | "warning" | "muted";

export type ActivityCard = {
  icon: ActivityCardIcon;
  tone: ActivityCardTone;
  summary: string;
  detail?: string;
  chips: string[];
  reward?: {
    name: string;
    imageUrl?: string;
  };
  campaignName?: string;
  campaignUrl?: string;
};

export type ActivityMutationSequence = { latest: number };

export function createActivityMutationSequence(): ActivityMutationSequence {
  return { latest: 0 };
}

export function beginActivityMutation(sequence: ActivityMutationSequence): number {
  sequence.latest += 1;
  return sequence.latest;
}

export function isLatestActivityMutation(sequence: ActivityMutationSequence, request: number): boolean {
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

export function createActivityRequestScope(platform: Platform, query = ""): ActivityRequestScope {
  return { generation: 0, platform, query };
}

export function advanceActivityRequestScope(
  current: ActivityRequestScope,
  platform: Platform = current.platform,
  query: string = current.query,
): ActivityRequestScope {
  return { generation: current.generation + 1, platform, query };
}

export function isActivityRequestCurrent(
  request: ActivityRequestScope,
  current: ActivityRequestScope,
): boolean {
  return request.generation === current.generation
    && request.platform === current.platform
    && request.query === current.query;
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

export function applyActivityMutationForRequest(
  current: ActivityStream,
  page: ActivityPage,
  kind: "refresh" | "page",
  request: ActivityRequestScope,
  active: ActivityRequestScope,
  sequence: ActivityMutationSequence,
  mutationRequest: number,
): ActivityStream {
  return isLatestActivityMutation(sequence, mutationRequest)
    ? applyActivityPageForRequest(current, page, kind, request, active)
    : current;
}

function formatStopReason(reason: FarmingStopReason, t: TFunction): string {
  switch (reason) {
    case "automation_disabled": return t("activityReasonAutomationDisabled");
    case "platform_disabled": return t("activityReasonPlatformDisabled");
    case "authentication_unhealthy": return t("activityReasonAuthenticationUnhealthy");
    case "platform_backoff": return t("activityReasonPlatformBackoff");
    case "platform_error": return t("activityReasonPlatformError");
    case "campaign_ineligible": return t("activityReasonCampaignIneligible");
    case "channel_excluded": return t("activityReasonChannelExcluded");
    case "channel_offline": return t("activityReasonChannelOffline");
    case "channel_mismatch": return t("activityReasonChannelMismatch");
    case "watch_unhealthy": return t("activityReasonWatchUnhealthy");
    case "higher_priority_reward": return t("activityReasonHigherPriorityReward");
    case "higher_priority_idle_watchlist": return t("activityReasonHigherPriorityIdleWatchlist");
    case "watch_requirement_completed": return t("activityReasonWatchRequirementCompleted");
    case "runtime_restart": return t("activityReasonRuntimeRestart");
    case "target_changed": return t("activityReasonTargetChanged");
    case "critical_failure": return t("activityReasonCriticalFailure");
    case "manual_watch": return t("activityReasonManualWatch");
    case "manual_tab_close": return t("activityReasonManualTabClose");
    case "authentication_unhealthy": return t("activityReasonAuthenticationUnhealthy");
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatPageContextOpenReason(reason: PageContextOpenReason, t: TFunction): string {
  switch (reason) {
    case "background_rejected": return t("activityPageContextOpenReasonBackgroundRejected");
    case "managed_context_unusable": return t("activityPageContextReasonManagedContextUnusable");
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatPageContextCloseReason(reason: PageContextCloseReason, t: TFunction): string {
  switch (reason) {
    case "background_recovered": return t("activityPageContextCloseReasonBackgroundRecovered");
    case "user_tab_available": return t("activityPageContextCloseReasonUserTabAvailable");
    case "platform_disabled": return t("activityReasonPlatformDisabled");
    case "automation_disabled": return t("activityReasonAutomationDisabled");
    case "manual_watch": return t("activityReasonManualWatch");
    case "manual_tab_close": return t("activityReasonManualTabClose");
    case "authentication_unhealthy": return t("activityReasonAuthenticationUnhealthy");
    case "runtime_restart": return t("activityReasonRuntimeRestart");
    case "managed_context_unusable": return t("activityPageContextReasonManagedContextUnusable");
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatCriticalFailureReason(reason: CriticalFailureReason, t: TFunction): string {
  switch (reason) {
    case "page_context_churn": return t("criticalFailureReasonPageContextChurn");
    case "no_progress": return t("criticalFailureReasonNoProgress");
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatDisplayValue(value: string): string {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
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
    case "challenge_claimed":
      return t("activityChallengeClaimed", [event.data.rarity, event.data.recurrence]);
    case "page_context_opened":
      return t("activityPageContextOpened", [event.data.host, formatPageContextOpenReason(event.data.reason, t)]);
    case "page_context_closed":
      return t("activityPageContextClosed", [event.data.host, formatPageContextCloseReason(event.data.reason, t)]);
    case "auth_health_changed":
      return t("activityAuthHealthChanged", [
        formatDisplayValue(event.platform),
        formatDisplayValue(event.data.from),
        formatDisplayValue(event.data.to),
      ]);
    case "critical_failure_detected":
      return t("activityCriticalFailureDetected", [event.platform, formatCriticalFailureReason(event.data.reason, t)]);
    case "critical_failure_cleared":
      return t("activityCriticalFailureCleared", event.platform);
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

export function buildActivityCard(event: ActivityHistoryRecord, t: TFunction): ActivityCard | undefined {
  if ("legacy" in event || event.category === "diagnostic") return undefined;

  const summary = formatCurrentActivity(event, t);
  switch (event.code) {
    case "reward_claimed":
      return {
        icon: "gift",
        tone: "success",
        summary,
        chips: [event.data.method],
        reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl },
        campaignName: event.data.campaignName,
        campaignUrl: event.data.campaignUrl,
      };
    case "farming_started":
      return {
        icon: "play",
        tone: "accent",
        summary,
        chips: event.data.channel ? [event.data.channel] : [],
        reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl },
        campaignName: event.data.campaignName,
        campaignUrl: event.data.campaignUrl,
      };
    case "farming_stopped":
      return {
        icon: "pause",
        tone: event.level === "error" ? "danger" : "warning",
        summary,
        chips: [formatStopReason(event.data.reason, t)],
        reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl },
        campaignName: event.data.campaignName,
        campaignUrl: event.data.campaignUrl,
      };
    case "challenge_claimed":
      return {
        icon: "trophy",
        tone: "success",
        summary,
        chips: [event.data.rarity, event.data.recurrence],
      };
    case "interruption":
      return {
        icon: "triangle",
        tone: event.level === "error" ? "danger" : "warning",
        summary,
        detail: event.data.detail,
        chips: [formatStopReason(event.data.reason, t)],
      };
    case "page_context_opened":
      return {
        icon: "monitor-up",
        tone: "accent",
        summary,
        chips: [event.data.host, formatPageContextOpenReason(event.data.reason, t)],
      };
    case "page_context_closed":
      return {
        icon: "monitor-down",
        tone: "muted",
        summary,
        chips: [event.data.host, formatPageContextCloseReason(event.data.reason, t)],
      };
    case "auth_health_changed":
      return {
        icon: "shield",
        tone: event.level === "error" ? "danger" : "warning",
        summary,
        detail: `${formatDisplayValue(event.data.from)} → ${formatDisplayValue(event.data.to)}`,
        chips: event.data.reason ? [event.data.reason] : [],
      };
    case "critical_failure_detected":
      return {
        icon: "octagon-alert",
        tone: "danger",
        summary,
        chips: [formatCriticalFailureReason(event.data.reason, t)],
      };
    case "critical_failure_cleared":
      return {
        icon: "refresh",
        tone: "success",
        summary,
        chips: [formatCriticalFailureReason(event.data.reason, t)],
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export interface ActivityExportInput {
  // The full loaded list for the visible view, newest first (as held in state).
  events: readonly ActivityHistoryRecord[];
  platform: Platform;
  diagnostics: boolean;
  version: string;
  userAgent: string;
  locale: string;
  at: string;
}

// Plain text, not markup: this is pasted into email, Discord and issue bodies,
// and it has to read as-is in all of them. The header carries the environment
// facts a bug report is usually missing (version first) and nothing else — the
// event bodies already decide what user data leaves the machine, and this adds
// no identity, account or channel information of its own.
export function buildActivityExport(input: ActivityExportInput, t: TFunction): string {
  const header = [
    `Lurkloot ${input.diagnostics ? "diagnostics" : "activity"} log`,
    `version: ${input.version}`,
    `platform: ${input.platform}`,
    `locale: ${input.locale}`,
    `exported: ${input.at}`,
    `browser: ${input.userAgent}`,
    `events: ${input.events.length}`,
  ].join("\n");

  // Oldest first: a log is read top-down when you are reconstructing what
  // happened, even though the popup lists newest first.
  const body = input.events.length === 0
    ? "(no events)"
    : [...input.events]
      .reverse()
      .map((event) => `${event.at} [${event.level}] ${formatActivityEvent(event, t)}`)
      .join("\n");

  return `${header}\n\n${body}\n`;
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
