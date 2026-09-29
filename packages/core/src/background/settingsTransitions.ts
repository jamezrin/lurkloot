import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { isFarmingActive } from "@lurkloot/shared/settings";
import { type ControllerSlices, lateBound } from "./context";
import type { PreparedSettingsCommit, StateTransaction } from "./stateTransaction";
import type { ControllerCalls, SettingsCommitOptions } from "./types";

export { isRankingOnlyPatch } from "./stateTransaction";

// Settings commits and the transitions they start.
export function createSettingsTransitions<S extends EngineSettings>(
  transaction: StateTransaction<S>,
  { discoverySlice }: Pick<ControllerSlices<S>, "discoverySlice">,
  calls: Pick<ControllerCalls<S>,
    | "abortIneligibleClaimOnlyOperations"
    | "abortIneligibleKickChallengeClaims"
    | "abortIneligibleTwitchChannelPointsClaims"
    | "holdTwitchIntegrityForDisable"
    | "reconcileTwitchIntegrityAfterCommit"
    | "cancelPendingTick"
    | "invalidateSelection"
    | "rescheduleDropClaimJobs"
    | "rescheduleKickChallengeJob"
    | "rescheduleTickJobs"
    | "rescheduleTwitchChannelPointsJob"
    | "withSettingsLock"
  >,
): Pick<ControllerCalls<S>, "normalizeStartupSettings" | "commitSettings"> {
  const {
    abortIneligibleClaimOnlyOperations,
    abortIneligibleKickChallengeClaims,
    abortIneligibleTwitchChannelPointsClaims,
    holdTwitchIntegrityForDisable,
    reconcileTwitchIntegrityAfterCommit,
    cancelPendingTick,
    invalidateSelection,
    rescheduleDropClaimJobs,
    rescheduleKickChallengeJob,
    rescheduleTickJobs,
    rescheduleTwitchChannelPointsJob,
    withSettingsLock,
  } = lateBound(calls);

  // The jobs that follow the saved settings once the settings lock is
  // released: channel points and its push (#590), the drop-claim jobs (#597)
  // and the Kick challenge job (#588). Each runs even if another failed, and
  // the first failure is rethrown.
  async function rescheduleSettingsJobs(): Promise<void> {
    const results = await Promise.allSettled([
      rescheduleTwitchChannelPointsJob(),
      rescheduleDropClaimJobs(),
      rescheduleKickChallengeJob(),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  // On restart, autoStartDropFarming decides what happens to the platforms that
  // were farming: enabled means keep going, disabled means switch them off. It
  // used to clear a global `running` flag instead, which left the per-platform
  // flags set — so the popup showed everything off while a stale enabled flag
  // waited to resurrect a platform the moment the master switch came back.
  async function normalizeStartupSettings(): Promise<S> {
    let saved = false;
    try {
      return await withSettingsLock(async () => {
        let farming = false;
        const commit = await transaction.prepareSettingsCommit((settings) => {
          farming = !settings.autoStartDropFarming && isFarmingActive(settings);
          return farming
            ? { platform: { twitch: { enabled: false }, kick: { enabled: false } } }
            : {};
        }, (settings) => farming
          ? {
              ...settings,
              platform: {
                ...settings.platform,
                twitch: { ...settings.platform.twitch, enabled: false },
                kick: { ...settings.platform.kick, enabled: false },
              },
            }
          : settings);
        if (!farming) return commit.previous;
        const nextSettings = commit.settings;
        await transaction.saveSettingsCommit(commit);
        saved = true;
        return nextSettings;
      });
    } finally {
      if (saved) await rescheduleSettingsJobs();
    }
  }

  // Every settings write: `update` works out the patch from the stored
  // settings, read once inside the lock, so it applies to the latest value
  // rather than a caller's copy. The result carries each platform's effect, and
  // callers pick their tick trigger from it.
  async function commitSettings(
    update: (current: S) => SettingsPatch,
    { intent }: SettingsCommitOptions = {},
  ): Promise<PreparedSettingsCommit<S>> {
    let saved = false;
    let twitchEnabledChanged = false;
    // A save that disables Twitch holds off integrity work from as early as it
    // is known (#589) until the lifecycle has closed, or the save failed.
    let endTwitchIntegrityHold: (() => void) | undefined = intent?.platform?.twitch?.enabled === false
      ? holdTwitchIntegrityForDisable()
      : undefined;
    const releaseTwitchIntegrityHold = (): void => {
      endTwitchIntegrityHold?.();
    };
    try {
      const committed = await withSettingsLock(async () => {
        const commit = await transaction.prepareSettingsCommit(update);
        const invalidatedPlatforms = Object.keys(commit.effects) as Platform[];
        for (const platform of invalidatedPlatforms) {
          // Discovery does not depend on the ranking, so a reorder keeps it and
          // only the selection made from it is redone.
          if (commit.effects[platform] === "discovery") discoverySlice.discoveryLanes[platform].invalidate();
          invalidateSelection(platform);
        }
        const { settings } = commit;
        abortIneligibleClaimOnlyOperations(settings, "Claim automation disabled");
        abortIneligibleKickChallengeClaims(settings, "Claim automation disabled");
        abortIneligibleTwitchChannelPointsClaims(settings, "Channel points claiming disabled");
        twitchEnabledChanged = commit.previous.platform.twitch.enabled !== settings.platform.twitch.enabled;
        if (twitchEnabledChanged && !settings.platform.twitch.enabled) {
          endTwitchIntegrityHold ??= holdTwitchIntegrityForDisable();
        }
        await transaction.saveSettingsCommit(commit);
        saved = true;
        for (const platform of invalidatedPlatforms) {
          if (!settings.platform[platform].enabled) cancelPendingTick(platform);
        }
        return commit;
      });
      // The tick jobs follow the committed poll interval, rescheduled once the
      // settings lock is released (#593).
      await rescheduleTickJobs();
      return committed;
    } finally {
      // So do the settings jobs, even when the tick jobs' reschedule failed
      // after the save: disabling Twitch must still stop the push. They read
      // the latest stored settings.
      try {
        // A failed save ends its hold on integrity work before the reconcile.
        if (!saved) releaseTwitchIntegrityHold();
        if (saved) await rescheduleSettingsJobs();
        // Twitch integrity follows the stored enabled flag (#589), whichever
        // message saved it. A disable that failed to save reconciles too: it
        // held off integrity work while pending, and the stored flag, still
        // enabled, brings the schedule back. Nothing is rolled back.
        if (twitchEnabledChanged || (endTwitchIntegrityHold && !saved)) await reconcileTwitchIntegrityAfterCommit();
      } finally {
        // A disable admits no integrity work until its lifecycle has closed,
        // or until its save failed.
        releaseTwitchIntegrityHold();
      }
    }
  }

  return {
    normalizeStartupSettings,
    commitSettings,
  };
}
