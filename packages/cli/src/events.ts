import type { EngineEvent, FarmingStopReason, PageContextCloseReason, PageContextOpenReason } from "@lurkloot/shared/events";
import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";
import type { Logger } from "./logger";

function formatStopReason(reason: FarmingStopReason): string {
  switch (reason) {
    case "automation_disabled": return "automation disabled";
    case "platform_disabled": return "platform disabled";
    case "authentication_unhealthy": return "authentication unhealthy";
    case "platform_backoff": return "platform backoff";
    case "platform_error": return "platform error";
    case "campaign_ineligible": return "campaign ineligible";
    case "channel_excluded": return "channel excluded";
    case "channel_offline": return "channel offline";
    case "channel_mismatch": return "channel mismatch";
    case "watch_unhealthy": return "watch unhealthy";
    case "higher_priority_reward": return "higher priority reward";
    case "higher_priority_idle_watchlist": return "higher priority idle watchlist";
    case "watch_requirement_completed": return "watch requirement completed";
    case "runtime_restart": return "runtime restart";
    case "target_changed": return "target changed";
    case "manual_watch": return "manual watch";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatPageContextOpenReason(reason: PageContextOpenReason): string {
  switch (reason) {
    case "background_rejected": return "background request rejected";
    case "managed_context_unusable": return "previous background context unusable";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatPageContextCloseReason(reason: PageContextCloseReason): string {
  switch (reason) {
    case "background_recovered": return "background requests recovered";
    case "user_tab_available": return "user Kick tab available";
    case "platform_disabled": return "platform disabled";
    case "automation_disabled": return "automation disabled";
    case "manual_watch": return "manual watch detected";
    case "authentication_unhealthy": return "authentication unavailable";
    case "runtime_restart": return "extension runtime restarted";
    case "managed_context_unusable": return "background context unusable";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatCriticalFailureReason(reason: CriticalFailureReason): string {
  return reason === "page_context_churn" ? "a tab kept reopening" : "no progress despite repeated errors";
}

export function formatCliEvent(event: EngineEvent): string {
  if (event.category === "diagnostic") return event.message;

  switch (event.code) {
    case "farming_started":
      return `Started farming ${event.data.rewardName} from ${event.data.campaignName}`;
    case "farming_stopped":
      return `Stopped farming ${event.data.rewardName} from ${event.data.campaignName}: ${formatStopReason(event.data.reason)}`;
    case "reward_claimed":
      return `Claimed ${event.data.rewardName} from ${event.data.campaignName} ${event.data.method === "automatic" ? "automatically" : "manually"}`;
    case "interruption": {
      const detail = event.data.detail ? ` (${event.data.detail})` : "";
      return `Farming interrupted: ${formatStopReason(event.data.reason)}${detail}`;
    }
    case "challenge_claimed":
      return `Claimed a ${event.data.rarity} ${event.data.recurrence} challenge`;
    case "page_context_opened":
      return `Opened background context on ${event.data.host}: ${formatPageContextOpenReason(event.data.reason)}`;
    case "page_context_closed":
      return `Closed background context on ${event.data.host}: ${formatPageContextCloseReason(event.data.reason)}`;
    case "auth_health_changed": {
      const reason = event.data.reason ? ` (${event.data.reason})` : "";
      return `${event.platform} authentication changed from ${event.data.from} to ${event.data.to}${reason}`;
    }
    case "critical_failure_detected":
      return `${event.platform} is not working: ${formatCriticalFailureReason(event.data.reason)}`;
    case "critical_failure_cleared":
      return `${event.platform} critical failure dismissed; retrying`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export async function reportCliEvents(events: readonly EngineEvent[], logger: Logger): Promise<void> {
  for (const event of events) {
    logger.log(event.level, formatCliEvent(event), event.platform ?? event.category);
  }
}
