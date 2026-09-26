import type { CoreRuntimeMessage, PlaybackControl } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { isPlaybackTelemetryHealthy, MANUAL_WATCH_TTL_MS } from "../core/scheduler";
import { isTimestampStale } from "../core/timestamps";
import { kickChannelFromUrl } from "../platforms/kick/channelUrl";
import { twitchChannelFromUrl } from "../platforms/twitch/channelUrl";
import { PLATFORMS } from "./constants";
import { lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls } from "./types";

// Manual watch, managed-tab events and playback telemetry.
export function createManualWatch<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  calls: Pick<ControllerCalls<S>,
    | "invalidateSelection"
    | "persistAndReport"
    | "persistPlatformAndReport"
    | "persistPlatformState"
    | "playbackEvents"
    | "reportBestEffort"
    | "stopDiscoverySignalControllers"
    | "tickInBackground"
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
> {
  const {
    invalidateSelection,
    persistAndReport,
    persistPlatformAndReport,
    persistPlatformState,
    playbackEvents,
    reportBestEffort,
    stopDiscoverySignalControllers,
    tickInBackground,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);

  async function handleTabRemoved(tabId: number): Promise<void> {
    const changed: Platform[] = [];
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      let nextState = state;
      for (const platform of PLATFORMS) {
        if (state.manualWatch?.[platform]?.tabId !== tabId && !state.manualWatchTabs?.[platform]?.[tabId]) continue;
        nextState = updateManualWatchTab(nextState, platform, tabId);
        if (hasRecentManualWatch(state, platform) !== hasRecentManualWatch(nextState, platform)) changed.push(platform);
      }

      const closedManagedPlatforms: Platform[] = [];
      for (const platform of PLATFORMS) {
        const session = state.sessions[platform];
        if (
          session.status === "watching"
          && session.tabManagedByExtension
          && session.tabId === tabId
        ) {
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
        await stopDiscoverySignalControllers(closedManagedPlatforms, emit);
      }

      if (nextState !== state || events.length > 0) await persistAndReport(nextState, events);
    }));
    if (changed.length) tickInBackground(changed, "manual_watch");
  }

  // Explicit user action: clears the manual-close pause so the next tick may
  // farm this platform again. Only the user can undo the gesture they made.
  async function resumeAfterManualClose(platform: Platform): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
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
    let manualWatchChanged = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          const manualWatch = recordManualWatchTelemetry(state, settings, message, senderTabId, senderTabUrl);
          manualWatchChanged = manualWatch.changed;
          await persistPlatformAndReport(
            message.platform,
            manualWatch.state,
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

      await persistPlatformState(message.platform, nextState);
      if ((previous ? isPlaybackTelemetryHealthy(previous) : undefined)
        !== isPlaybackTelemetryHealthy(telemetry)) {
        invalidateSelection(message.platform);
      }
      try {
        if (deps.applyAdFocus && session.status === "watching" && session.tabId === senderTabId) {
          await deps.applyAdFocus(message.platform, session.tabId, Boolean(message.telemetry.adActive), emit);
        }
      } catch (error) {
        emitHostCallbackError(emit, message.platform, error, "Could not apply ad focus");
      } finally {
        await reportBestEffort(events);
      }
    }), [message.platform]);
    if (manualWatchChanged) tickInBackground([message.platform], "manual_watch");
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: EngineSettings,
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId: number,
    senderTabUrl?: string,
  ): { state: SchedulerState; changed: boolean } {
    const channel = message.platform === "twitch"
      ? twitchChannelFromUrl(senderTabUrl) : kickChannelFromUrl(senderTabUrl);
    const owned = state.managedWatchTabs?.[message.platform]?.tabId === senderTabId
      || state.managedPageContextTabs?.[message.platform]?.tabId === senderTabId;
    const active = Boolean(channel) && !owned && settings.pauseOnManualWatch
      && message.telemetry.playingVideoCount > 0 && !message.telemetry.documentHidden;
    const next = updateManualWatchTab(state, message.platform, senderTabId, {
      platform: message.platform, tabId: senderTabId,
      checkedAt: new Date().toISOString(), active,
      ...(channel ? { channel } : {}),
    }, settings.pauseOnManualWatch);
    return { state: next, changed: hasRecentManualWatch(state, message.platform)
      !== hasRecentManualWatch(next, message.platform) };
  }

  function hasRecentManualWatch(state: SchedulerState, platform: Platform): boolean {
    const watch = state.manualWatch?.[platform];
    return Boolean(watch?.active && !isTimestampStale(watch.checkedAt, MANUAL_WATCH_TTL_MS, Date.now()));
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
    const changed: Platform[] = [];
    await withStateLock(() => withEventCollector(async (_emit, events) => {
      const original = await deps.loadState();
      let state = original;
      for (const platform of PLATFORMS) {
        const record = state.manualWatchTabs?.[platform]?.[tabId]
          ?? (state.manualWatch?.[platform]?.tabId === tabId ? state.manualWatch[platform] : undefined);
        if (!record) continue;
        const channel = platform === "twitch" ? twitchChannelFromUrl(url) : kickChannelFromUrl(url);
        // Keep the pause during channel switches until fresh playback arrives.
        // Clearing here would reopen farming while the new player is loading.
        if (channel) continue;
        const wasActive = hasRecentManualWatch(state, platform);
        state = updateManualWatchTab(state, platform, tabId);
        if (wasActive !== hasRecentManualWatch(state, platform)) changed.push(platform);
      }
      if (state !== original) await persistAndReport(state, events);
    }));
    if (changed.length) tickInBackground(changed, "manual_watch");
  }

  async function applyAdFocusForState(
    state: SchedulerState,
    emit: EventEmitter,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<void> {
    if (!deps.applyAdFocus) return;
    for (const platform of platforms) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      try {
        await deps.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive), emit);
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not apply ad focus");
      }
    }
  }

  async function getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const [policy, state] = await Promise.all([deps.loadTabPlaybackPolicy?.(), deps.loadState()]);
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
      keepVideosUnmuted: policy?.keepVideosUnmuted ?? true,
    };
  }

  return {
    handleTabRemoved,
    resumeAfterManualClose,
    recordPlaybackTelemetry,
    handleTabUpdated,
    applyAdFocusForState,
    getPlaybackControl,
  };
}
