import type { CoreRuntimeMessage, PlaybackControl } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { isPlaybackTelemetryHealthy } from "../core/scheduler";
import { MANUAL_WATCH_TTL_MS } from "../core/manualWatch";
import { isTimestampStale } from "../core/timestamps";
import { kickChannelFromUrl } from "../platforms/kick/channelUrl";
import { twitchChannelFromUrl } from "../platforms/twitch/channelUrl";
import { PLATFORMS } from "./constants";
import { lateBound, type ControllerSlices } from "./context";
import { forgetRemovedPageContextTab, isReleasedTab, tabClosureOrigin } from "../core/tabRegistry";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundHostPorts, WatchTabPort } from "./hostPorts";
import type { TickEffectExecutor } from "./tickEffects";
import type { ControllerCalls } from "./types";

// Enough to remember recent closes while their late reports drain.
const MAX_REMOVED_TABS = 64;

// The scheduler's watch-tab effects (#591), performed through the host's
// WatchTabPort (#598). Without the port every watch is tabless: the scheduler
// never asks to open a tab there, so that fails loudly, but it still asks to
// stop one when a platform goes idle or is disabled, which does nothing.
export function registerWatchTabEffects(executor: TickEffectExecutor, watchTabs: WatchTabPort | undefined): TickEffectExecutor {
  return executor
    .register("stopWatchTab", async ({ session }, context) => {
      await watchTabs?.stop(session, { signal: context.signal }, context.emit);
    })
    .register("openWatchTab", async ({ channel, session, managedTab }, context) => {
      if (!watchTabs) {
        throw new Error("Watch tabs need the browserTabs capability, which this host does not declare");
      }
      return await watchTabs.open(channel, session, {
        ...(managedTab ? { managedTab } : {}),
        signal: context.signal,
      }, context.emit);
    });
}

// Manual watch, managed watch tabs, tab events and playback telemetry.
export function createManualWatch<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { tabRegistry, lifecycleSlice }: Pick<ControllerSlices<S>, "tabRegistry" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "invalidateSelection"
    | "persistAndReport"
    | "persistPlatformAndReport"
    | "persistPlatformState"
    | "playbackEvents"
    | "reportBestEffort"
    | "settleCommitHooks"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "handleTabRemoved"
  | "resumeAfterManualClose"
  | "recordPlaybackTelemetry"
  | "handleTabUpdated"
  | "applyAdFocusForState"
  | "getPlaybackControl"
  | "registerWatchTabEffectHandlers"
> {
  const {
    invalidateSelection,
    persistAndReport,
    persistPlatformAndReport,
    persistPlatformState,
    playbackEvents,
    reportBestEffort,
    settleCommitHooks,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);
  const { tabs } = ports;
  // Tabs that were removed, whoever closed them, oldest first and bounded like
  // the registry's engine closures. A report still in flight from one is a
  // late result: it must not bring back the manual watch its close ended.
  // (A URL update only ever clears a record, so it needs no such check.)
  // Browsers do not reuse tab ids within a session.
  const removedTabs = new Set<number>();

  function noteRemovedTab(tabId: number): void {
    removedTabs.delete(tabId);
    removedTabs.add(tabId);
    while (removedTabs.size > MAX_REMOVED_TABS) {
      const oldest = removedTabs.values().next().value;
      if (oldest == null) break;
      removedTabs.delete(oldest);
    }
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    noteRemovedTab(tabId);
    // Taken before the lock: the engine records why it closes a tab before it
    // asks the browser to, so this is already known when the event arrives.
    const origin = tabClosureOrigin(tabRegistry, tabId);
    let committed = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await ports.storage.loadState();
      let nextState = state;
      for (const platform of PLATFORMS) {
        if (state.manualWatch?.[platform]?.tabId !== tabId && !state.manualWatchTabs?.[platform]?.[tabId]) continue;
        nextState = updateManualWatchTab(nextState, platform, tabId);
      }

      const closedManagedPlatforms: Platform[] = [];
      for (const platform of PLATFORMS) {
        const session = state.sessions[platform];
        if (
          session.status === "watching"
          && session.tabManagedByExtension
          && session.tabId === tabId
        ) {
          // Only the user's own close is a gesture to pause for (#598). The
          // engine closing its tab, e.g. a tick that stopped watching with the
          // tab not yet committed away, is its own decision to publish.
          if (origin !== "user") {
            emit({ category: "diagnostic", platform, level: "debug", message: `Managed watch tab ${tabId} was closed by the extension (${origin}); not pausing farming` });
            continue;
          }
          closedManagedPlatforms.push(platform);
          emit({ category: "diagnostic", platform, level: "info", message: "Managed watch tab was closed manually; pausing farming for this platform until the user resumes" });
        }
      }

      if (closedManagedPlatforms.length > 0) {
        const closedAt = new Date().toISOString();
        const sessions = { ...nextState.sessions };
        const managedWatchTabs = { ...nextState.managedWatchTabs };
        const manualClosePause = { ...nextState.manualClosePause };
        for (const platform of closedManagedPlatforms) {
          sessions[platform] = {
            platform,
            status: "paused",
            offlineChecks: 0,
            message: "Farming tab closed",
            reasonCode: "manual_tab_close",
          };
          delete managedWatchTabs[platform];
          const channelUrl = state.managedWatchTabs?.[platform]?.channelUrl ?? state.sessions[platform].channel?.url;
          manualClosePause[platform] = {
            platform,
            closedAt,
            ...(channelUrl ? { channelUrl } : {}),
          };
        }
        nextState = { ...nextState, sessions, managedWatchTabs, manualClosePause };
      }

      // A retained page context whose tab is gone is forgotten (#588), so the
      // next page fallback opens a fresh one instead of probing a missing tab.
      // It is not a watch tab, so even the user's close pauses nothing.
      const forgotten = forgetRemovedPageContextTab(tabRegistry, nextState.managedPageContextTabs ?? {}, tabId);
      for (const platform of forgotten.platforms) {
        emit({ category: "diagnostic", platform, level: "debug", message: `Forgot managed page context in tab ${tabId} because the tab was closed (${origin})` });
      }
      if (forgotten.platforms.length > 0) nextState = { ...nextState, managedPageContextTabs: forgotten.contexts };

      if (nextState !== state || events.length > 0) {
        await persistAndReport(nextState, events);
        committed = true;
      }
    }));
    // Dependents react to the commit from their hooks: a paused session stops
    // its discovery-signal observer, and a manual watch that ended ticks the
    // platform. The host's event resolves once they have.
    if (committed) await settleCommitHooks();
  }

  // Explicit user action: clears the manual-close pause so the next tick may
  // farm this platform again. Only the user can undo the gesture they made.
  async function resumeAfterManualClose(platform: Platform): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await ports.storage.loadState();
      if (!state.manualClosePause?.[platform]) {
        await reportBestEffort(events);
        return;
      }
      const manualClosePause = { ...state.manualClosePause };
      delete manualClosePause[platform];
      emit({ category: "diagnostic", platform, level: "info", message: "Resuming farming after a manual watch tab close" });
      await persistAndReport({ ...state, manualClosePause }, events);
    }));
  }

  async function recordPlaybackTelemetry(
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
    senderTabUrl?: string,
  ): Promise<void> {
    let manualWatchReported = false;
    // A report still in flight from a tab that was closed, by the engine
    // (#598) or by the user (#596), is a late result: it is neither the
    // managed tab's playback nor the user watching.
    if (senderTabId != null && (isReleasedTab(tabRegistry, senderTabId) || removedTabs.has(senderTabId))) return;
    // The committed session's ad state, when the report was the managed tab's.
    let adFocus: { tabId: number; adActive: boolean } | undefined;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          manualWatchReported = true;
          await persistPlatformAndReport(
            message.platform,
            recordManualWatchTelemetry(state, settings, message, senderTabId, senderTabUrl),
            events,
          );
        }
        return;
      }

      const previous = session.playback;
      const telemetry = message.telemetry;
      let nextState: SchedulerState = {
        ...state,
        sessions: {
          ...state.sessions,
          [message.platform]: {
            ...session,
            playback: {
              ...telemetry,
              platform: message.platform,
              checkedAt: new Date().toISOString(),
            },
            // Telemetry arrives between scheduler ticks. Clearing the counter the
            // moment playback is confirmed means a tab that dipped unhealthy and
            // recovered is never condemned by a stale count (#250).
            playbackChecks: isPlaybackTelemetryHealthy(telemetry) ? 0 : session.playbackChecks,
          },
        },
      };

      // Only log transitions — telemetry arrives every few seconds, so logging the
      // raw stream would bury everything else.
      const playbackDiagnostics = session.status === "watching"
        ? playbackEvents(message.platform, previous, telemetry)
        : [];
      for (const event of playbackDiagnostics) emit(event);

      await persistPlatformState(message.platform, nextState, undefined, (committed) => {
        const committedSession = committed.sessions[message.platform];
        if (committedSession.status === "watching" && committedSession.tabId === senderTabId) {
          adFocus = { tabId: senderTabId, adActive: Boolean(committedSession.playback?.adActive) };
        }
      });
      if ((previous ? isPlaybackTelemetryHealthy(previous) : undefined)
        !== isPlaybackTelemetryHealthy(telemetry)) {
        invalidateSelection(message.platform);
      }
      await reportBestEffort(events);
    }), [message.platform]);
    // Ad focus follows the committed session, with no lock held (#596). A host
    // reset or shutdown since the commit has already released focus.
    const focus = adFocus;
    if (focus && tabs && lifecycleSlice.observersOpen && !lifecycleSlice.controllerShutdown) {
      await withEventCollector(async (emit, events) => {
        try {
          await tabs.watch.applyAdFocus(message.platform, focus.tabId, focus.adActive, emit);
        } catch (error) {
          emitHostCallbackError(emit, message.platform, error, "Could not apply ad focus");
        } finally {
          await reportBestEffort(events);
        }
      });
    }
    // A manual watch that started or ended ticks the platform from the tick
    // admission's hook; the report resolves once it has been requested. The
    // managed tab's own playback never changes manual watch, so it does not wait.
    if (manualWatchReported) await settleCommitHooks([message.platform]);
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: EngineSettings,
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId: number,
    senderTabUrl?: string,
  ): SchedulerState {
    const channel = message.platform === "twitch"
      ? twitchChannelFromUrl(senderTabUrl) : kickChannelFromUrl(senderTabUrl);
    const owned = state.managedWatchTabs?.[message.platform]?.tabId === senderTabId
      || state.managedPageContextTabs?.[message.platform]?.tabId === senderTabId;
    const active = Boolean(channel) && !owned && settings.pauseOnManualWatch
      && message.telemetry.playingVideoCount > 0 && !message.telemetry.documentHidden;
    return updateManualWatchTab(state, message.platform, senderTabId, {
      platform: message.platform, tabId: senderTabId,
      checkedAt: new Date().toISOString(), active,
      ...(channel ? { channel } : {}),
    }, settings.pauseOnManualWatch);
  }

  function updateManualWatchTab(
    state: SchedulerState, platform: Platform, tabId: number,
    record?: NonNullable<SchedulerState["manualWatch"]>[Platform], enabled = true,
  ): SchedulerState {
    const previous = state.manualWatch?.[platform];
    const tabs = { ...state.manualWatchTabs?.[platform] };
    // Backfill the single-tab record saved by earlier versions.
    if (!state.manualWatchTabs?.[platform] && previous) tabs[previous.tabId] = previous;
    for (const [id, entry] of Object.entries(tabs)) {
      if (!entry.active || isTimestampStale(entry.checkedAt, MANUAL_WATCH_TTL_MS, Date.now())) delete tabs[id];
    }
    delete tabs[tabId];
    if (enabled && record?.active) tabs[tabId] = record;
    const manualWatch = { ...state.manualWatch };
    const manualWatchTabs = { ...state.manualWatchTabs };
    if (enabled) {
      manualWatchTabs[platform] = tabs;
      const remaining = Object.values(tabs);
      const selected = remaining.find((entry) => entry.tabId === tabId)
        ?? remaining.find((entry) => entry.tabId === previous?.tabId) ?? remaining[0] ?? record;
      if (selected) manualWatch[platform] = selected;
      else delete manualWatch[platform];
    } else {
      delete manualWatch[platform];
      delete manualWatchTabs[platform];
    }
    return { ...state, manualWatch, manualWatchTabs };
  }

  async function handleTabUpdated(tabId: number, url: string): Promise<void> {
    let committed = false;
    await withStateLock(() => withEventCollector(async (_emit, events) => {
      const original = await ports.storage.loadState();
      let state = original;
      for (const platform of PLATFORMS) {
        const record = state.manualWatchTabs?.[platform]?.[tabId]
          ?? (state.manualWatch?.[platform]?.tabId === tabId ? state.manualWatch[platform] : undefined);
        if (!record) continue;
        const channel = platform === "twitch" ? twitchChannelFromUrl(url) : kickChannelFromUrl(url);
        // Keep the pause during channel switches until fresh playback arrives.
        // Clearing here would reopen farming while the new player is loading.
        if (channel) continue;
        state = updateManualWatchTab(state, platform, tabId);
      }
      if (state !== original) {
        await persistAndReport(state, events);
        committed = true;
      }
    }));
    if (committed) await settleCommitHooks();
  }

  async function applyAdFocusForState(
    state: SchedulerState,
    emit: EventEmitter,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<void> {
    if (!tabs) return;
    for (const platform of platforms) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      try {
        await tabs.watch.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive), emit);
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not apply ad focus");
      }
    }
  }

  async function getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const [policy, state] = await Promise.all([ports.tabs?.watch.loadPlaybackPolicy(), ports.storage.loadState()]);
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
      keepVideosUnmuted: policy?.keepVideosUnmuted ?? true,
    };
  }

  return {
    registerWatchTabEffectHandlers: (executor) => registerWatchTabEffects(executor, tabs?.watch),
    handleTabRemoved,
    resumeAfterManualClose,
    recordPlaybackTelemetry,
    handleTabUpdated,
    applyAdFocusForState,
    getPlaybackControl,
  };
}
