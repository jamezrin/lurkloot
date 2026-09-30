import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings } from "@lurkloot/shared/models";
import { IDLE_WATCHLIST_LIMIT, isFarmingActive, type SettingsPatch } from "@lurkloot/shared/settings";
import { syncManagedTabBreakers } from "../core/tabRegistry";
import { dismissCriticalFailure } from "../core/criticalHealth";
import type { PlatformAdapter } from "../platforms/adapter";
import { type ControllerSlices, lateBound } from "./context";
import { platformLabel, settingsTickTrigger } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import type { ControllerCalls } from "./types";

// Runtime message handling.
export function createMessageHandler<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { lifecycleSlice, tabRegistry }: Pick<ControllerSlices<S>, "tabRegistry" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "abortClaimHandoffs"
    | "beginTwitchSettingsTransition"
    | "claimRewardNow"
    | "createAdapters"
    | "diagnosticEvent"
    | "getPlaybackControl"
    | "markPlatformsStarting"
    | "persistAndReport"
    | "recordPlaybackTelemetry"
    | "reportBestEffort"
    | "resumeAfterManualClose"
    | "setDiscoverySignalPlatformBlocked"
    | "snapshot"
    | "stopDiscoverySignalControllersAndReport"
    | "tickAndHandOff"
    | "tickInBackground"
    | "commitSettings"
    | "withEventCollector"
    | "withStateLock"
    | "platformTickRunning"
  >,
): Pick<ControllerCalls<S>, "handleMessage"> {
  const {
    abortClaimHandoffs,
    beginTwitchSettingsTransition,
    claimRewardNow,
    createAdapters,
    diagnosticEvent,
    getPlaybackControl,
    markPlatformsStarting,
    persistAndReport,
    recordPlaybackTelemetry,
    reportBestEffort,
    resumeAfterManualClose,
    setDiscoverySignalPlatformBlocked,
    snapshot,
    stopDiscoverySignalControllersAndReport,
    tickAndHandOff,
    tickInBackground,
    commitSettings,
    withEventCollector,
    withStateLock,
    platformTickRunning,
  } = lateBound(calls);

  async function handleMessage(
    message: CoreRuntimeMessage,
    sender?: { tab?: { id?: number; url?: string } },
  ): Promise<RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void> {
    if (message.type === "getPlaybackControl") {
      return getPlaybackControl(message, sender?.tab?.id);
    }

    if (message.type === "playbackTelemetry") {
      await recordPlaybackTelemetry(message, sender?.tab?.id, sender?.tab?.url);
      return undefined;
    }

    if (message.type === "getSnapshot") {
      return snapshot();
    }

    // setPlatformEnabled and setAutomation are the same operation now that there
    // is no master switch to flip alongside the platform flag. Both are kept:
    // they are separate wire messages with existing callers.
    if (message.type === "setPlatformEnabled" || message.type === "setAutomation") {
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
      // Stopping must cancel any loop still refreshing in the background.
      if (!message.enabled) abortClaimHandoffs(message.platform);
      const twitchTransition = message.platform === "twitch" ? beginTwitchSettingsTransition() : undefined;
      const twitchTransitionIsCurrent = (): boolean =>
        !lifecycleSlice.controllerShutdown && twitchTransition?.() === true;
      // Twitch integrity follows the committed setting on its own (#589): the
      // commit cancels a mint in flight when it disables Twitch, and the
      // integrity service reconciles its lifecycle and schedule after it.
      const patch: SettingsPatch = { platform: { [message.platform]: { enabled: message.enabled } } };
      await commitSettings(() => patch, { intent: patch });
      setDiscoverySignalPlatformBlocked(message.platform, !message.enabled);
      if (!message.enabled) {
        await stopDiscoverySignalControllersAndReport([message.platform]);
      }
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

    if (message.type === "saveSettings") {
      const { settings, effects } = await commitSettings(() => message.settingsPatch);
      if (message.tickAfterSave && isFarmingActive(settings)) {
        tickInBackground(message.tickAfterSavePlatforms, settingsTickTrigger(effects));
      }
      return snapshot();
    }

    if (message.type === "updateIdleWatchlist") {
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

    if (message.type === "resumeAfterManualClose") {
      await resumeAfterManualClose(message.platform);
      const settings = await ports.storage.loadSettings();
      if (settings.platform[message.platform].enabled) {
        await markPlatformsStarting([message.platform]);
        tickInBackground([message.platform], "manual_resume");
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "searchCategories") {
      return withEventCollector(async (emit, events) => {
        const settings = await ports.storage.loadSettings();
        let categories: CategorySearchResult["categories"] = [];
        let adapter: PlatformAdapter | undefined;
        try {
          adapter = createAdapters(settings, emit)[message.platform];
          categories = await adapter.searchCategories?.(message.query) ?? [];
        } catch (error) {
          emit({
            category: "diagnostic",
            level: "warn",
            message: `Category search failed: ${error instanceof Error ? error.message : String(error)}`,
            platform: message.platform,
          });
        } finally {
          adapter?.flushRouteDiagnostics?.(emit);
        }
        await reportBestEffort(events);
        return { categories };
      });
    }

    if (message.type === "tickNow") {
      await tickAndHandOff(undefined, "manual_tick");
      return snapshot();
    }
    if (message.type === "dismissCriticalFailure") {
      // Serialized like every other load→mutate→persist handler here: a dismiss
      // racing an alarm-driven tick would otherwise interleave loads and drop
      // one side's write to the persisted state.
      await withStateLock(() => withEventCollector(async (emit, events) => {
        const state = await ports.storage.loadState();
        const transition = dismissCriticalFailure(state, message.platform, Date.now());
        if (transition.event) emit(transition.event);
        // Closing the breaker here is what lets farming resume immediately
        // instead of waiting for the next tick to sync the registry.
        syncManagedTabBreakers(tabRegistry, transition.state, [message.platform]);
        await persistAndReport(transition.state, events);
      }));
      await tickAndHandOff(undefined, "critical_failure_dismissed");
      return snapshot();
    }
  }

  return {
    handleMessage,
  };
}
