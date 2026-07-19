import type { EngineEvent, FarmingStopReason } from "@lurkloot/shared/events";
import type { Logger } from "./logger";

function formatStopReason(reason: FarmingStopReason): string {
  switch (reason) {
    case "automation_disabled": return "automation disabled";
    case "platform_disabled": return "platform disabled";
    case "platform_backoff": return "platform backoff";
    case "platform_error": return "platform error";
    case "campaign_ineligible": return "campaign ineligible";
    case "channel_excluded": return "channel excluded";
    case "channel_offline": return "channel offline";
    case "channel_mismatch": return "channel mismatch";
    case "watch_unhealthy": return "watch unhealthy";
    case "higher_priority_reward": return "higher priority reward";
    case "higher_priority_watch_queue": return "higher priority watch queue";
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
