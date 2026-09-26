import type { CoreRuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropReward, EngineSettings, Platform, SchedulerState, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { autoClaimChallengesFor } from "@lurkloot/shared/settings";
import { reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import { CHALLENGE_POLL_INTERVAL_MS, claimReadyRewards, preserveClaimedRewards } from "../core/scheduler";
import type { PlatformAdapter } from "../platforms/adapter";
import {
  KICK_CHALLENGES_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  PLATFORMS,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
} from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { hasRecentManualWatchForClaims } from "./helpers";
import type { BackgroundHostPorts, TestingPorts } from "./hostPorts";
import type { ControllerCalls } from "./types";

// Reasons a refreshed platform has nothing left to farm. Reaching one of these
// means further refreshes would return the same answer, so the post-claim
// handoff stops instead of spending the rest of its budget.
const NOTHING_LEFT_REASON_CODES: WatchReasonCode[] = ["campaign_ineligible", "no_eligible_channel"];
function isNothingLeftToFarm(reasonCode: WatchReasonCode | undefined): boolean {
  return reasonCode != null && NOTHING_LEFT_REASON_CODES.includes(reasonCode);
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

// Drop claims, manual claims, claim handoffs and the manual-watch claim jobs.
export function createClaims<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { kickChallengeSlice, claimSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "kickChallengeSlice" | "claimSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "clearOperationalEvents"
    | "createAdapter"
    | "createAdapters"
    | "emitNotifications"
    | "persistPlatformAndReport"
    | "persistPlatformState"
    | "reportBestEffort"
    | "requestPlatformHeartbeat"
    | "safeNotify"
    | "snapshot"
    | "tick"
    | "tr"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "clearManualWatchClaimAlarmsBestEffort"
  | "reconcileManualWatchClaimAlarms"
  | "abortIneligibleClaimOnlyOperations"
  | "abortClaimOnlyOperations"
  | "abortClaimHandoffs"
  | "runClaimHandoff"
  | "claimRewardNow"
  | "runDropClaims"
> {
  const {
    clearOperationalEvents,
    createAdapter,
    createAdapters,
    emitNotifications,
    persistPlatformAndReport,
    persistPlatformState,
    reportBestEffort,
    requestPlatformHeartbeat,
    safeNotify,
    snapshot,
    tick,
    tr,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);

  const wait: NonNullable<TestingPorts["wait"]> = ports.testing?.wait ?? ((ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }));

  async function clearManualWatchClaimAlarmsBestEffort(): Promise<void> {
    await Promise.all([
      TWITCH_DROP_CLAIMS_ALARM_NAME,
      KICK_DROP_CLAIMS_ALARM_NAME,
      KICK_CHALLENGES_ALARM_NAME,
    ].map(async (name) => {
      try {
        await ports.jobs.cancel(name);
      } catch {
        await reportBestEffort([{
          category: "diagnostic",
          level: "warn",
          message: `Could not clear the ${name} alarm`,
        }]);
      }
    }));
  }

  async function reconcileManualWatchClaimAlarms(settings: EngineSettings): Promise<void> {
    await Promise.all([
      settings.platform.twitch.enabled && settings.autoClaim
        ? ports.jobs.ensure(TWITCH_DROP_CLAIMS_ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes })
        : ports.jobs.cancel(TWITCH_DROP_CLAIMS_ALARM_NAME),
      settings.platform.kick.enabled && settings.autoClaim
        ? ports.jobs.ensure(KICK_DROP_CLAIMS_ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes })
        : ports.jobs.cancel(KICK_DROP_CLAIMS_ALARM_NAME),
      settings.platform.kick.enabled && autoClaimChallengesFor(settings, "kick")
        ? ports.jobs.ensure(KICK_CHALLENGES_ALARM_NAME, { periodInMinutes: CHALLENGE_POLL_INTERVAL_MS / 60_000 })
        : ports.jobs.cancel(KICK_CHALLENGES_ALARM_NAME),
    ]);
  }

  function abortIneligibleClaimOnlyOperations(settings: EngineSettings, reason: string): void {
    for (const platform of PLATFORMS) {
      if (settings.platform[platform].enabled && settings.autoClaim) continue;
      for (const controller of claimSlice.dropClaimOperations[platform]) controller.abort(new Error(reason));
    }
    if (!settings.platform.kick.enabled || !autoClaimChallengesFor(settings, "kick")) {
      for (const controller of kickChallengeSlice.kickChallengeClaimOperations) controller.abort(new Error(reason));
    }
  }

  function abortClaimOnlyOperations(reason: string): void {
    for (const platform of PLATFORMS) {
      for (const controller of claimSlice.dropClaimOperations[platform]) controller.abort(new Error(reason));
    }
    for (const controller of kickChallengeSlice.kickChallengeClaimOperations) controller.abort(new Error(reason));
  }

  // Aborts every in-flight handoff. Called when farming stops, when a settings
  // session begins, and on runtime restart.
  // Scoped when a single platform is switched off: with per-platform toggles,
  // cancelling every handoff would abort work the other platform still needs.
  function abortClaimHandoffs(platform?: Platform): void {
    for (const [handoffPlatform, controller] of claimSlice.claimHandoffs) {
      if (platform && handoffPlatform !== platform) continue;
      controller.abort();
      claimSlice.claimHandoffs.delete(handoffPlatform);
    }
  }

  // Bounded post-claim handoff (see docs/superpowers/specs/2026-07-19-twitch-claim-handoff-design.md).
  // Re-runs a scoped tick on the configured cadence until the platform lands on
  // a reward other than the ones just claimed, then hands off to the immediate
  // heartbeat. Runs OUTSIDE the state lock: each inner tick() acquires the lock
  // on its own, so a long handoff never blocks telemetry or user actions.
  async function runClaimHandoff(
    platform: Platform,
    justClaimedRewardIds: readonly string[] = [],
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<void> {
    if (claimSlice.claimHandoffs.has(platform)) return;
    // Reserved synchronously, before the first await. Registering after the
    // async setup would let two triggers past the guard into concurrent loops,
    // and would let an abortClaimHandoffs() landing mid-setup miss this handoff
    // entirely.
    const abort = new AbortController();
    claimSlice.claimHandoffs.set(platform, abort);

    try {
      const settings = await ports.storage.loadSettings();
      if (abort.signal.aborted) return;
      if (!settings.postClaimHandoff) return;
      if (!settings.platform[platform].enabled) return;

      // Deliberately bypasses the createAdapters() wrapper: that records every
      // compatibility diagnostic it emits into the dedup caches, so probing
      // through it with a no-op emit would mark a diagnostic as "already
      // reported" without it ever reaching a sink, permanently suppressing it on
      // the next genuine tick. This is a capability lookup, not a reporting
      // context; the handoff's own tick() reports normally.
      const { adapters } = ports.adapters.createAdapters(() => undefined, settings);
      if (!adapters[platform].supportsPostClaimHandoff) return;

      const claimed = new Set(justClaimedRewardIds);
      // A session is a successful handoff target when it is watching a reward
      // other than the ones just claimed.
      const isSuccessor = (session: WatchSession): boolean =>
        session.status === "watching" && session.rewardId != null && !claimed.has(session.rewardId);

      // The triggering tick may already have found the successor, in which case
      // there is nothing to poll for — only a heartbeat to bring forward.
      const before = await ports.storage.loadState();
      if (abort.signal.aborted) return;
      if (isSuccessor(before.sessions[platform])) {
        await requestPlatformHeartbeat(platform, settings, "immediate", before.sessions[platform]);
        return;
      }

      // The deadline is computed once. A claim occurring inside the loop never
      // extends it, so the worst case stays fixed at maxSeconds.
      const deadline = Date.now() + settings.postClaimHandoffMaxSeconds * 1000;
      const intervalMs = settings.postClaimHandoffIntervalSeconds * 1000;

      while (!abort.signal.aborted && Date.now() < deadline) {
        // Capped at the remaining budget, so an interval longer than what is
        // left cannot push a refresh past the deadline.
        await wait(Math.min(intervalMs, deadline - Date.now()), abort.signal);
        if (abort.signal.aborted || Date.now() >= deadline) break;

        await tick([platform], "claim_handoff", onPersisted);
        if (abort.signal.aborted) break;

        const session = (await ports.storage.loadState()).sessions[platform];
        // Re-checked after the load: a cancellation during it must not still
        // transmit.
        if (abort.signal.aborted) break;
        if (isSuccessor(session)) {
          await requestPlatformHeartbeat(platform, settings, "immediate", session);
          return;
        }
        // Nothing eligible left on this platform: the chain is finished, so stop
        // rather than burning the rest of the budget on identical refreshes.
        if (session.status !== "watching" && isNothingLeftToFarm(session.reasonCode)) return;
      }
    } finally {
      if (claimSlice.claimHandoffs.get(platform) === abort) claimSlice.claimHandoffs.delete(platform);
    }
  }

  async function claimRewardNow(
    message: Extract<CoreRuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot<S>> {
    // Hold the owning platform lock across the whole load→persist so a concurrent
    // same-platform tick or telemetry write can't clobber the claimed-reward
    // update. The short commit merges this slice with any sibling-platform write.
    let claimedManually = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
      const campaigns = state.campaigns[message.platform];
      const campaign = campaigns.find((item) => item.id === message.campaignId);
      const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

      if (!campaign || !reward) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: "Reward claim skipped because the campaign or reward is no longer available",
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }

      if (!canClaimReward(reward)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }

      let stateWithCampaigns: SchedulerState;
      try {
        const adapter = createAdapters(settings, emit)[message.platform];
        let claimed: boolean;
        try {
          claimed = await adapter.claimReward(campaign, reward);
        } finally {
          adapter.flushRouteDiagnostics?.(emit);
        }
        claimedManually = claimed;
        const nextCampaigns = campaigns.map((item) => {
          if (item.id !== campaign.id) return item;
          const rewards = item.rewards.map((candidate) => candidate.id === reward.id && claimed
            ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
            : candidate);
          return reconcileCampaignAfterClaims(item, rewards);
        });
        stateWithCampaigns = {
          ...state,
          campaigns: {
            ...state.campaigns,
            [message.platform]: nextCampaigns,
          },
        };
        const claimEvent: EngineEvent = claimed
          ? {
            category: "activity",
            platform: message.platform,
            level: "info",
            code: "reward_claimed",
            data: {
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
              ...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
              ...(campaign.url ? { campaignUrl: campaign.url } : {}),
              method: "manual",
            },
          }
          : {
            category: "diagnostic",
            platform: message.platform,
            level: "warn",
            message: `Could not claim ${reward.name} from ${campaign.name}`,
          };
        emit(claimEvent);
        if (claimed && settings.notifyRewardEarned) {
          await safeNotify(
            await tr("notificationRewardClaimed"),
            await tr("notificationRewardFromCampaign", [reward.name, campaign.name]),
          );
        }
      } catch (error) {
        clearOperationalEvents(events);
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "error",
          message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
        });
        await persistPlatformAndReport(message.platform, state, events);
        return;
      }
      await persistPlatformAndReport(message.platform, stateWithCampaigns, events);
    }), [message.platform]);
    // Outside the lock: runClaimHandoff ticks, which takes the lock itself.
    if (claimedManually) await runClaimHandoff(message.platform, [message.rewardId]);
    return snapshot();
  }

  async function runDropClaims(platform: Platform): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const operation = new AbortController();
    claimSlice.dropClaimOperations[platform].add(operation);
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (lifecycleSlice.controllerShutdown) return;
        let adapter: PlatformAdapter | undefined;
        try {
          operation.signal.throwIfAborted();
          const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
          operation.signal.throwIfAborted();
          if (!settings.platform[platform].enabled
            || !settings.autoClaim
            || state.authHealth[platform].status !== "healthy"
            || !hasRecentManualWatchForClaims(settings, state, platform)) return;

          adapter = createAdapter(platform, settings, emit, true);
          const refreshed = await adapter.refreshCampaigns(state.sessions[platform], {
            signal: operation.signal,
            requireComplete: true,
          });
          operation.signal.throwIfAborted();
          const campaigns = preserveClaimedRewards(refreshed, state.campaigns[platform]);
          const claimResult = await claimReadyRewards(
            adapter,
            campaigns,
            claimSlice.waitingClaimRewardIds[platform],
            operation.signal,
          );
          operation.signal.throwIfAborted();
          const nextState: SchedulerState = {
            ...state,
            campaigns: {
              ...state.campaigns,
              [platform]: claimResult.campaigns,
            },
          };
          for (const event of claimResult.events) {
            if (event.claimed) {
              emit({
                category: "activity",
                platform,
                level: "info",
                code: "reward_claimed",
                data: {
                  campaignId: event.campaignId,
                  campaignName: event.campaignName,
                  rewardId: event.rewardId,
                  rewardName: event.rewardName,
                  ...(event.rewardImageUrl ? { rewardImageUrl: event.rewardImageUrl } : {}),
                  ...(event.campaignUrl ? { campaignUrl: event.campaignUrl } : {}),
                  method: "automatic",
                },
              });
            } else {
              emit({ category: "diagnostic", platform, level: event.level, message: event.message });
            }
          }
          operation.signal.throwIfAborted();
          adapter.flushRouteDiagnostics?.(emit);
          await persistPlatformState(platform, nextState, () => !operation.signal.aborted);
          operation.signal.throwIfAborted();
          await emitNotifications(settings, state, nextState, events);
          await reportBestEffort(events);
        } catch (error) {
          adapter?.flushRouteDiagnostics?.(emit);
          clearOperationalEvents(events);
          if (operation.signal.aborted) return;
          emit({
            category: "diagnostic",
            platform,
            level: "warn",
            message: error instanceof Error ? error.message : "Drop claim refresh failed",
          });
          await reportBestEffort(events);
        }
      }), [platform]);
    } finally {
      claimSlice.dropClaimOperations[platform].delete(operation);
    }
  }

  return {
    clearManualWatchClaimAlarmsBestEffort,
    reconcileManualWatchClaimAlarms,
    abortIneligibleClaimOnlyOperations,
    abortClaimOnlyOperations,
    abortClaimHandoffs,
    runClaimHandoff,
    claimRewardNow,
    runDropClaims,
  };
}
