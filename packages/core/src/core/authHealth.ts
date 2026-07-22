import type { ActivityEvent } from "@lurkloot/shared/events";
import type { Platform, PlatformAuthHealth, PlatformAuthStatus, SchedulerState } from "@lurkloot/shared/models";
import { normalizePlatformAuthHealth } from "./defaults";

export interface PlatformAuthHealthTransition {
  state: SchedulerState;
  event?: ActivityEvent;
}

function semanticHealth(health: PlatformAuthHealth): string {
  return JSON.stringify({
    status: health.status,
    reasonCode: health.reasonCode,
    message: health.message,
  });
}

function transitionLevel(status: PlatformAuthStatus): ActivityEvent["level"] {
  if (status === "blocked") return "error";
  if (status === "checking" || status === "healthy") return "info";
  return "warn";
}

export function applyPlatformAuthHealth(
  state: SchedulerState,
  platform: Platform,
  candidate: unknown,
): PlatformAuthHealthTransition {
  const previous = state.authHealth[platform];
  const health = normalizePlatformAuthHealth(candidate);
  const nextState: SchedulerState = {
    ...state,
    authHealth: { ...state.authHealth, [platform]: health },
  };

  if (semanticHealth(previous) === semanticHealth(health)) return { state: nextState };

  return {
    state: nextState,
    event: {
      category: "activity",
      code: "auth_health_changed",
      level: transitionLevel(health.status),
      platform,
      data: {
        from: previous.status,
        to: health.status,
        ...(health.reasonCode ? { reason: health.reasonCode } : {}),
      },
    },
  };
}
