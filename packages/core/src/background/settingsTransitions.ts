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
    | "cancelPendingTick"
    | "invalidateSelection"
    | "reconcileManualWatchClaimAlarms"
    | "reconcileTwitchChannelPointsAlarm"
    | "rescheduleTickJobs"
    | "withSettingsLock"
  >,
): Pick<ControllerCalls<S>, "normalizeStartupSettings" | "commitSettings"> {
  const {
    abortIneligibleClaimOnlyOperations,
    cancelPendingTick,
    invalidateSelection,
    reconcileManualWatchClaimAlarms,
    reconcileTwitchChannelPointsAlarm,
    rescheduleTickJobs,
    withSettingsLock,
  } = lateBound(calls);

  // On restart, autoStartDropFarming decides what happens to the platforms that
  // were farming: enabled means keep going, disabled means switch them off. It
  // used to clear a global `running` flag instead, which left the per-platform
  // flags set — so the popup showed everything off while a stale enabled flag
  // waited to resurrect a platform the moment the master switch came back.
  async function normalizeStartupSettings(): Promise<S> {
    return withSettingsLock(async () => {
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
      await reconcileTwitchChannelPointsAlarm(nextSettings);
      await reconcileManualWatchClaimAlarms(nextSettings);
      return nextSettings;
    });
  }

  // Every settings write: `update` works out the patch from the stored
  // settings, read once inside the lock, so it applies to the latest value
  // rather than a caller's copy. The result carries each platform's effect, and
  // callers pick their tick trigger from it.
  async function commitSettings(
    update: (current: S) => SettingsPatch,
    { afterLoad, afterPersist }: SettingsCommitOptions<S> = {},
  ): Promise<PreparedSettingsCommit<S>> {
    const committed = await withSettingsLock(async () => {
      const commit = await transaction.prepareSettingsCommit(update);
      const invalidatedPlatforms = Object.keys(commit.effects) as Platform[];
      for (const platform of invalidatedPlatforms) {
        // Discovery does not depend on the ranking, so a reorder keeps it and
        // only the selection made from it is redone.
        if (commit.effects[platform] === "discovery") discoverySlice.discoveryLanes[platform].invalidate();
        invalidateSelection(platform);
      }
      afterLoad?.(commit.previous);
      const { settings } = commit;
      abortIneligibleClaimOnlyOperations(settings, "Claim automation disabled");
      await transaction.saveSettingsCommit(commit);
      for (const platform of invalidatedPlatforms) {
        if (!settings.platform[platform].enabled) cancelPendingTick(platform);
      }
      afterPersist?.(settings);
      await reconcileTwitchChannelPointsAlarm(settings);
      await reconcileManualWatchClaimAlarms(settings);
      return commit;
    });
    // The tick jobs follow the committed poll interval, rescheduled once the
    // settings lock is released (#593).
    await rescheduleTickJobs();
    return committed;
  }

  return {
    normalizeStartupSettings,
    commitSettings,
  };
}
