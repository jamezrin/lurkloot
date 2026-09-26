import type { EngineSettings } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { isFarmingActive } from "@lurkloot/shared/settings";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundControllerDeps, ControllerCalls } from "./types";

// Settings that only decide the order campaigns are farmed in. Discovery does
// not read them, so saving one keeps the discovered campaigns and channels.
// Pins are the exception while "farm pinned only" is on: discovery then skips
// unpinned campaigns, so a new pin needs its channels found.
const RANKING_SETTING_KEYS = new Set(["priorityMode", "campaignPins"]);
const RANKING_PLATFORM_SETTING_KEYS = new Set(["favouriteCategories"]);

export function isRankingOnlyPatch(patch: SettingsPatch, current: Pick<EngineSettings, "farmPinnedOnly">): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return false;
  if ("campaignPins" in patch && current.farmPinnedOnly) return false;
  return keys.every((key) => {
    if (key !== "platform") return RANKING_SETTING_KEYS.has(key);
    return Object.values(patch.platform ?? {}).every((platformPatch) =>
      Object.keys(platformPatch ?? {}).every((platformKey) => RANKING_PLATFORM_SETTING_KEYS.has(platformKey)));
  });
}

// Settings commits and the transitions they start.
export function createSettingsTransitions<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { discoverySlice, settingsSlice }: Pick<ControllerSlices<S>, "discoverySlice" | "settingsSlice">,
  calls: Pick<ControllerCalls<S>,
    | "abortIneligibleClaimOnlyOperations"
    | "cancelPendingTick"
    | "ensureSchedulerAlarms"
    | "invalidateSelection"
    | "reconcileManualWatchClaimAlarms"
    | "reconcileTwitchChannelPointsAlarm"
  >,
): Pick<ControllerCalls<S>, "normalizeStartupSettings" | "withSettingsLock" | "updateStoredSettings"> {
  const {
    abortIneligibleClaimOnlyOperations,
    cancelPendingTick,
    ensureSchedulerAlarms,
    invalidateSelection,
    reconcileManualWatchClaimAlarms,
    reconcileTwitchChannelPointsAlarm,
  } = lateBound(calls);

  // On restart, autoStartDropFarming decides what happens to the platforms that
  // were farming: enabled means keep going, disabled means switch them off. It
  // used to clear a global `running` flag instead, which left the per-platform
  // flags set — so the popup showed everything off while a stale enabled flag
  // waited to resurrect a platform the moment the master switch came back.
  async function normalizeStartupSettings(): Promise<S> {
    return withSettingsLock(async () => {
      const settings = await deps.loadSettings();
      if (settings.autoStartDropFarming || !isFarmingActive(settings)) return settings;
      const nextSettings = {
        ...settings,
        platform: {
          ...settings.platform,
          twitch: { ...settings.platform.twitch, enabled: false },
          kick: { ...settings.platform.kick, enabled: false },
        },
      };
      await deps.saveSettings(nextSettings);
      await reconcileTwitchChannelPointsAlarm(nextSettings);
      await reconcileManualWatchClaimAlarms(nextSettings);
      return nextSettings;
    });
  }

  function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = settingsSlice.settingsMutation.then(operation, operation);
    settingsSlice.settingsMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  // `patch` may be worked out from the stored settings, inside the lock, for a
  // change that has to apply to the latest value rather than a caller's copy.
  async function updateStoredSettings(
    patchOrUpdate: SettingsPatch | ((current: S) => SettingsPatch),
    afterPersist?: (settings: S) => void,
    afterLoad?: (settings: S) => void,
  ): Promise<S> {
    return withSettingsLock(async () => {
      const patch = typeof patchOrUpdate === "function" ? patchOrUpdate(await deps.loadSettings()) : patchOrUpdate;
      const patchKeys = Object.keys(patch);
      const invalidatedPlatforms = patchKeys.every((key) => key === "platform") && patch.platform
        ? PLATFORMS.filter((platform) => patch.platform?.[platform] !== undefined)
        : PLATFORMS;
      const rankingOnly = isRankingOnlyPatch(patch, await deps.loadSettings());
      for (const platform of invalidatedPlatforms) {
        // Discovery does not depend on the ranking, so a reorder keeps it and
        // only the selection made from it is redone.
        if (!rankingOnly) discoverySlice.discoveryLanes[platform].invalidate();
        invalidateSelection(platform);
      }
      if (!deps.applySettingsPatch) {
        throw new Error("applySettingsPatch dependency is required to mutate settings");
      }
      const current = await deps.loadSettings();
      afterLoad?.(current);
      const settings = deps.applySettingsPatch(current, patch);
      abortIneligibleClaimOnlyOperations(settings, "Claim automation disabled");
      await deps.saveSettings(settings);
      for (const platform of invalidatedPlatforms) {
        if (!settings.platform[platform].enabled) cancelPendingTick(platform);
      }
      afterPersist?.(settings);
      await ensureSchedulerAlarms(settings.pollIntervalMinutes);
      await reconcileTwitchChannelPointsAlarm(settings);
      await reconcileManualWatchClaimAlarms(settings);
      return settings;
    });
  }

  return {
    normalizeStartupSettings,
    withSettingsLock,
    updateStoredSettings,
  };
}
