import type { CoreRuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropReward, EngineSettings, Platform, SchedulerState, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import { claimReadyRewards, preserveClaimedRewards } from "../core/scheduler";
import { createRewardClaimGuard, type RewardClaimGuard } from "../core/rewardClaims";
import type { PlatformAdapter } from "../platforms/adapter";
import {
  KICK_DROP_CLAIMS_ALARM_NAME,
  PLATFORMS,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
} from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundJob } from "./jobs";
import type { TickEffectExecutor } from "./tickEffects";
import { pausedForManualWatch } from "../core/manualWatch";
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

// The drop-claim jobs claim for a manually watched tab, which needs browser
// tabs; elsewhere the tick claims.
export const DROP_CLAIM_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [TWITCH_DROP_CLAIMS_ALARM_NAME]: { run: (runner) => runner.runDropClaims("twitch"), requires: "browserTabs" },
  [KICK_DROP_CLAIMS_ALARM_NAME]: { run: (runner) => runner.runDropClaims("kick"), requires: "browserTabs" },
};

const DROP_CLAIM_JOB_NAMES: Record<Platform, string> = {
  twitch: TWITCH_DROP_CLAIMS_ALARM_NAME,
  kick: KICK_DROP_CLAIMS_ALARM_NAME,
};

// The reward-claim effect a scheduler tick plans (#599). This is its only
// handler, and it shares `guards` with the drop-claim job and manual claims.
export function registerRewardClaimEffect(
  executor: TickEffectExecutor,
  guards: Partial<Record<Platform, RewardClaimGuard>>,
): TickEffectExecutor {
  return executor.register("claimRewards", async ({ platform, campaigns, waitingRewardIds }, context) => {
    const adapter = context.adapters[platform];
    if (!adapter) throw new Error(`No ${platform} adapter for the scheduler effect`);
    return await claimReadyRewards(adapter, campaigns, waitingRewardIds, context.signal, guards[platform]);
  });
}

// Marks one claimed reward in `state`, if its campaign is still there.
function withManualClaim(state: SchedulerState, platform: Platform, campaignId: string, rewardId: string): SchedulerState {
  return {
    ...state,
    campaigns: {
      ...state.campaigns,
      [platform]: state.campaigns[platform].map((item) => {
        if (item.id !== campaignId) return item;
        const rewards = item.rewards.map((candidate) => candidate.id === rewardId
          ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
          : candidate);
        return reconcileCampaignAfterClaims(item, rewards);
      }),
    },
  };
}

// The claim service (#597): the reward-claim effect, the drop-claim jobs, the
// post-claim handoff and manual claims, with the in-flight state they share.
// Every claim request runs with no lock held; only its result is committed,
// onto the latest state.
export function createClaimService<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
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
  | "clearDropClaimJobsBestEffort"
  | "reconcileDropClaimJobs"
  | "rescheduleDropClaimJobs"
  | "registerRewardClaimEffects"
  | "waitingClaimRewardIds"
  | "recordWaitingClaimRewardIds"
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
  // In-flight post-claim handoffs, one per platform. A claim arriving while a
  // handoff is already running for that platform is absorbed by the running
  // loop rather than starting a second one, which is what keeps the work
  // bounded. These loops coordinate only with each other.
  const claimHandoffs = new Map<Platform, AbortController>();
  // Rewards watched to completion whose claim the platform has not released
  // yet, as of the last committed tick.
  const waitingRewardIds: Record<Platform, Set<string>> = { twitch: new Set(), kick: new Set() };
  // The drop-claim job's runs in flight. Disable, reset and shutdown abort them.
  const dropClaimOperations: Record<Platform, Set<AbortController>> = { twitch: new Set(), kick: new Set() };
  // One claim request per reward at a time, across the tick, the drop-claim
  // job and manual claims.
  const rewardClaimGuards: Record<Platform, RewardClaimGuard> = {
    twitch: createRewardClaimGuard(),
    kick: createRewardClaimGuard(),
  };
  let jobReschedule: Promise<void> = Promise.resolve();

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

  async function clearDropClaimJobsBestEffort(): Promise<void> {
    await Promise.all(PLATFORMS.map((platform) => DROP_CLAIM_JOB_NAMES[platform]).map(async (name) => {
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

  async function reconcileDropClaimJobs(settings: EngineSettings): Promise<void> {
    await Promise.all(PLATFORMS.map((platform) => settings.platform[platform].enabled && settings.autoClaim
      ? ports.jobs.ensure(DROP_CLAIM_JOB_NAMES[platform], { periodInMinutes: settings.pollIntervalMinutes })
      : ports.jobs.cancel(DROP_CLAIM_JOB_NAMES[platform])));
  }

  // After a settings commit, with the settings lock released. Runs are
  // serialized and each reads the latest stored settings, so commits that
  // finish out of order still leave the jobs matching the last one.
  function rescheduleDropClaimJobs(): Promise<void> {
    const run = jobReschedule.then(async () => {
      if (lifecycleSlice.controllerShutdown) return;
      await reconcileDropClaimJobs(await ports.storage.loadSettings());
    });
    jobReschedule = run.catch(() => undefined);
    return run;
  }

  function registerRewardClaimEffects(executor: TickEffectExecutor): TickEffectExecutor {
    return registerRewardClaimEffect(executor, rewardClaimGuards);
  }

  // The tick claims from a copy and records it back only when it commits.
  function waitingClaimRewardIds(): Record<Platform, Set<string>> {
    return { twitch: new Set(waitingRewardIds.twitch), kick: new Set(waitingRewardIds.kick) };
  }

  function recordWaitingClaimRewardIds(platform: Platform, rewardIds: ReadonlySet<string>): void {
    waitingRewardIds[platform].clear();
    for (const rewardId of rewardIds) waitingRewardIds[platform].add(rewardId);
  }

  function abortIneligibleClaimOnlyOperations(settings: EngineSettings, reason: string): void {
    for (const platform of PLATFORMS) {
      if (settings.platform[platform].enabled && settings.autoClaim) continue;
      for (const controller of dropClaimOperations[platform]) controller.abort(new Error(reason));
    }
  }

  function abortClaimOnlyOperations(reason: string): void {
    for (const platform of PLATFORMS) {
      for (const controller of dropClaimOperations[platform]) controller.abort(new Error(reason));
    }
  }

  // Aborts every in-flight handoff. Called when farming stops, when a settings
  // session begins, and on runtime restart.
  // Scoped when a single platform is switched off: with per-platform toggles,
  // cancelling every handoff would abort work the other platform still needs.
  function abortClaimHandoffs(platform?: Platform): void {
    for (const [handoffPlatform, controller] of claimHandoffs) {
      if (platform && handoffPlatform !== platform) continue;
      controller.abort();
      claimHandoffs.delete(handoffPlatform);
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
    if (claimHandoffs.has(platform)) return;
    // Reserved synchronously, before the first await. Registering after the
    // async setup would let two triggers past the guard into concurrent loops,
    // and would let an abortClaimHandoffs() landing mid-setup miss this handoff
    // entirely.
    const abort = new AbortController();
    claimHandoffs.set(platform, abort);

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
      if (claimHandoffs.get(platform) === abort) claimHandoffs.delete(platform);
    }
  }

  async function claimRewardNow(
    message: Extract<CoreRuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot<S>> {
    // The claim request runs with no lock held (#597). Only the claimed reward
    // is committed, under the platform lock, onto the latest state.
    let claimedManually = false;
    await withEventCollector(async (emit, events) => {
      // Read under the lock, so a tick still committing a claim of this reward
      // is waited for rather than read as claimable. The lock is released
      // before the request is sent.
      const [settings, state] = await withStateLock(
        () => Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]),
        [message.platform],
      );
      const campaign = state.campaigns[message.platform].find((item) => item.id === message.campaignId);
      const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

      if (!campaign || !reward) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: "Reward claim skipped because the campaign or reward is no longer available",
        });
        await reportBestEffort(events);
        return;
      }

      if (!canClaimReward(reward)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        });
        await reportBestEffort(events);
        return;
      }

      // The tick and the drop-claim job claim with no lock held too: the same
      // reward may be in flight there.
      const guard = rewardClaimGuards[message.platform];
      if (!guard.reserve(reward.id)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is already being claimed`,
        });
        await reportBestEffort(events);
        return;
      }
      try {
        const adapter = createAdapters(settings, emit)[message.platform];
        let claimed: boolean;
        try {
          claimed = await adapter.claimReward(campaign, reward);
        } finally {
          adapter.flushRouteDiagnostics?.(emit);
        }
        claimedManually = claimed;
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
        await reportBestEffort(events);
        return;
      } finally {
        guard.release(reward.id);
      }
      if (!claimedManually) {
        await reportBestEffort(events);
        return;
      }
      await withStateLock(async () => {
        const latest = await ports.storage.loadState();
        await persistPlatformAndReport(
          message.platform,
          withManualClaim(latest, message.platform, campaign.id, reward.id),
          events,
        );
      }, [message.platform]);
    });
    if (claimedManually) await runClaimHandoff(message.platform, [message.rewardId]);
    return snapshot();
  }

  // The drop-claim job claims while the user watches by hand, which pauses the
  // tick. It refreshes and claims with no lock held (#597), then commits the
  // refreshed campaigns onto the latest state, keeping any claim committed
  // meanwhile.
  async function runDropClaims(platform: Platform): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    // A fire while this platform's job still runs adds nothing to it.
    if (dropClaimOperations[platform].size > 0) return;
    const operation = new AbortController();
    dropClaimOperations[platform].add(operation);
    try {
      await withEventCollector(async (emit, events) => {
        let adapter: PlatformAdapter | undefined;
        try {
          operation.signal.throwIfAborted();
          // Read under the lock, like a manual claim, so a claim being
          // committed is waited for; the requests run once it is released.
          const [settings, state] = await withStateLock(
            () => Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]),
            [platform],
          );
          operation.signal.throwIfAborted();
          if (lifecycleSlice.controllerShutdown
            || !settings.platform[platform].enabled
            || !settings.autoClaim
            || state.authHealth[platform].status !== "healthy"
            || !pausedForManualWatch(settings, state, platform)) return;

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
            waitingRewardIds[platform],
            operation.signal,
            rewardClaimGuards[platform],
          );
          operation.signal.throwIfAborted();
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
          const committed = await withStateLock(async () => {
            const latest = await ports.storage.loadState();
            const next: SchedulerState = {
              ...latest,
              campaigns: {
                ...latest.campaigns,
                [platform]: preserveClaimedRewards(claimResult.campaigns, latest.campaigns[platform]),
              },
            };
            const persisted = await persistPlatformState(platform, next, () => !operation.signal.aborted);
            return persisted ? { latest, next } : undefined;
          }, [platform]);
          operation.signal.throwIfAborted();
          if (!committed) return;
          await emitNotifications(settings, committed.latest, committed.next, events);
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
      });
    } finally {
      dropClaimOperations[platform].delete(operation);
    }
  }

  return {
    clearDropClaimJobsBestEffort,
    reconcileDropClaimJobs,
    rescheduleDropClaimJobs,
    registerRewardClaimEffects,
    waitingClaimRewardIds,
    recordWaitingClaimRewardIds,
    abortIneligibleClaimOnlyOperations,
    abortClaimOnlyOperations,
    abortClaimHandoffs,
    runClaimHandoff,
    claimRewardNow,
    runDropClaims,
  };
}
