import type { PlaybackControl, RuntimeMessage, RuntimeSnapshot } from "../core/messages";
import type { AdFocusMode, DropCampaign, DropReward, EventLogEntry, ExtensionSettings, Platform, PlaybackTelemetry, SchedulerState, WatchSession } from "../core/models";
import { appendLog } from "../core/logging";
import { mergeSettings } from "../core/settings";
import { MANUAL_WATCH_TTL_MS, runSchedulerTick } from "../core/scheduler";
import { setActivityLogger } from "../core/activityLog";
import { setTwitchIntegrity } from "../core/tabs";
import { integrityFromHeaders } from "../core/twitchIntegrity";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController, WatchContext } from "../core/tablessWatch";

export const ALARM_NAME = "stream-autopilot.tick";
// A separate, fixed 1-minute alarm drives tabless watch heartbeats independently
// of the (heavier, configurable) discovery tick. chrome.alarms clamps to a
// 1-minute minimum, close enough to TwitchDropsMiner's 59s send cadence.
export const WATCH_ALARM_NAME = "stream-autopilot.watch";
const PLATFORMS: Platform[] = ["twitch", "kick"];

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

export interface BackgroundControllerDeps {
  loadSettings(): Promise<ExtensionSettings>;
  saveSettings(settings: ExtensionSettings): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  createAlarm(name: string, options: { periodInMinutes: number }): Promise<void>;
  createAdapters(): Record<Platform, PlatformAdapter>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  closeManagedTabsByUrl?(urls: string[]): Promise<void>;
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode): Promise<void>;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
}

export function createBackgroundController(deps: BackgroundControllerDeps) {
  // tabs.ts is a pure module with no access to scheduler state, so it reports
  // lifecycle/ad-focus events through this sink. They are buffered and merged
  // into the very state object being saved (see persist) to avoid a load/save
  // race with an in-flight tick clobbering them.
  const pendingTabEvents: Array<Omit<EventLogEntry, "id" | "at">> = [];
  setActivityLogger((level, message, platform) => {
    pendingTabEvents.push({ level, message, platform });
  });

  // Persistent tabless watchers, one per platform, kept alive across discovery
  // ticks (the WebSocket-based Kick watcher in particular must not be recreated
  // each tick). Reconciled against the scheduler's per-platform session state.
  const tablessWatchers = new Map<Platform, TablessWatchController>();

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
      pendingTabEvents.push({
        level: "debug",
        platform: "twitch",
        message: `No stored Twitch integrity token to prime (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }

  // Fed by the background's webRequest listener with the outgoing headers of
  // gql.twitch.tv requests. Only genuine page-minted requests carry a
  // Client-Integrity header, so integrityFromHeaders returns undefined (and we
  // ignore) our own background fetch and anonymous queries.
  async function captureTwitchIntegrity(headers: IntegrityHeader[] | undefined): Promise<void> {
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    const isNew = integrity.integrity !== lastIntegrityToken;
    setTwitchIntegrity(integrity, { isNew });
    if (!isNew) return;
    lastIntegrityToken = integrity.integrity;
    await deps.saveTwitchIntegrity?.(integrity);
  }

  async function persist(state: SchedulerState): Promise<void> {
    if (pendingTabEvents.length === 0) {
      await deps.saveState(state);
      return;
    }
    const verbose = (await deps.loadSettings()).verboseLogging;
    let next = state;
    for (const entry of pendingTabEvents.splice(0)) {
      next = withEvent(next, entry, verbose);
    }
    await deps.saveState(next);
  }

  // Appends an event unless it is debug while verbose logging is off.
  function withEvent(state: SchedulerState, entry: Omit<EventLogEntry, "id" | "at">, verbose: boolean): SchedulerState {
    if (entry.level === "debug" && !verbose) return state;
    return appendLog(state, entry);
  }

  function appendPlaybackEvents(
    state: SchedulerState,
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
    verbose: boolean,
  ): SchedulerState {
    let next = state;
    const log = (level: EventLogEntry["level"], message: string) => {
      next = withEvent(next, { platform, level, message }, verbose);
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
    return next;
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
        await deps.saveSettings(mergeSettings({ ...settings, running: false }));
      }
      return;
    }

    if (deps.closeManagedTabsByUrl) {
      await deps.closeManagedTabsByUrl(cleanup.managedUrls);
    }

    let nextSettings = settings;
    if (settings.running && !settings.autoStartDropFarming) {
      nextSettings = mergeSettings({ ...settings, running: false });
      await deps.saveSettings(nextSettings);
    }

    await persist(appendLog(cleanup.state, {
      level: "info",
      message: settings.running && settings.autoStartDropFarming
        ? "Browser restart detected; cleared stale farming tabs before resuming"
        : "Browser restart detected; paused farming and cleared stale farming tabs",
    }));

    if (nextSettings.running && nextSettings.autoStartDropFarming) {
      await tick();
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  async function tick(platforms?: Platform[]): Promise<void> {
    await withStateLock(async () => {
      const settings = await deps.loadSettings();
      const state = await deps.loadState();
      const verbose = settings.verboseLogging;

      try {
        const adapters = deps.createAdapters();
        const result = await runSchedulerTick(state, settings, adapters, platforms ? { platforms } : undefined);
        await emitNotifications(settings, state, result.state);
        await applyAdFocusForState(settings, result.state);
        await reconcileTablessWatchers(result.state, settings, adapters, platforms);
        // The per-tick heartbeat is debug noise next to the richer per-platform
        // entries the scheduler already records; the popup shows "last check" too.
        await persist(withEvent(result.state, { level: "debug", message: "Scheduler tick completed" }, verbose));
      } catch (error) {
        await persist(withEvent(state, {
          level: "error",
          message: error instanceof Error ? error.message : "Scheduler tick failed",
        }, verbose));
      }
    });
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
    const manualPlatforms = (["twitch", "kick"] as Platform[]).filter((platform) => state.manualWatch?.[platform]?.tabId === tabId);
    if (manualPlatforms.length > 0) {
      const manualWatch = { ...state.manualWatch };
      for (const platform of manualPlatforms) delete manualWatch[platform];
      await persist({
        ...state,
        manualWatch,
      });
    }
    if (!settings.running) return;

    for (const platform of ["twitch", "kick"] as Platform[]) {
      const session = state.sessions[platform];
      if (
        settings.platform[platform].enabled
        && session.status === "watching"
        && session.tabManagedByExtension
        && session.tabId === tabId
      ) {
        pendingTabEvents.push({ platform, level: "info", message: "Managed watch tab was closed; re-running scheduler" });
        await tick();
        return;
      }
    }
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
    settings: ExtensionSettings,
    adapters: Record<Platform, PlatformAdapter>,
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
            pendingTabEvents.push({
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
    const settings = await deps.loadSettings();
    if (!settings.running) return;
    const verbose = settings.verboseLogging;

    const fallbackPlatforms = await withStateLock<Platform[]>(async () => {
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
      await reconcileTablessWatchers(nextState, settings, deps.createAdapters());
      if (tablessWatchers.size === 0) return [];

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
          nextState = withEvent(nextState, { platform, level: "info", message: "Tabless watch heartbeat recovered" }, verbose);
        } else if (!ok && previousChecks === 0) {
          nextState = withEvent(nextState, { platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" }, verbose);
        }
        if (!ok && heartbeatChecks >= settings.offlineRetryLimit && !fallbacks.includes(platform)) {
          fallbacks.push(platform);
          nextState = withEvent(nextState, { platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" }, verbose);
        }
      }

      if (changed) await persist(nextState);
      return fallbacks;
    });

    // chooseTablessWatch now sees heartbeatChecks past the limit and opens a tab.
    // Run outside the lock: tick() acquires the lock itself.
    for (const platform of fallbackPlatforms) {
      await tick([platform]);
    }
  }

  async function recordPlaybackTelemetry(
    message: Extract<RuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
  ): Promise<void> {
    await withStateLock(async () => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          await persist(recordManualWatchTelemetry(state, settings, message, senderTabId));
        }
        return;
      }

      const previous = session.playback;
      const telemetry = message.telemetry;
      const verbose = settings.verboseLogging;
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
      if (session.status === "watching") {
        nextState = appendPlaybackEvents(nextState, message.platform, previous, telemetry, verbose);
      }

      await persist(nextState);

      if (deps.applyAdFocus && session.status === "watching" && session.tabId === senderTabId) {
        await deps.applyAdFocus(message.platform, session.tabId, Boolean(message.telemetry.adActive), settings.adFocusMode);
      }
    });
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: ExtensionSettings,
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

  async function applyAdFocusForState(settings: ExtensionSettings, state: SchedulerState): Promise<void> {
    if (!deps.applyAdFocus) return;
    for (const platform of ["twitch", "kick"] as Platform[]) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      await deps.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive), settings.adFocusMode);
    }
  }

  async function getPlaybackControl(
    message: Extract<RuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
      keepVideosUnmuted: settings.keepFarmingVideosUnmuted !== false,
    };
  }

  async function claimRewardNow(
    message: Extract<RuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot> {
    // Hold the state lock across the whole load→persist so a concurrent tick or
    // telemetry write can't clobber the claimed-reward update. snapshot() runs
    // after the lock so it reflects the committed state.
    await withStateLock(async () => {
      const state = await deps.loadState();
      const campaigns = state.campaigns[message.platform];
      const campaign = campaigns.find((item) => item.id === message.campaignId);
      const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

      if (!campaign || !reward) {
        await persist(appendLog(state, {
          platform: message.platform,
          level: "warn",
          message: "Reward claim skipped because the campaign or reward is no longer available",
        }));
        return;
      }

      if (!canClaimReward(reward)) {
        await persist(appendLog(state, {
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        }));
        return;
      }

      try {
        const claimed = await deps.createAdapters()[message.platform].claimReward(campaign, reward);
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
        const nextState = appendLog({
          ...state,
          campaigns: {
            ...state.campaigns,
            [message.platform]: nextCampaigns,
          },
        }, {
          platform: message.platform,
          level: claimed ? "info" : "warn",
          message: claimed
            ? `Claimed ${reward.name} from ${campaign.name}`
            : `Could not claim ${reward.name} from ${campaign.name}`,
        });
        const settings = settingsWithDefaults(await deps.loadSettings());
        if (claimed && settings.notifyRewardEarned) {
          await safeNotify(settings, "Reward claimed", `${reward.name} from ${campaign.name}`);
        }
        await persist(nextState);
      } catch (error) {
        await persist(appendLog(state, {
          platform: message.platform,
          level: "error",
          message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
        }));
      }
    });
    return snapshot();
  }

  async function handleMessage(
    message: RuntimeMessage,
    sender?: { tab?: { id?: number } },
  ): Promise<RuntimeSnapshot | PlaybackControl | void> {
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
      const settings = mergeSettings({ ...(await deps.loadSettings()), running: message.running });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      await tick();
      return snapshot();
    }

    if (message.type === "setPlatformEnabled") {
      const current = await deps.loadSettings();
      const settings = mergeSettings({
        ...current,
        platform: {
          ...current.platform,
          [message.platform]: {
            ...current.platform[message.platform],
            enabled: message.enabled,
          },
        },
      });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "setAutomation") {
      const current = await deps.loadSettings();
      const settings = mergeSettings({
        ...current,
        running: message.enabled ? true : current.running,
        platform: {
          ...current.platform,
          [message.platform]: {
            ...current.platform[message.platform],
            enabled: message.enabled,
          },
        },
      });
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (settings.running) await tick();
      return snapshot();
    }

    if (message.type === "saveSettings") {
      const settings = mergeSettings(message.settings);
      await deps.saveSettings(settings);
      await deps.createAlarm(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
      if (message.tickAfterSave && settings.running && hasEnabledPlatform(settings)) {
        await tick(message.tickAfterSavePlatforms);
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "tickNow") {
      await tick();
      return snapshot();
    }
  }

  async function safeNotify(settings: ExtensionSettings, title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function emitNotifications(
    settings: ExtensionSettings,
    previous: SchedulerState,
    next: SchedulerState,
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(settings, "Reward earned", `${reward.reward.name} from ${reward.campaign.name}`);
      }
    }

    if (settings.notifyNoDropsLeft) {
      for (const platform of ["twitch", "kick"] as Platform[]) {
        const session = next.sessions[platform];
        if (
          settings.running
          && settings.platform[platform].enabled
          && session.status === "idle"
          && next.campaigns[platform].length > 0
          && next.campaigns[platform].every((campaign) => !hasEarnableReward(campaign))
        ) {
          await safeNotify(settings, "No drops left", `${platformLabel(platform)} has no eligible drops to farm.`);
        }
      }
    }
  }

  return {
    ensureAlarm,
    handleStartup,
    handleTabRemoved,
    handleMessage,
    captureTwitchIntegrity,
    tick,
    runWatchHeartbeat,
  };

  function settingsWithDefaults(settings: ExtensionSettings): ExtensionSettings {
    return mergeSettings(settings);
  }
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
  };
}

function hasEnabledPlatform(settings: ExtensionSettings): boolean {
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
    && campaign.rewards.some((reward) => reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
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
