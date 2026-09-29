import { createTwitchExtensionGrantCompletion } from "../src/extensions/grantCompletion";
import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, resetStorage, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import { createBrowserTabs, liveBrowserTabApi } from "../src/core/tabs";
import { createExtensionTabPorts } from "../src/core/tabPorts";
import { createTabRegistry } from "@lurkloot/core/tabRegistry";
import { createBackgroundAlarmListener, createBackgroundController, EXTENSION_CAPABILITIES } from "@lurkloot/core/controller";
import { createAlarmJobScheduler } from "../src/core/jobs";
import { resolveCompatibility } from "@lurkloot/core";
import { applySettingsPatch } from "@lurkloot/shared/settings";
import { effectiveLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import type { ExtensionSettings, Platform, SupportedLocale } from "@lurkloot/shared/models";
import { withActivityDiagnostics } from "@lurkloot/core/activityDiagnostics";
import type { EventEmitter, EngineEvent } from "@lurkloot/shared/events";
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
import { buildCliCredentialBlob } from "../src/core/cliCredentialExport";

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
// One tab registry for this controller, shared by the browser tab mechanics
// and the controller that reads its page-context snapshot (#598).
const tabRegistry = createTabRegistry();
const {
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrity,
  fetchJsonInPage,
  fetchKickInBackground,
  fetchTwitchInBackground,
  recordManagedPageContextFallback,
} = createBrowserTabs(tabRegistry);
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
  const adapter = platform === "twitch"
    ? new TwitchAdapter(
      { fetchJson: (url, init) => fetchTwitchInBackground(url, init) },
      (request) => ensureTwitchIntegrity(emit, request),
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
      createBrowserWebSocket,
      { compatibility: resolution.compatibility.kick, claimState: kickClaimState, discoveryState: kickDiscoveryState },
      emit,
    );
  return { adapter, ...resolution };
}

const controller = createBackgroundController<ExtensionSettings>({
  capabilities: EXTENSION_CAPABILITIES,
  storage: { loadSettings, saveSettings, loadState, saveState, applySettingsPatch },
  events: {
    report: reportEvents,
    notify: async ({ title, message }) => {
      await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title,
        message,
      });
    },
    translate,
  },
  jobs: createAlarmJobScheduler(browser.alarms),
  tabRegistry,
  credentials: { checkAvailability: checkCredentialAvailability },
  adapters: {
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
  },
  tabs: createExtensionTabPorts(tabRegistry, liveBrowserTabApi, loadSettings, { kick: kickPageContextRecovery }),
  twitch: {
    integrity: {
      ensure: (emit, request) => ensureTwitchIntegrity(emit, request),
      cancelAcquisition: cancelTwitchIntegrityAcquisition,
      load: loadTwitchIntegrity,
      save: saveTwitchIntegrity,
    },
    supplementalSources: {
      select: (state, settings, signal, source) => extensionHost.chooseWatchTarget(settings, state, signal, source),
    },
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
    nopixel: async (session, emit, channel) => createNoPixelDriver((url, init) => fetch(url, init), () => {
      if (!channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
      const events: EngineEvent[] = [];
      withActivityDiagnostics((event) => events.push(event))({ category: "activity", code: "twitch_extension_action", level: "info", platform: "twitch", data: { provider: "nopixel", action: "giveaway_joined", channel: channel.username } });
      void reportEvents(events).catch(() => undefined);
    }, Date.now, (message) => {
      void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message }]).catch(() => undefined);
    }, { autoOpenPacks: (await loadSettings()).twitchExtensions.nopixel.autoOpenPacks, onOpened: () => {
      if (!channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
      const events: EngineEvent[] = [];
      withActivityDiagnostics((event) => events.push(event))({ category: "activity", code: "twitch_extension_action", level: "info", platform: "twitch", data: { provider: "nopixel", action: "pack_opened", channel: channel.username } });
      void reportEvents(events).catch(() => undefined);
    } })(session, emit),
  },
  loadSettings,
  loadState,
  savePatch: async (settingsPatch) => { await controller.handleMessage({ type: "saveSettings", settingsPatch }); },
  diagnostic: (message) => { void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message }]).catch(() => undefined); },
});

const extensionGrantCompletion = createTwitchExtensionGrantCompletion({
  storage: browser.storage.local,
  now: Date.now,
  contains: (details) => browser.permissions.contains(details),
  enable: async (provider) => { await extensionHost.setEnabled(provider, true); await controller.tickAndHandOff(["twitch"], "manual_tick"); },
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

let resetMutation: Promise<RuntimeSnapshot<ExtensionSettings>> | undefined;

function resetExtension(): Promise<RuntimeSnapshot<ExtensionSettings>> {
  if (resetMutation) return resetMutation;
  resetMutation = (async () => {
    await extensionGrantCompletion.cancelAll();
    // Disable invalidates permission generations and drains in-flight enables
    // before reset can finish; a delayed grant cannot commit afterward.
    await Promise.all([extensionHost.setEnabled("nopixel", false), extensionHost.setEnabled("fortnite", false)]);
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
  exportCliCredentials: () => buildCliCredentialBlob(async (url, name) =>
    (await browser.cookies.get({ url, name }))?.value),
  resetExtension,
  handleActivityMessage,
  handleTwitchExtensionMessage: async (message) => {
    await extensionGrantCompletion.cancel(message.provider);
    return extensionHost.setEnabled(message.provider, message.enabled);
  },
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
        // A Twitch cookie change may be a different account, so provider
        // completion learned for the previous viewer is discarded too.
        if (platform === "twitch") extensionHost.invalidate({ forgetCompletion: true });
        return controller.invalidateAuthHealth(platform);
      },
      checkAuthHealth: async (platform) => {
        await controller.checkAuthHealth(platform);
        if (platform === "twitch") await reconcileExtensions();
      },
    },
  );

  browser.permissions.onAdded.addListener((details) => {
    void extensionGrantCompletion.added(details).catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((details) => {
    void extensionGrantCompletion.removed(details).catch(() => undefined);
    void extensionHost.removed(details).catch(() => undefined);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    void extensionGrantCompletion.changed(changes).catch(() => undefined);
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
        || previous?.twitchExtensions?.nopixel?.autoOpenPacks !== next?.twitchExtensions?.nopixel?.autoOpenPacks
        || previous?.twitchExtensions?.fortnite?.allowTakeovers !== next?.twitchExtensions?.fortnite?.allowTakeovers) extensionHost.invalidate();
    }
    if (stateChange) {
      const previous = stateChange.oldValue as RuntimeSnapshot["state"] | undefined;
      const next = stateChange.newValue as RuntimeSnapshot["state"] | undefined;
      if (Boolean(previous?.manualClosePause?.twitch) !== Boolean(next?.manualClosePause?.twitch)
        || previous?.manualWatch?.twitch?.active !== next?.manualWatch?.twitch?.active
        || previous?.sessions?.twitch?.status !== next?.sessions?.twitch?.status
        || previous?.sessions?.twitch?.channel?.channelId !== next?.sessions?.twitch?.channel?.channelId
        || previous?.authHealth?.twitch?.status !== next?.authHealth?.twitch?.status) extensionHost.invalidate({
          preserveCompleted: previous?.authHealth?.twitch?.status === "healthy" && next?.authHealth?.twitch?.status === "healthy",
        });
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
