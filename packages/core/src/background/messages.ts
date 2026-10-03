import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings } from "@lurkloot/shared/models";
import { lateBound } from "./context";
import type { ControllerCalls } from "./types";

type MessageSender = { tab?: { id?: number; url?: string } };
type MessageResult<S extends EngineSettings> = RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void;
type MessageRoutes<S extends EngineSettings> = {
  [Type in CoreRuntimeMessage["type"]]: (
    message: Extract<CoreRuntimeMessage, { type: Type }>,
    sender?: MessageSender,
  ) => Promise<MessageResult<S>>;
};

// Runtime messages (#591). Each is handled by the module that owns what it
// changes; this only routes, one entry per message type.
export function createMessageHandler<S extends EngineSettings>(
  calls: Pick<ControllerCalls<S>,
    | "claimRewardNow"
    | "dismissCriticalFailure"
    | "getPlaybackControl"
    | "recordPlaybackTelemetry"
    | "resumeFarmingAfterManualClose"
    | "saveSettingsFromMessage"
    | "searchCategories"
    | "setPlatformEnabled"
    | "snapshot"
    | "tickNow"
    | "updateIdleWatchlist"
  >,
): Pick<ControllerCalls<S>, "handleMessage"> {
  const {
    claimRewardNow,
    dismissCriticalFailure,
    getPlaybackControl,
    recordPlaybackTelemetry,
    resumeFarmingAfterManualClose,
    saveSettingsFromMessage,
    searchCategories,
    setPlatformEnabled,
    snapshot,
    tickNow,
    updateIdleWatchlist,
  } = lateBound(calls);

  const routes: MessageRoutes<S> = {
    getSnapshot: () => snapshot(),
    // Manual watch: the content scripts' playback reports and control queries.
    getPlaybackControl: (message, sender) => getPlaybackControl(message, sender?.tab?.id),
    playbackTelemetry: async (message, sender) => {
      await recordPlaybackTelemetry(message, sender?.tab?.id, sender?.tab?.url);
    },
    resumeAfterManualClose: (message) => resumeFarmingAfterManualClose(message.platform),
    dismissCriticalFailure: (message) => dismissCriticalFailure(message.platform),
    // Settings transitions.
    setPlatformEnabled: (message) => setPlatformEnabled(message),
    setAutomation: (message) => setPlatformEnabled(message),
    saveSettings: (message) => saveSettingsFromMessage(message),
    updateIdleWatchlist: (message) => updateIdleWatchlist(message),
    // Claims, discovery and the tick coordinator.
    claimReward: (message) => claimRewardNow(message),
    searchCategories: (message) => searchCategories(message),
    tickNow: () => tickNow(),
  };

  async function handleMessage(
    message: CoreRuntimeMessage,
    sender?: MessageSender,
  ): Promise<MessageResult<S>> {
    // A type this build does not know (an older or newer caller) gets nothing.
    const route = routes[message.type] as MessageRoutes<S>[CoreRuntimeMessage["type"]] | undefined;
    return route?.(message as never, sender);
  }

  return {
    handleMessage,
  };
}
