import type { CategorySearchResult, PlaybackControl, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropCampaign, DropReward, EngineSettings, Platform, PlaybackTelemetry, SchedulerState, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { ActivityEvent, DiagnosticEvent, EngineEvent, EventEmitter, EventReporter, FarmingStopReason } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { MANUAL_WATCH_TTL_MS, runSchedulerTick, type StopPageContextTabs } from "../core/scheduler";
import { logActivity, setActivityLogger } from "../core/activityLog";
import { setTwitchIntegrity } from "../core/tabs";
import { integrityFromHeaders } from "../core/twitchIntegrity";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController, WatchContext } from "../core/tablessWatch";

export const ALARM_NAME = "lurkloot.tick";
// A separate, fixed 1-minute alarm drives tabless watch heartbeats independently
// of the (heavier, configurable) discovery tick. chrome.alarms clamps to a
// 1-minute minimum, close enough to TwitchDropsMiner's 59s send cadence.
export const WATCH_ALARM_NAME = "lurkloot.watch";
const PLATFORMS: Platform[] = ["twitch", "kick"];
const EN_RUNTIME_MESSAGES: Record<string, string> = {
  notificationRewardClaimed: "Reward claimed",
  notificationRewardEarned: "Reward earned",
  notificationNoDropsLeft: "No drops left",
  notificationRewardFromCampaign: "$1 from $2",
  notificationNoDropsLeftMessage: "$1 has no eligible drops to farm.",
};

// One in-flight state mutation at a time. Each handler's load→modify→persist
// runs inside this lock so a save built on a stale snapshot can't clobber
// another handler's concurrent write (telemetry arrives every ~5s while ticks
// and heartbeats fire on alarms). NOT reentrant: a locked section must never
// call another locked section (see runWatchHeartbeat, which calls tick() only
// after its locked closure returns).
let stateMutation: Promise<unknown> = Promise.resolve();
function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = stateMutation.then(operation, operation);
  // Keep the chain alive regardless of outcome without leaking rejections.
  stateMutation = run.then(() => undefined, () => undefined);
  return run;
}

// Generic over the host's settings type `S`, which must satisfy the engine
// contract (EngineSettings). The extension parametrizes it with its fuller
// ExtensionSettings (load/save round-trip the host-only fields); the CLI uses the
// bare EngineSettings. The engine itself only ever reads EngineSettings fields.
export interface BackgroundControllerDeps<S extends EngineSettings = EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  reportEvents?: EventReporter;
  createAlarm(name: string, options: { periodInMinutes: number }): Promise<void>;
  createAdapters(emit: EventEmitter): Record<Platform, PlatformAdapter>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
  closeManagedTabsByUrl?(urls: string[]): Promise<void>;
  // Tab-mode ad focus. The host (extension) owns the focus policy (adFocusMode),
  // so the engine only reports whether an ad is active for a given watch tab.
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean): Promise<void>;
  // Tab-mode playback policy the host supplies to managed watch tabs. Defaults to
  // keeping videos unmuted when the host does not provide it.
  loadTabPlaybackPolicy?(): Promise<{ keepVideosUnmuted: boolean }>;
  // Applies a popup settings patch to the host's full settings. Host-only; the
  // CLI never sends settings-mutating messages, so it can omit this.
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
  // Browser-bound page-context tab teardown, injected into the scheduler tick.
  // Omitted in headless/test runs, where the scheduler forgets contexts from
  // state only (see runSchedulerTick / StopPageContextTabs).
  stopPageContextTabs?: StopPageContextTabs;
}

export function createBackgroundController<S extends EngineSettings = EngineSettings>(deps: BackgroundControllerDeps<S>) {
  // Call only while holding the module-wide state lock: the temporary activity
  // logger is process-global until Task 4 replaces it with scoped dependencies.
  async function withEventCollector<T>(operation: (emit: EventEmitter, events: EngineEvent[]) => Promise<T>): Promise<T> {
    const events: EngineEvent[] = [];
    const emit: EventEmitter = (event) => events.push(event);
    const previousLogger = setActivityLogger((level, message, platform) => {
      emit({ category: "diagnostic", level, message, platform });
    });
    try {
      return await operation(emit, events);
    } finally {
      setActivityLogger(previousLogger);
    }
  }

  // Persistent tabless watchers, one per platform, kept alive across discovery
  // ticks (the WebSocket-based Kick watcher in particular must not be recreated
  // each tick). Reconciled against the scheduler's per-platform session state.
  const tablessWatchers = new Map<Platform, TablessWatchController>();
  let settingsMutation: Promise<unknown> = Promise.resolve();
  let settingsPauseCount = 0;

  // The last token handed to setTwitchIntegrity; used to skip re-persisting on
  // every page GQL call (the page sends integrity on most requests).
  let lastIntegrityToken: string | undefined;

  // Prime the in-memory integrity token from storage whenever the background
  // script (re)evaluates, so a claim right after a service-worker wake can use
  // the last captured token before any fresh page traffic is observed.
  void loadStoredTwitchIntegrity();

  async function loadStoredTwitchIntegrity(): Promise<void> {
    try {
      const integrity = await deps.loadTwitchIntegrity?.();
      if (integrity && integrity.expiresAt > Date.now()) {
        lastIntegrityToken = integrity.integrity;
        setTwitchIntegrity(integrity);
      }
    } catch (error) {
      // A missing/corrupt stored token is non-fatal: fresh page traffic will
      // re-capture one, and claims simply stay best-effort until then.
      await reportBestEffort([{
        category: "diagnostic",
        level: "debug",
        platform: "twitch",
        message: `No stored Twitch integrity token to prime (${error instanceof Error ? error.message : String(error)})`,
      }]);
    }
  }

  // Fed by the background's webRequest listener with the outgoing headers of
  // gql.twitch.tv requests. Only genuine page-minted requests carry a
  // Client-Integrity header, so integrityFromHeaders returns undefined (and we
  // ignore) our own background fetch and anonymous queries.
  async function captureTwitchIntegrity(headers: IntegrityHeader[] | undefined): Promise<void> {
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    await withStateLock(() => withEventCollector(async (_emit, events) => {
      const isNew = integrity.integrity !== lastIntegrityToken;
      setTwitchIntegrity(integrity, { isNew });
      if (isNew) {
        lastIntegrityToken = integrity.integrity;
        await deps.saveTwitchIntegrity?.(integrity);
      }
      await reportBestEffort(events);
    }));
  }

  async function persistAndReport(state: SchedulerState, events: readonly EngineEvent[] = []): Promise<void> {
    const { events: _legacyEvents, ...operationalState } = state as SchedulerState & { events?: unknown };
    await deps.saveState(operationalState);
    await reportBestEffort(events);
  }

  async function reportBestEffort(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0 || !deps.reportEvents) return;
    try {
      await deps.reportEvents(events);
    } catch {
      // Host event persistence/output is best-effort.
    }
  }

  function playbackEvents(
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
  ): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const log = (level: DiagnosticEvent["level"], message: string) => {
      events.push({ category: "diagnostic", platform, level, message });
    };

    if (telemetry.adActive && !previous?.adActive) {
      log("info", "Ad started; keeping the watch tab counting down");
    } else if (!telemetry.adActive && previous?.adActive) {
      log("debug", "Ad finished");
    }
    if (telemetry.blockedPlaybackCount > 0 && (previous?.blockedPlaybackCount ?? 0) === 0) {
      log("warn", `Playback was blocked for ${telemetry.blockedPlaybackCount} video(s); re-muted to keep farming`);
    }
    if (telemetry.videoCount === 0 && (previous?.videoCount ?? -1) !== 0) {
      log("warn", "No video element found in the watch tab");
    }
    if (telemetry.playingVideoCount !== (previous?.playingVideoCount ?? -1) || telemetry.videoCount !== (previous?.videoCount ?? -1)) {
      log("debug", `Playback telemetry: ${telemetry.playingVideoCount}/${telemetry.videoCount} videos playing${telemetry.documentHidden ? " (tab hidden)" : ""}`);
    }
    return events;
  }

  async function ensureAlarm(): Promise<void> {
    const settings = await deps.loadSettings();
    await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    if (settings.autoStartDropFarming && settings.running) await tick();
  }

  async function handleStartup(): Promise<void> {
    const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
    await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    // A restart kills any in-memory watchers; start clean and let tick() rebuild.
    tablessWatchers.clear();

    const cleanup = staleStartupCleanup(state);
    if (!cleanup.hasStaleSession) {
      if (settings.autoStartDropFarming && settings.running) await tick();
      if (settings.running && !settings.autoStartDropFarming) {
        await deps.saveSettings({ ...settings, running: false });
      }
      return;
    }

    if (deps.closeManagedTabsByUrl) {
      await deps.closeManagedTabsByUrl(cleanup.managedUrls);
    }

    let nextSettings = settings;
    if (settings.running && !settings.autoStartDropFarming) {
      nextSettings = { ...settings, running: false };
      await deps.saveSettings(nextSettings);
    }

    const restartEvents = runtimeRestartEvents(state);
    await persistAndReport(cleanup.state, restartEvents);

    if (nextSettings.running && nextSettings.autoStartDropFarming) {
      await tick();
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = settingsMutation.then(operation, operation);
    settingsMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async function updateStoredSettings(patch: SettingsPatch): Promise<S> {
    return withSettingsLock(async () => {
      if (!deps.applySettingsPatch) {
        throw new Error("applySettingsPatch dependency is required to mutate settings");
      }
      const settings = deps.applySettingsPatch(await deps.loadSettings(), patch);
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      return settings;
    });
  }

  async function tick(platforms?: Platform[], options?: { forcePaused?: boolean }): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const storedSettings = await deps.loadSettings();
      const settings: S = options?.forcePaused || settingsPauseCount > 0
        ? { ...storedSettings, running: false }
        : storedSettings;
      const state = await deps.loadState();
      try {
        const adapters = deps.createAdapters(emit);
        const result = await runSchedulerTick(state, settings, adapters, {
          ...(platforms ? { platforms } : {}),
          stopPageContextTabs: deps.stopPageContextTabs,
          emit,
        });
        const lifecycleEvents = farmingLifecycleEvents(state, result.state);
        for (const event of lifecycleEvents) emit(event);
        await emitNotifications(settings, state, result.state);
        await applyAdFocusForState(result.state);
        await reconcileTablessWatchers(result.state, settings, adapters, emit, platforms);
        await persistAndReport(result.state, events);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Scheduler tick failed";
        emit({ category: "activity", code: "interruption", level: "error", data: { reason: "platform_error", detail } });
        emit({ category: "diagnostic", level: "error", message: detail });
        await persistAndReport(state, events);
      }
    }));
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    // Serialize the load-modify-persist under the state lock so it cannot race a
    // concurrent tick()/heartbeat (both fire on a ~1-minute cadence while the
    // user can close a tab at any moment). The trailing tick() is deferred to
    // outside the lock because it re-acquires the lock itself — mirroring how
    // runWatchHeartbeat returns its fallback work and ticks afterwards.
    const shouldRerunScheduler = await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const manualPlatforms = (["twitch", "kick"] as Platform[]).filter((platform) => state.manualWatch?.[platform]?.tabId === tabId);
      let nextState = state;
      if (manualPlatforms.length > 0) {
        const manualWatch = { ...state.manualWatch };
        for (const platform of manualPlatforms) delete manualWatch[platform];
        nextState = {
          ...state,
          manualWatch,
        };
      }
      let shouldRerun = false;

      for (const platform of settings.running ? ["twitch", "kick"] as Platform[] : []) {
        const session = state.sessions[platform];
        if (
          settings.platform[platform].enabled
          && session.status === "watching"
          && session.tabManagedByExtension
          && session.tabId === tabId
        ) {
          emit({ category: "diagnostic", platform, level: "info", message: "Managed watch tab was closed; re-running scheduler" });
          shouldRerun = true;
          break;
        }
      }
      if (manualPlatforms.length > 0 || events.length > 0) await persistAndReport(nextState, events);
      return shouldRerun;
    }));

    if (shouldRerunScheduler) await tick();
  }

  function tablessWatchContext(): WatchContext {
    // The Twitch watcher resolves the viewer id itself; nothing extra needed yet.
    return {};
  }

  // Aligns the live tabless watchers with the scheduler's session state: starts
  // or switches a watcher for each platform farming tablessly, and stops the
  // rest (idle, paused, fell back to a tab, or watching with a real tab).
  async function reconcileTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<void> {
    const targets = platforms ?? PLATFORMS;
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const wantsTabless = settings.running
        && settings.platform[platform].enabled
        && session.status === "watching"
        && session.watchMode === "tabless"
        && Boolean(session.channel);
      const existing = tablessWatchers.get(platform);

      if (wantsTabless && session.channel && adapter.createTablessWatcher) {
        const watcher = existing ?? adapter.createTablessWatcher();
        if (!existing) tablessWatchers.set(platform, watcher);
        if (watcher.channelUrl !== session.channel.url) {
          try {
            await watcher.start(session.channel, tablessWatchContext());
          } catch (error) {
            emit({
              category: "diagnostic",
              platform,
              level: "warn",
              message: error instanceof Error ? error.message : "Could not start the tabless watcher",
            });
          }
        }
      } else if (existing) {
        await existing.stop();
        tablessWatchers.delete(platform);
      }
    }
  }

  // Fired by the 1-minute watch alarm. Runs one heartbeat per active tabless
  // watcher and records its health on the session, falling back to a real tab
  // (by re-running the scheduler) when a heartbeat keeps failing.
  async function runWatchHeartbeat(): Promise<void> {
    if (settingsPauseCount > 0) return;
    const settings = await deps.loadSettings();
    if (!settings.running) return;
    const fallbackPlatforms = await withStateLock<Platform[]>(() => withEventCollector(async (emit, events) => {
      let nextState = await deps.loadState();
      // After a service-worker restart the in-memory watcher map is empty, so
      // rebuild it from persisted tabless sessions before the size check below.
      // Otherwise the 1-minute watch alarm would do nothing until the next
      // (possibly distant) discovery tick re-armed the watchers, stalling Twitch
      // tabless farming. Done inside the state lock so it cannot race tick()'s
      // own reconcile over the shared watcher map (the discovery and watch alarms
      // both fire on a ~1-minute cadence). reconcileTablessWatchers only calls
      // watcher.start() on a fresh start/channel switch and never re-acquires the
      // lock, so holding it here is safe (no reentrancy).
      await reconcileTablessWatchers(nextState, settings, deps.createAdapters(emit), emit);
      if (tablessWatchers.size === 0) {
        await reportBestEffort(events);
        return [];
      }

      let changed = false;
      const fallbacks: Platform[] = [];

      for (const [platform, watcher] of [...tablessWatchers]) {
        const session = nextState.sessions[platform];
        if (session.status !== "watching" || session.watchMode !== "tabless") continue;

        let ok = false;
        let message: string | undefined;
        try {
          const result = await watcher.tick(tablessWatchContext());
          ok = result.ok;
          message = result.message;
        } catch (error) {
          message = error instanceof Error ? error.message : "Tabless heartbeat failed";
        }

        const previousChecks = session.heartbeatChecks ?? 0;
        const heartbeatChecks = ok ? 0 : previousChecks + 1;
        nextState = {
          ...nextState,
          sessions: {
            ...nextState.sessions,
            [platform]: {
              ...session,
              lastHeartbeatAt: new Date().toISOString(),
              lastHeartbeatOk: ok,
              heartbeatChecks,
            },
          },
        };
        changed = true;

        if (ok && previousChecks > 0) {
          emit({ category: "diagnostic", platform, level: "info", message: "Tabless watch heartbeat recovered" });
        } else if (!ok && previousChecks === 0) {
          emit({ category: "diagnostic", platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" });
        }
        if (!ok && heartbeatChecks >= settings.offlineRetryLimit && !fallbacks.includes(platform)) {
          fallbacks.push(platform);
          emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
        }
      }

      if (changed) await persistAndReport(nextState, events);
      else await reportBestEffort(events);
      return fallbacks;
    }));

    // chooseTablessWatch now sees heartbeatChecks past the limit and opens a tab.
    // Run outside the lock: tick() acquires the lock itself.
    for (const platform of fallbackPlatforms) {
      await tick([platform]);
    }
  }

  async function beginSettingsSession(): Promise<void> {
    settingsPauseCount += 1;
    if (settingsPauseCount === 1) await tick(undefined, { forcePaused: true });
  }

  async function endSettingsSession(): Promise<void> {
    settingsPauseCount = Math.max(0, settingsPauseCount - 1);
    if (settingsPauseCount > 0) return;
    const settings = await deps.loadSettings();
    if (settings.running && hasEnabledPlatform(settings)) await tick();
  }

  async function recordPlaybackTelemetry(
    message: Extract<RuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          await persistAndReport(recordManualWatchTelemetry(state, settings, message, senderTabId), events);
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
          },
        },
      };

      // Only log transitions — telemetry arrives every few seconds, so logging the
      // raw stream would bury everything else.
      const playbackDiagnostics = session.status === "watching"
        ? playbackEvents(message.platform, previous, telemetry)
        : [];
      for (const event of playbackDiagnostics) emit(event);

      await persistAndReport(nextState, events);

      if (deps.applyAdFocus && session.status === "watching" && session.tabId === senderTabId) {
        await deps.applyAdFocus(message.platform, session.tabId, Boolean(message.telemetry.adActive));
      }
    }));
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: EngineSettings,
    message: Extract<RuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId: number,
  ): SchedulerState {
    const manualWatch = { ...state.manualWatch };
    if (!settings.pauseOnManualWatch) {
      delete manualWatch[message.platform];
      return { ...state, manualWatch };
    }

    const active = message.telemetry.playingVideoCount > 0 && !message.telemetry.documentHidden;
    const previous = manualWatch[message.platform];
    const recentPrevious = previous?.active && Date.now() - Date.parse(previous.checkedAt) <= MANUAL_WATCH_TTL_MS;
    if (!active && previous?.tabId !== senderTabId && recentPrevious) return state;

    manualWatch[message.platform] = {
      platform: message.platform,
      tabId: senderTabId,
      checkedAt: new Date().toISOString(),
      active,
    };
    return { ...state, manualWatch };
  }

  async function applyAdFocusForState(state: SchedulerState): Promise<void> {
    if (!deps.applyAdFocus) return;
    for (const platform of ["twitch", "kick"] as Platform[]) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      await deps.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive));
    }
  }

  async function getPlaybackControl(
    message: Extract<RuntimeMessage, { type: "getPlaybackControl" }>,
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

  async function claimRewardNow(
    message: Extract<RuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot<S>> {
    // Hold the state lock across the whole load→persist so a concurrent tick or
    // telemetry write can't clobber the claimed-reward update. snapshot() runs
    // after the lock so it reflects the committed state.
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
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
        await persistAndReport(state, events);
        return;
      }

      if (!canClaimReward(reward)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        });
        await persistAndReport(state, events);
        return;
      }

      try {
        const claimed = await deps.createAdapters(emit)[message.platform].claimReward(campaign, reward);
        const nextCampaigns = campaigns.map((item) => {
          if (item.id !== campaign.id) return item;
          const rewards = item.rewards.map((candidate) => candidate.id === reward.id && claimed
            ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
            : candidate);
          return {
            ...item,
            rewards,
            status: rewards.every((candidate) => candidate.status === "claimed") ? "completed" as const : item.status,
          };
        });
        const stateWithCampaigns = {
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
        const settings = await deps.loadSettings();
        if (claimed && settings.notifyRewardEarned) {
          await safeNotify(
            await tr("notificationRewardClaimed"),
            await tr("notificationRewardFromCampaign", [reward.name, campaign.name]),
          );
        }
        await persistAndReport(stateWithCampaigns, events);
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "error",
          message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
        });
        await persistAndReport(state, events);
      }
    }));
    return snapshot();
  }

  async function handleMessage(
    message: RuntimeMessage,
    sender?: { tab?: { id?: number } },
  ): Promise<RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void> {
    if (message.type === "getPlaybackControl") {
      return getPlaybackControl(message, sender?.tab?.id);
    }

    if (message.type === "playbackTelemetry") {
      await recordPlaybackTelemetry(message, sender?.tab?.id);
      return undefined;
    }

    if (message.type === "getSnapshot") {
      return snapshot();
    }

    if (message.type === "setRunning") {
      await updateStoredSettings({ running: message.running });
      await tick();
      return snapshot();
    }

    if (message.type === "setPlatformEnabled") {
      const settings = await updateStoredSettings({
        platform: {
          [message.platform]: {
            enabled: message.enabled,
          },
        },
      });
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "setAutomation") {
      const patch: SettingsPatch = {
        platform: {
          [message.platform]: {
            enabled: message.enabled,
          },
        },
      };
      if (message.enabled) patch.running = true;
      const settings = await updateStoredSettings(patch);
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "saveSettings") {
      const settings = await updateStoredSettings(message.settingsPatch);
      if (message.tickAfterSave && settingsPauseCount === 0 && settings.running && hasEnabledPlatform(settings)) {
        await tick(message.tickAfterSavePlatforms);
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "searchCategories") {
      // The temporary global diagnostics bridge is operation-scoped, so this
      // otherwise read-only adapter call shares the controller operation lock.
      return withStateLock(() => withEventCollector(async (emit, events) => {
        let categories: CategorySearchResult["categories"] = [];
        try {
          categories = await deps.createAdapters(emit)[message.platform].searchCategories?.(message.query) ?? [];
        } catch (error) {
          logActivity("warn", `Category search failed: ${error instanceof Error ? error.message : String(error)}`, message.platform);
        }
        await reportBestEffort(events);
        return { categories };
      }));
    }

    if (message.type === "tickNow") {
      await tick();
      return snapshot();
    }
  }

  async function safeNotify(title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function tr(key: string, substitutions?: string | string[]): Promise<string> {
    const translated = await deps.translate?.(key, substitutions);
    if (translated) return translated;
    const template = EN_RUNTIME_MESSAGES[key] ?? key;
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null
        ? []
        : [substitutions];
    return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
  }

  async function emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(
          await tr("notificationRewardEarned"),
          await tr("notificationRewardFromCampaign", [reward.reward.name, reward.campaign.name]),
        );
      }
    }

    if (settings.notifyNoDropsLeft) {
      const isDropsExhausted = (state: SchedulerState, platform: Platform): boolean =>
        state.sessions[platform].status === "idle"
        && state.campaigns[platform].length > 0
        && state.campaigns[platform].every((campaign) => !hasEarnableReward(campaign));

      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (
          settings.running
          && settings.platform[platform].enabled
          // Only on the transition into the exhausted state, so the
          // notification fires once instead of re-firing every tick (~1/min)
          // for as long as the platform stays out of earnable drops.
          && isDropsExhausted(next, platform)
          && !isDropsExhausted(previous, platform)
        ) {
          await safeNotify(
            await tr("notificationNoDropsLeft"),
            await tr("notificationNoDropsLeftMessage", platformLabel(platform)),
          );
        }
      }
    }
  }

  return {
    ensureAlarm,
    handleStartup,
    handleTabRemoved,
    handleMessage,
    beginSettingsSession,
    endSettingsSession,
    captureTwitchIntegrity,
    tick,
    runWatchHeartbeat,
  };
}

function farmingLifecycleEvents(previous: SchedulerState, next: SchedulerState): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    const before = farmingTarget(previous, platform);
    const after = farmingTarget(next, platform);
    const sameTarget = before?.campaign.id === after?.campaign.id && before?.reward.id === after?.reward.id;
    if (sameTarget) continue;

    if (before) {
      const updatedReward = next.campaigns[platform]
        .find((campaign) => campaign.id === before.campaign.id)
        ?.rewards.find((reward) => reward.id === before.reward.id);
      const reason = updatedReward?.status === "claimed" || updatedReward?.status === "claimable"
        ? "watch_requirement_completed"
        : farmingStopReason(next.sessions[platform]);
      events.push({
        category: "activity",
        platform,
        level: next.sessions[platform].status === "error" ? "error" : "info",
        code: "farming_stopped",
        data: {
          campaignId: before.campaign.id,
          campaignName: before.campaign.name,
          rewardId: before.reward.id,
          rewardName: before.reward.name,
          reason,
        },
      });
    }
    if (after) {
      events.push({
        category: "activity",
        platform,
        level: "info",
        code: "farming_started",
        data: {
          campaignId: after.campaign.id,
          campaignName: after.campaign.name,
          rewardId: after.reward.id,
          rewardName: after.reward.name,
          ...(after.session.channel ? { channel: after.session.channel.displayName ?? after.session.channel.username } : {}),
        },
      });
    } else if (!before) {
      const session = next.sessions[platform];
      const prior = previous.sessions[platform];
      const changed = session.status !== prior.status || session.message !== prior.message;
      const actionable = session.status === "error" || session.reasonCode === "manual_watch";
      if (changed && actionable) {
        const reason = farmingStopReason(session);
        events.push({
          category: "activity",
          platform,
          level: session.status === "error" ? "error" : "warn",
          code: "interruption",
          data: { reason, ...(session.message ? { detail: session.message } : {}) },
        });
      }
    }
  }
  return events;
}

function runtimeRestartEvents(state: SchedulerState): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    const target = farmingTarget(state, platform);
    if (!target) continue;
    events.push({
      category: "activity",
      code: "farming_stopped",
      level: "info",
      platform,
      data: {
        campaignId: target.campaign.id,
        campaignName: target.campaign.name,
        rewardId: target.reward.id,
        rewardName: target.reward.name,
        reason: "runtime_restart",
      },
    });
  }
  return events;
}

function farmingTarget(state: SchedulerState, platform: Platform): {
  session: WatchSession;
  campaign: DropCampaign;
  reward: DropReward;
} | undefined {
  const session = state.sessions[platform];
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = state.campaigns[platform].find((candidate) => candidate.id === session.campaignId);
  const reward = campaign?.rewards.find((candidate) => candidate.id === session.rewardId);
  return campaign && reward ? { session, campaign, reward } : undefined;
}

function farmingStopReason(session: WatchSession): FarmingStopReason {
  const code = session.reasonCode;
  return code && isFarmingStopReason(code)
    ? code
    : session.status === "error" ? "platform_error" : "target_changed";
}

function isFarmingStopReason(code: WatchReasonCode): code is FarmingStopReason {
  return ![
    "eligible_campaign",
    "watch_queue_selected",
    "no_eligible_channel",
    "no_existing_session",
    "keeping_current_watch",
    "keeping_watch_queue",
  ].includes(code);
}

function staleStartupCleanup(state: SchedulerState): {
  hasStaleSession: boolean;
  managedUrls: string[];
  state: SchedulerState;
} {
  let hasStaleSession = false;
  const managedUrls = new Set<string>();
  const sessions = { ...state.sessions };

  for (const platform of ["twitch", "kick"] as Platform[]) {
    const session = state.sessions[platform];
    const managedTab = state.managedWatchTabs?.[platform];
    const managedPageContextTab = state.managedPageContextTabs?.[platform];
    if (managedTab?.channelUrl) managedUrls.add(managedTab.channelUrl);
    if (managedPageContextTab?.originUrl) managedUrls.add(managedPageContextTab.originUrl);
    if (session.tabManagedByExtension && session.channel?.url) managedUrls.add(session.channel.url);

    if (session.status === "watching" || session.tabId != null || managedTab || managedPageContextTab) {
      hasStaleSession = true;
      sessions[platform] = pausedStartupSession(session);
    }
  }

  return {
    hasStaleSession,
    managedUrls: [...managedUrls],
    state: {
      ...state,
      sessions,
      managedWatchTabs: {},
      managedPageContextTabs: {},
    },
  };
}

function pausedStartupSession(session: WatchSession): WatchSession {
  return {
    ...session,
    status: "paused",
    channel: undefined,
    campaignId: undefined,
    rewardId: undefined,
    tabId: undefined,
    tabManagedByExtension: undefined,
    playback: undefined,
    playbackChecks: 0,
    errorChecks: 0,
    retryAfter: undefined,
    message: "Browser restarted; farming paused",
    reasonCode: "runtime_restart",
  };
}

function hasEnabledPlatform(settings: EngineSettings): boolean {
  return (["twitch", "kick"] as Platform[]).some((platform) => settings.platform[platform].enabled);
}

function newlyEarnedRewards(
  previous: SchedulerState,
  next: SchedulerState,
): Array<{ campaign: DropCampaign; reward: DropReward }> {
  const previousStatuses = new Map<string, DropReward["status"]>();
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of previous.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        previousStatuses.set(`${platform}:${campaign.id}:${reward.id}`, reward.status);
      }
    }
  }

  const earned: Array<{ campaign: DropCampaign; reward: DropReward }> = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of next.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        const before = previousStatuses.get(`${platform}:${campaign.id}:${reward.id}`);
        if ((reward.status === "claimable" || reward.status === "claimed") && before !== reward.status) {
          earned.push({ campaign, reward });
        }
      }
    }
  }
  return earned;
}

function hasEarnableReward(campaign: DropCampaign): boolean {
  return campaign.status === "active"
    && !hasCampaignEnded(campaign)
    && campaign.accountLinked !== false
    && (!campaign.eligibility || campaign.eligibility === "eligible")
    && campaign.rewards.some((reward) => reward.isWatchBased !== false && reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
}

function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

function platformLabel(platform: Platform): string {
  return platform === "twitch" ? "Twitch" : "Kick";
}
