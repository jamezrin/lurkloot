import type { CoreRuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { IDLE_WATCHLIST_LIMIT, isFarmingActive } from "@lurkloot/shared/settings";
import { settingsTickTrigger } from "./helpers";
import { type ControllerSlices, lateBound } from "./context";
import type { PreparedSettingsCommit, StateTransaction } from "./stateTransaction";
import type { ControllerCalls, SettingsCommitOptions } from "./types";

export { isRankingOnlyPatch } from "./stateTransaction";

// Settings commits and the transitions they start.
export function createSettingsTransitions<S extends EngineSettings>(
  transaction: StateTransaction<S>,
  { settingsSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "settingsSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "holdTwitchIntegrityForDisable"
    | "reconcileTwitchIntegrityAfterCommit"
    | "cancelPendingTick"
    | "invalidateDiscoveryLane"
    | "invalidateSelection"
    | "rescheduleDropClaimJobs"
    | "rescheduleKickChallengeJob"
    | "rescheduleTickJobs"
    | "rescheduleTwitchChannelPointsJob"
    | "withSettingsLock"
    | "diagnosticEvent"
    | "markPlatformsStarting"
    | "platformTickRunning"
    | "settleCommitHooks"
    | "snapshot"
    | "tickInBackground"
  >,
): Pick<ControllerCalls<S>,
  | "normalizeStartupSettings"
  | "commitSettings"
  | "beginTwitchSettingsTransition"
  | "invalidateTwitchSettingsTransitions"
  | "currentTwitchSettingsTransition"
  | "setPlatformEnabled"
  | "saveSettingsFromMessage"
  | "updateIdleWatchlist"
> {
  const {
    holdTwitchIntegrityForDisable,
    reconcileTwitchIntegrityAfterCommit,
    cancelPendingTick,
    invalidateDiscoveryLane,
    invalidateSelection,
    rescheduleDropClaimJobs,
    rescheduleKickChallengeJob,
    rescheduleTickJobs,
    rescheduleTwitchChannelPointsJob,
    withSettingsLock,
    diagnosticEvent,
    markPlatformsStarting,
    platformTickRunning,
    settleCommitHooks,
    snapshot,
    tickInBackground,
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
        // Startup is the lifecycle's: no service reacts to this save.
        await transaction.saveSettingsCommit(commit, { startup: true });
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
  //
  // The services that depend on settings react to the save through their own
  // commit hooks (docs/architecture.md, "Engine ownership at a glance"): claim
  // aborts and the platform switch's handoff and observer stops. What stays
  // here runs in the lock, before the save is visible, and is documented there
  // as an exception: discovery and selection invalidation, pending-tick
  // cancellation, and (until #696) the Twitch integrity hold and reconcile.
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
          if (commit.effects[platform] === "discovery") invalidateDiscoveryLane(platform);
          invalidateSelection(platform);
        }
        const { settings } = commit;
        twitchEnabledChanged = commit.previous.platform.twitch.enabled !== settings.platform.twitch.enabled;
        if (twitchEnabledChanged && !settings.platform.twitch.enabled) {
          endTwitchIntegrityHold ??= holdTwitchIntegrityForDisable();
        }
        await transaction.saveSettingsCommit(commit);
        saved = true;
        // Before the lock is released, so it never discards a trigger requested
        // after the save, such as the platform switch's own follow-up tick.
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

  // A Twitch enable or disable in progress. Starting one, shutdown or a reset
  // supersedes every earlier one; the returned check says whether this one is
  // still the latest.
  function beginTwitchSettingsTransition(): () => boolean {
    const generation = ++settingsSlice.twitchSettingsTransitionGeneration;
    return () => generation === settingsSlice.twitchSettingsTransitionGeneration;
  }

  function invalidateTwitchSettingsTransitions(): void {
    settingsSlice.twitchSettingsTransitionGeneration += 1;
  }

  // The latest Twitch transition, for work that must not outlive it.
  function currentTwitchSettingsTransition(): number {
    return settingsSlice.twitchSettingsTransitionGeneration;
  }

  // The popup's platform switch (#591: moved here from messages.ts). The
  // setPlatformEnabled and setAutomation messages are the same operation now
  // that there is no master switch to flip alongside the platform flag. Both are
  // kept: they are separate wire messages with existing callers.
  async function setPlatformEnabled(
    message: Extract<CoreRuntimeMessage, { type: "setPlatformEnabled" | "setAutomation" }>,
  ): Promise<RuntimeSnapshot<S>> {
    const platformLabel = message.platform === "twitch" ? "Twitch" : "Kick";
    const action = message.enabled ? "enable" : "disable";
    diagnosticEvent("info", `User requested ${platformLabel} automation ${action}`, message.platform);
    if (platformTickRunning(message.platform)) {
      diagnosticEvent(
        "info",
        `${platformLabel} automation ${action} queued behind an active tick`,
        message.platform,
      );
    }
    const twitchTransition = message.platform === "twitch" ? beginTwitchSettingsTransition() : undefined;
    const twitchTransitionIsCurrent = (): boolean =>
      !lifecycleSlice.controllerShutdown && twitchTransition?.() === true;
    // Twitch integrity follows the committed setting on its own (#589): the
    // commit cancels a mint in flight when it disables Twitch, and the
    // integrity service reconciles its lifecycle and schedule after it.
    // Stopping also ends the platform's post-claim handoff and blocks and
    // stops its discovery-signal observer, through those services' own hooks.
    // commitSettings does not wait for them (see there); the follow-up tick
    // below does.
    const patch: SettingsPatch = { platform: { [message.platform]: { enabled: message.enabled } } };
    await commitSettings(() => patch, { intent: patch });
    if (message.platform === "twitch" && !twitchTransitionIsCurrent()) return snapshot();
    if (message.enabled) {
      await markPlatformsStarting(
        [message.platform],
        message.platform === "twitch"
          ? twitchTransitionIsCurrent
          : undefined,
      );
      if (message.platform === "twitch" && !twitchTransitionIsCurrent()) {
        return snapshot();
      }
    }
    // The follow-up tick reconciles the observer, so the switch's hooks must
    // have run: otherwise a disable still stopping it leaves the platform
    // blocked, and the observer only starts a tick later.
    await settleCommitHooks([message.platform]);
    // Always scoped to the toggled platform. Nothing about this change can
    // affect the other one any more, so it is never dragged through this
    // platform's discovery.
    tickInBackground(
      [message.platform],
      message.type === "setAutomation" ? "automation_toggle" : "platform_toggle",
      () => diagnosticEvent("info", `${platformLabel} automation ${action} completed`, message.platform),
    );
    return snapshot();
  }

  async function saveSettingsFromMessage(
    message: Extract<CoreRuntimeMessage, { type: "saveSettings" }>,
  ): Promise<RuntimeSnapshot<S>> {
    const { settings, effects } = await commitSettings(() => message.settingsPatch);
    if (message.tickAfterSave && isFarmingActive(settings)) {
      tickInBackground(message.tickAfterSavePlatforms, settingsTickTrigger(effects));
    }
    return snapshot();
  }

  // One channel added to or removed from an Idle Watchlist, applied to the list
  // as it is stored at save time.
  async function updateIdleWatchlist(
    message: Extract<CoreRuntimeMessage, { type: "updateIdleWatchlist" }>,
  ): Promise<RuntimeSnapshot<S>> {
    const channel = message.channel.trim().replace(/^@/, "").toLowerCase();
    const commit = channel ? await commitSettings((current) => {
      const listed = current.platform[message.platform].idleWatchlistChannels;
      const present = listed.some((entry) => entry.toLowerCase() === channel);
      const next = message.action === "remove"
        ? listed.filter((entry) => entry.toLowerCase() !== channel)
        : present || listed.length >= IDLE_WATCHLIST_LIMIT ? listed : [...listed, channel];
      return { platform: { [message.platform]: { idleWatchlistChannels: next } } };
    }) : undefined;
    if (commit && isFarmingActive(commit.settings)) {
      tickInBackground([message.platform], settingsTickTrigger(commit.effects));
    }
    return snapshot();
  }

  return {
    setPlatformEnabled,
    saveSettingsFromMessage,
    updateIdleWatchlist,
    currentTwitchSettingsTransition,
    beginTwitchSettingsTransition,
    invalidateTwitchSettingsTransitions,
    normalizeStartupSettings,
    commitSettings,
  };
}
