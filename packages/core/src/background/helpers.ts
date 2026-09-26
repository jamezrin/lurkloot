import type { DropCampaign, DropReward, EngineSettings, Platform, SchedulerState, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { ActivityEvent, EngineEvent, EventEmitter, FarmingStopReason } from "@lurkloot/shared/events";
import { MANUAL_WATCH_TTL_MS } from "../core/scheduler";
import { isTimestampStale } from "../core/timestamps";
import type { SettingsEffects } from "./stateTransaction";
import type { TickDiagnosticContext, TickTrigger } from "./types";

export function correlateTickDiagnostics(
  events: readonly EngineEvent[],
  tickContext: TickDiagnosticContext,
): EngineEvent[] {
  return events.map((event) =>
    event.category === "diagnostic" ? { ...event, ...tickContext } : event);
}

// The tick a settings commit asks for. A change that only reorders what is
// farmed re-selects from the discovery already held; anything else rediscovers.
export function settingsTickTrigger(effects: SettingsEffects): TickTrigger {
  const values = Object.values(effects);
  return values.length > 0 && values.every((effect) => effect === "selection")
    ? "ranking_changed"
    : "settings_saved";
}

export const FARMING_STOP_REASON_CODES: Record<FarmingStopReason, true> = {
  automation_disabled: true,
  platform_disabled: true,
  authentication_unhealthy: true,
  platform_backoff: true,
  platform_error: true,
  campaign_ineligible: true,
  channel_excluded: true,
  channel_offline: true,
  channel_mismatch: true,
  watch_unhealthy: true,
  no_progress: true,
  higher_priority_reward: true,
  higher_priority_idle_watchlist: true,
  watch_requirement_completed: true,
  runtime_restart: true,
  target_changed: true,
  manual_watch: true,
  manual_tab_close: true,
  critical_failure: true,
};

export function emitHostCallbackError(
  emit: EventEmitter,
  platform: Platform,
  error: unknown,
  fallbackMessage: string,
): void {
  emit({
    category: "diagnostic",
    platform,
    level: "warn",
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

export function hasRecentManualWatchForClaims(
  settings: EngineSettings,
  state: SchedulerState,
  platform: Platform,
  now = Date.now(),
): boolean {
  const manualWatch = state.manualWatch?.[platform];
  return Boolean(
    settings.pauseOnManualWatch
    && manualWatch?.active
    && !isTimestampStale(manualWatch.checkedAt, MANUAL_WATCH_TTL_MS, now),
  );
}

export function farmingLifecycleEvents(previous: SchedulerState, next: SchedulerState): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    const before = farmingTarget(previous, platform);
    const after = farmingTarget(next, platform);
    const sameTarget = Boolean(
      before
      && after
      && before.campaign.id === after.campaign.id
      && before.reward.id === after.reward.id,
    );
    if (sameTarget) continue;

    if (before) {
      const updatedReward = next.campaigns[platform]
        .find((campaign) => campaign.id === before.campaign.id)
        ?.rewards.find((reward) => reward.id === before.reward.id);
      const reason = updatedReward?.status === "claimed" || updatedReward?.status === "claimable"
        ? "watch_requirement_completed"
        : farmingStopReason(next.sessions[platform]);
      events.push({
        category: "activity",
        platform,
        level: next.sessions[platform].status === "error" ? "error" : "info",
        code: "farming_stopped",
        data: {
          campaignId: before.campaign.id,
          campaignName: before.campaign.name,
          rewardId: before.reward.id,
          rewardName: before.reward.name,
          ...(before.reward.imageUrl ? { rewardImageUrl: before.reward.imageUrl } : {}),
          ...(before.campaign.url ? { campaignUrl: before.campaign.url } : {}),
          reason,
        },
      });
    }
    if (after) {
      events.push({
        category: "activity",
        platform,
        level: "info",
        code: "farming_started",
        data: {
          campaignId: after.campaign.id,
          campaignName: after.campaign.name,
          rewardId: after.reward.id,
          rewardName: after.reward.name,
          ...(after.reward.imageUrl ? { rewardImageUrl: after.reward.imageUrl } : {}),
          ...(after.campaign.url ? { campaignUrl: after.campaign.url } : {}),
          ...(after.session.channel ? { channel: after.session.channel.displayName ?? after.session.channel.username } : {}),
        },
      });
    } else if (!before) {
      const session = next.sessions[platform];
      const prior = previous.sessions[platform];
      const changed = session.status !== prior.status || session.message !== prior.message;
      const actionable = session.status === "error" || session.reasonCode === "manual_watch";
      if (changed && actionable) {
        const reason = farmingStopReason(session);
        events.push({
          category: "activity",
          platform,
          level: session.status === "error" ? "error" : "warn",
          code: "interruption",
          data: { reason, ...(session.message ? { detail: session.message } : {}) },
        });
      }
    }
  }
  return events;
}

export function farmingTarget(state: SchedulerState, platform: Platform): {
  session: WatchSession;
  campaign: DropCampaign;
  reward: DropReward;
} | undefined {
  const session = state.sessions[platform];
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = state.campaigns[platform].find((candidate) => candidate.id === session.campaignId);
  const reward = campaign?.rewards.find((candidate) => candidate.id === session.rewardId);
  return campaign && reward ? { session, campaign, reward } : undefined;
}

export function farmingStopReason(session: WatchSession): FarmingStopReason {
  const code = session.reasonCode;
  return code && isFarmingStopReason(code)
    ? code
    : session.status === "error" ? "platform_error" : "target_changed";
}

export function isFarmingStopReason(code: WatchReasonCode): code is FarmingStopReason {
  return Object.prototype.hasOwnProperty.call(FARMING_STOP_REASON_CODES, code);
}

export function hasEnabledPlatform(settings: EngineSettings): boolean {
  return (["twitch", "kick"] as Platform[]).some((platform) => settings.platform[platform].enabled);
}

export function platformLabel(platform: Platform): string {
  return platform === "twitch" ? "Twitch" : "Kick";
}
