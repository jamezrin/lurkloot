import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, resetStorage, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import type { CliCredentialBlob, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import {
  applyAdFocus,
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrity,
  fetchJsonInPage,
  fetchKickInBackground,
  fetchTwitchInBackground,
  openPinnedMutedTab,
  recordManagedPageContextFallback,
  reconcileManagedPageContextRecovery,
  stopManagedPageContextTabs,
  stopWatchTab,
} from "../src/core/tabs";
import { createBackgroundAlarmListener, createBackgroundController } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import { applySettingsPatch } from "@lurkloot/shared/settings";
import { effectiveLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import type { ExtensionSettings, Platform, SupportedLocale } from "@lurkloot/shared/models";
import { withActivityDiagnostics } from "@lurkloot/core/activityDiagnostics";
import type { EventEmitter, EngineEvent } from "@lurkloot/shared/events";
import type { WatchTabPort } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/webSocket";
import { createKickFetcher, KickAdapter, KickClaimState, KickDiscoveryState, KickPageContextRecoveryTracker } from "@lurkloot/core/kick";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { isMinorOrMajorBump } from "../src/core/version";
import { savePendingChangelogVersion } from "../src/core/updateNotice";
import { appendActivityEvents, clearActivityEvents, exportDiagnosticsEvents, loadActivityEvents } from "../src/core/activityStorage";
import {
  createActivityEventReporter,
  createActivityMessageHandler,
  createRuntimeMessageDispatcher,
} from "../src/core/activityMessages";
import { twitchHeartbeatFetchText, twitchHeartbeatPost } from "../src/core/twitchHeartbeatTransport";
import { createCredentialAvailabilityProvider } from "../src/core/credentialAvailability";
import { createTwitchExtensionHost } from "../src/extensions/host";
import { createTwitchExtensionSessionSource } from "../src/extensions/transport";
import { createFortniteDriver } from "../src/extensions/fortnite/driver";
import { createNoPixelDriver } from "../src/extensions/nopixel/driver";
import { createCredentialHealthObserver } from "../src/core/credentialObserver";

const localeCatalogs = new Map<string, MessageCatalog | undefined>();
const getMessage = browser.i18n.getMessage as (key: string, substitutions?: string | string[]) => string;
const handleActivityMessage = createActivityMessageHandler({
  load: loadActivityEvents,
  exportDiagnostics: exportDiagnosticsEvents,
  clear: clearActivityEvents,
});
const reportEvents = createActivityEventReporter({
  loadDiagnosticLogging: async () => (await loadSettings()).diagnosticLogging,
  append: appendActivityEvents,
});
const kickClaimState = new KickClaimState();
const kickDiscoveryState = new KickDiscoveryState();
const kickPageContextRecovery = new KickPageContextRecoveryTracker();
const twitchDiscoveryState = new TwitchDiscoveryState();
const KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory";
const createBrowserWebSocket: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;
const checkCredentialAvailability = createCredentialAvailabilityProvider({
  get: (details) => browser.cookies.get(details),
});

async function catalog(locale: string): Promise<MessageCatalog | undefined> {
  if (localeCatalogs.has(locale)) return localeCatalogs.get(locale);
  const loaded = await loadCatalog(locale as SupportedLocale);
  localeCatalogs.set(locale, loaded);
  return loaded;
}

// The engine no longer carries the locale; the host resolves it from its own
// settings on demand.
async function translate(key: string, substitutions?: string | string[]): Promise<string> {
  const { languageOverride } = await loadSettings();
  if (languageOverride === "browser") {
    const message = getMessage(key, substitutions);
    if (message) return message;
  }
  const locale = effectiveLocale(languageOverride, browser.i18n.getUILanguage());
  const [active, fallback] = await Promise.all([catalog(locale), catalog("en")]);
  return translateFromCatalogs(key, substitutions, active, fallback ?? {});
}

function createExtensionAdapter(platform: Platform, emit: EventEmitter, settings: ExtensionSettings) {
  const resolution = resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" });
  // The watch-tab port is operation-scoped so every browser diagnostic joins
  // the same controller event batch as the adapter and scheduler events.
  const watchTabPort: WatchTabPort = {
    openPinnedMutedTab: async (channel, session, options) => {
      const settings = await loadSettings();
      return openPinnedMutedTab(channel, session, {
        muted: settings.muteFarmingTabs,
        keepVideosUnmuted: settings.keepFarmingVideosUnmuted,
        closeManagedTabs: settings.autoCloseFinishedDrops,
        ...options,
      }, emit);
    },
    stopWatchTab: async (session, options) => {
      const settings = await loadSettings();
      return stopWatchTab(session, { closeManagedTabs: settings.autoCloseFinishedDrops, ...options }, emit);
    },
  };
  const adapter = platform === "twitch"
    ? new TwitchAdapter(
      { fetchJson: (url, init) => fetchTwitchInBackground(url, init) },
      (request) => ensureTwitchIntegrity(emit, request),
      watchTabPort,
      {
        compatibility: resolution.compatibility.twitch,
        discoveryState: twitchDiscoveryState,
        strictCampaignAvailability: settings.platform.twitch.strictCampaignAvailability,
        currentIntegrity: currentValidTwitchIntegrity,
        heartbeatIdentity: "web",
        heartbeatFetchText: twitchHeartbeatFetchText,
        heartbeatPost: twitchHeartbeatPost,
        webSocketFactory: createBrowserWebSocket,
        getAuthToken: async () => (
          await browser.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" })
        )?.value,
      },
      emit,
    )
    : new KickAdapter(
      createKickFetcher({
        routeState: kickDiscoveryState.routeDiagnostics,
        background: (url, init) => fetchKickInBackground<unknown>(url, init),
        pageFetch: (url, init) => fetchJsonInPage<unknown>(KICK_PAGE_CONTEXT_URL, url, init, {
          retainPageContext: { platform: "kick" },
          emit,
          openReason: "background_rejected",
        }),
        onBackgroundSuccess: (host) => kickPageContextRecovery.recordBackgroundSuccess(host),
        onPageFallback: (host, operationEmit) => {
          kickPageContextRecovery.recordPageFallback(host);
          recordManagedPageContextFallback(host, operationEmit);
        },
      }),
      watchTabPort,
      createBrowserWebSocket,
      { compatibility: resolution.compatibility.kick, claimState: kickClaimState, discoveryState: kickDiscoveryState },
      emit,
    );
  return { adapter, ...resolution };
}

const controller = createBackgroundController<ExtensionSettings>({
  loadSettings,
  saveSettings,
  loadState,
  saveState,
  reportEvents,
  checkCredentialAvailability,
  createAlarm: (name, options) => browser.alarms.create(name, options),
  getAlarm: async (name) => {
    const alarm = await browser.alarms.get(name);
    return alarm ? { scheduledTime: alarm.scheduledTime } : undefined;
  },
  clearAlarm: (name) => browser.alarms.clear(name),
  ensureTwitchIntegrity: (emit, request) => ensureTwitchIntegrity(emit, request),
  cancelTwitchIntegrityAcquisition,
  closeManagedTabs: async (tabs) => {
    await Promise.all(tabs.map(async ({ tabId, channelUrl }) => {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.id === tabId && tab.url === channelUrl) await browser.tabs.remove(tabId);
      } catch {
        // The recorded tab may already be closed or its id may be stale.
      }
    }));
  },
  createNotification: async ({ title, message }) => {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title,
      message,
    });
  },
  translate,
  applySettingsPatch,
  applyAdFocus: async (platform, tabId, adActive, emit) => {
    const { adFocusMode } = await loadSettings();
    await applyAdFocus(platform, tabId, adActive, adFocusMode, emit);
  },
  loadTabPlaybackPolicy: async () => ({ keepVideosUnmuted: (await loadSettings()).keepFarmingVideosUnmuted !== false }),
  loadTwitchIntegrity,
  saveTwitchIntegrity,
  stopPageContextTabs: (contexts, options) => stopManagedPageContextTabs(contexts, options),
  reconcilePageContextRecovery: async (platform, settings, options, emit) => {
    if (platform !== "kick") return false;
    const observation = kickPageContextRecovery.take();
    if (!observation) return false;
    if (!options.countBackgroundSuccess) observation.backgroundHosts = [];
    try {
      return await reconcileManagedPageContextRecovery(
        platform,
        observation,
        settings.kickPageContextRecoverySuccesses,
        emit,
      );
    } catch (error) {
      kickPageContextRecovery.restore(observation);
      throw error;
    }
  },
  discardPageContextRecoveryEvidence: (platform) => {
    if (platform === "kick") kickPageContextRecovery.discard();
  },
  selectSupplementalWatchTarget: (platform, state, settings, signal) => platform === "twitch" ? extensionHost.chooseWatchTarget(settings, state, signal) : Promise.resolve(undefined),
  createAdapter: createExtensionAdapter,
  createAdapters: (emit, settings) => {
    const twitch = createExtensionAdapter("twitch", emit, settings);
    const kick = createExtensionAdapter("kick", emit, settings);
    return {
      adapters: {
        twitch: twitch.adapter,
        kick: kick.adapter,
      },
      compatibility: twitch.compatibility,
      warnings: twitch.warnings,
    };
  },
});

const extensionHost = createTwitchExtensionHost({
  source: createTwitchExtensionSessionSource({
    hasSession: async () => (await checkCredentialAvailability("twitch")).status === "available",
    fetchJson: (url, init) => fetchTwitchInBackground(url, init),
  }),
  permissions: {
    request: (details) => browser.permissions.request(details),
    contains: (details) => browser.permissions.contains(details),
  },
  drivers: {
    fortnite: async (session, emit, channel) => createFortniteDriver({ allowTakeovers: (await loadSettings()).twitchExtensions.fortnite.allowTakeovers, onTakeoverStarted: () => {
      if (!channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
      const events: EngineEvent[] = [];
      withActivityDiagnostics((event) => events.push(event))({ category: "activity", code: "twitch_extension_action", level: "info", platform: "twitch", data: { provider: "fortnite", action: "takeover_started", channel: channel.username } });
      void reportEvents(events).catch(() => undefined);
    }, createSocket: (url) => new WebSocket(url), onCaptured: () => {
      if (!channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
      const events: EngineEvent[] = [];
      withActivityDiagnostics((event) => events.push(event))({ category: "activity", code: "twitch_extension_action", level: "info", platform: "twitch", data: { provider: "fortnite", action: "sprite_captured", channel: channel.username } });
      void reportEvents(events).catch(() => undefined);
    } })(session, emit),
    nopixel: (session, emit, channel) => createNoPixelDriver((url, init) => fetch(url, init), () => {
      if (!channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
      const events: EngineEvent[] = [];
      withActivityDiagnostics((event) => events.push(event))({ category: "activity", code: "twitch_extension_action", level: "info", platform: "twitch", data: { provider: "nopixel", action: "giveaway_joined", channel: channel.username } });
      void reportEvents(events).catch(() => undefined);
    })(session, emit),
  },
  loadSettings,
  loadState,
  savePatch: async (settingsPatch) => { await controller.handleMessage({ type: "saveSettings", settingsPatch }); },
  diagnostic: (message) => { void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message }]).catch(() => undefined); },
});

async function reconcileExtensions(): Promise<void> {
  try { await extensionHost.reconcile(); }
  catch {
    // Never include transport/provider exceptions or payloads in diagnostics.
    void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message: "Twitch Extension background reconciliation failed." }]).catch(() => undefined);
  }
}

function withExtensionSnapshot(value: unknown): unknown {
  if (value && typeof value === "object" && "state" in value && "settings" in value) {
    const snapshot = value as RuntimeSnapshot<ExtensionSettings>;
    return { ...snapshot, state: { ...snapshot.state, twitchExtensions: extensionHost.snapshot() } };
  }
  return value;
}

// Builds the CLI credential blob from the user's live session cookies: Twitch
// auth-token / unique_id and Kick session_token — exactly what the headless
// transports replay. Reads only these; nothing else leaves the browser.
async function buildCliCredentialBlob(): Promise<CliCredentialBlob> {
  const cookie = async (url: string, name: string): Promise<string | undefined> =>
    (await browser.cookies.get({ url, name }))?.value;
  return {
    version: 1,
    credentials: {
      twitch: {
        authToken: await cookie("https://www.twitch.tv", "auth-token"),
        deviceId: await cookie("https://www.twitch.tv", "unique_id"),
      },
      kick: {
        sessionToken: await cookie("https://kick.com", "session_token"),
      },
    },
  };
}

let resetMutation: Promise<RuntimeSnapshot<ExtensionSettings>> | undefined;

function resetExtension(): Promise<RuntimeSnapshot<ExtensionSettings>> {
  if (resetMutation) return resetMutation;
  resetMutation = (async () => {
    extensionHost.invalidate();
    await controller.prepareForHostReset(async () => {
      kickClaimState.clear();
      await resetStorage();
    });
    return await controller.handleMessage({ type: "getSnapshot" }) as RuntimeSnapshot<ExtensionSettings>;
  })().finally(() => {
    resetMutation = undefined;
  });
  return resetMutation;
}

// Credential export reads the user's live session cookies, which only the
// extension can do. Keep it ahead of activity routing and core delegation.
const dispatchRuntimeMessage = createRuntimeMessageDispatcher({
  exportCliCredentials: buildCliCredentialBlob,
  resetExtension,
  handleActivityMessage,
  handleTwitchExtensionMessage: (message) => extensionHost.setEnabled(message.provider, message.enabled),
  handleCoreMessage: async (message, sender) => withExtensionSnapshot(await controller.handleMessage(message, sender)),
});

export default defineBackground(() => {
  createCredentialHealthObserver(
    {
      addListener: (listener) => browser.cookies.onChanged.addListener(listener),
      removeListener: (listener) => browser.cookies.onChanged.removeListener(listener),
    },
    {
      invalidateAuthHealth: (platform) => {
        if (platform === "twitch") extensionHost.invalidate();
        return controller.invalidateAuthHealth(platform);
      },
      checkAuthHealth: async (platform) => {
        await controller.checkAuthHealth(platform);
        if (platform === "twitch") await reconcileExtensions();
      },
    },
  );

  browser.permissions.onRemoved.addListener((details) => {
    void extensionHost.removed(details).catch(() => undefined);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const settingsChange = changes.settings;
    const stateChange = changes.schedulerState;
    if (!settingsChange && !stateChange) return;
    // Cancellation precedes asynchronous reads whenever authority changes.
    if (settingsChange) {
      const previous = settingsChange.oldValue as ExtensionSettings | undefined;
      const next = settingsChange.newValue as ExtensionSettings | undefined;
      if (previous?.pauseOnManualWatch !== next?.pauseOnManualWatch
        || previous?.platform?.twitch?.enabled !== next?.platform?.twitch?.enabled
        || previous?.twitchExtensions?.nopixel?.enabled !== next?.twitchExtensions?.nopixel?.enabled
        || previous?.twitchExtensions?.fortnite?.enabled !== next?.twitchExtensions?.fortnite?.enabled
        || previous?.twitchExtensions?.fortnite?.allowTakeovers !== next?.twitchExtensions?.fortnite?.allowTakeovers) extensionHost.invalidate();
    }
    if (stateChange) {
      const previous = stateChange.oldValue as RuntimeSnapshot["state"] | undefined;
      const next = stateChange.newValue as RuntimeSnapshot["state"] | undefined;
      if (Boolean(previous?.manualClosePause?.twitch) !== Boolean(next?.manualClosePause?.twitch)
        || previous?.manualWatch?.twitch?.active !== next?.manualWatch?.twitch?.active
        || previous?.sessions?.twitch?.status !== next?.sessions?.twitch?.status
        || previous?.sessions?.twitch?.channel?.channelId !== next?.sessions?.twitch?.channel?.channelId
        || previous?.authHealth?.twitch?.status !== next?.authHealth?.twitch?.status) extensionHost.invalidate();
    }
    void reconcileExtensions();
  });
  // Runs on every MV3 wake/MV2 background start. Stored grants are verified;
  // provider credentials/resources are reacquired rather than restored.
  void reconcileExtensions();

  browser.runtime.onInstalled.addListener(async (details) => {
    await controller.ensureAlarm();
    // Stamp the install date once so the popup can time the rate/review nudge.
    // Set-if-missing (rather than gating on reason === "install") also backfills
    // a sane date for users upgrading from a pre-nudge version.
    await controller.ensureInstalledAt();

    // On a meaningful update (major/minor — not a patch bugfix, not a fresh
    // install), queue a popup notice so returning users can choose to see
    // what's new without an unsolicited browser tab interrupting them.
    const currentVersion = browser.runtime.getManifest().version;
    if (details.reason === "update" && isMinorOrMajorBump(details.previousVersion, currentVersion)) {
      await savePendingChangelogVersion(currentVersion);
    }
  });

  browser.runtime.onStartup.addListener(async () => {
    await controller.handleStartup();
    await reconcileExtensions();
  });

  browser.alarms.onAlarm.addListener(createBackgroundAlarmListener(controller));
  browser.alarms.onAlarm.addListener(() => { void reconcileExtensions(); });

  async function reconsiderTab(tabId: number, url: string | undefined): Promise<void> {
    if (!url) return;
    await controller.handleTabUpdated(tabId, url);
    // Ask for current playback rather than interpreting a platform URL as watching.
    try {
      const parsed = new URL(url);
      if (!["twitch.tv", "www.twitch.tv", "kick.com", "www.kick.com"].includes(parsed.hostname)) return;
      await browser.tabs.sendMessage(tabId, { type: "requestPlaybackTelemetry" });
    } catch {
      // A newly opened/navigating tab may not have its content script yet.
      // Its initial report and periodic telemetry cover that case.
    }
  }

  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id != null) void reconsiderTab(tab.id, tab.pendingUrl ?? tab.url);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      void reconsiderTab(tabId, changeInfo.url ?? tab.url);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void controller.handleTabRemoved(tabId);
  });

  // Capture the Client-Integrity token the live twitch.tv page sends on its own
  // GQL requests so the background can replay it on authenticated mutations
  // (drop claims). Registered at top level so it re-binds on each SW wake.
  // requestHeaders exposes the custom Client-Integrity header; if a future
  // Chrome build hides it, add "extraHeaders" to this spec.
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      void controller.captureTwitchIntegrity(details.requestHeaders, details.tabId);
      return undefined;
    },
    { urls: ["https://gql.twitch.tv/*"] },
    ["requestHeaders"],
  );

  browser.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    void dispatchRuntimeMessage(message, sender).then(sendResponse, () => sendResponse({ error: "request-failed" }));
    return true;
  });

});
