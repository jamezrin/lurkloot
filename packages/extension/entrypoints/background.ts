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
import { createCredentialAvailabilityProvider, createCredentialReader } from "../src/core/credentialAvailability";
import { createTwitchExtensionCommitHook } from "../src/extensions/commitHook";
import { createTwitchExtensionHost } from "../src/extensions/host";
import { createTwitchExtensionSessionSource } from "../src/extensions/transport";
import { createFortniteDriver } from "../src/extensions/fortnite/driver";
import { createNoPixelDriver } from "../src/extensions/nopixel/driver";
import { createCredentialHealthObserver } from "../src/core/credentialObserver";
import { buildCliCredentialBlob, KASADA_COOKIE_ORIGIN } from "../src/core/cliCredentialExport";
import { REQUEST_FAILED_RESPONSE } from "../src/core/runtimeRequests";

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
// The shared Twitch integrity mint can outlive the caller that started it, so
// it reports each event through the controller as it happens rather than into
// that caller's collector, which drops whatever arrives after it closes.
const reportIntegrityAcquisition: EventEmitter = withActivityDiagnostics((event) => {
  void controller.reportEvents([event]);
});
const {
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrity,
  fetchJsonInPage,
  fetchKickInBackground,
  fetchTwitchInBackground,
  recordManagedPageContextFallback,
} = createBrowserTabs(tabRegistry, reportIntegrityAcquisition);
const kickClaimState = new KickClaimState();
const kickDiscoveryState = new KickDiscoveryState();
const kickPageContextRecovery = new KickPageContextRecoveryTracker();
const twitchDiscoveryState = new TwitchDiscoveryState();
const KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory";
const TWITCH_EXTENSION_LANE_KEY = "twitchExtensionLane";
const createBrowserWebSocket: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;
const credentialCookies = { get: (details: { url: string; name: string }) => browser.cookies.get(details) };
const checkCredentialAvailability = createCredentialAvailabilityProvider(credentialCookies);

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

// A driver's activity, published through its session so that nothing is
// reported once the session has ended (#594).
function publishDriverAction(
  publish: ((events: readonly EngineEvent[]) => void) | undefined,
  channel: { username: string } | undefined,
  provider: "fortnite" | "nopixel",
  action: "takeover_started" | "sprite_captured" | "giveaway_joined" | "pack_opened",
): void {
  if (!publish || !channel || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.username)) return;
  const events: EngineEvent[] = [];
  withActivityDiagnostics((event) => events.push(event))({
    category: "activity",
    code: "twitch_extension_action",
    level: "info",
    platform: "twitch",
    data: { provider, action, channel: channel.username },
  });
  publish(events);
}

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
    fortnite: async (session, emit, channel, publish) => createFortniteDriver({
      allowTakeovers: (await loadSettings()).twitchExtensions.fortnite.allowTakeovers,
      onTakeoverStarted: () => publishDriverAction(publish, channel, "fortnite", "takeover_started"),
      createSocket: (url) => new WebSocket(url),
      onCaptured: () => publishDriverAction(publish, channel, "fortnite", "sprite_captured"),
    })(session, emit, channel, publish),
    nopixel: async (session, emit, channel, publish) => createNoPixelDriver(
      (url, init) => fetch(url, init),
      () => publishDriverAction(publish, channel, "nopixel", "giveaway_joined"),
      Date.now,
      (message) => publish?.([{ category: "diagnostic", platform: "twitch", level: "warn", message }]),
      {
        autoOpenPacks: (await loadSettings()).twitchExtensions.nopixel.autoOpenPacks,
        onOpened: () => publishDriverAction(publish, channel, "nopixel", "pack_opened"),
      },
    )(session, emit, channel, publish),
  },
  loadSettings,
  loadState,
  savePatch: async (settingsPatch) => { await controller.handleMessage({ type: "saveSettings", settingsPatch }); },
  diagnostic: (message) => { void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message }]).catch(() => undefined); },
  publish: (events) => { void reportEvents(events).catch(() => undefined); },
  // Completion and cooldowns outlive the service worker (#594). Reset clears
  // the key with the rest of local storage.
  memory: {
    load: async () => (await browser.storage.local.get(TWITCH_EXTENSION_LANE_KEY))[TWITCH_EXTENSION_LANE_KEY],
    save: (memory) => browser.storage.local.set({ [TWITCH_EXTENSION_LANE_KEY]: memory }),
  },
  // Twitch's `login` cookie holds the username, not a credential.
  viewerLogin: async () => (await browser.cookies.get({ url: "https://www.twitch.tv", name: "login" }))?.value,
  // Never awaited: it runs from the lane's commit hook.
  requestTick: () => { void controller.tick(["twitch"], "tabless_fallback").catch(() => undefined); },
});

const extensionGrantCompletion = createTwitchExtensionGrantCompletion({
  storage: browser.storage.local,
  now: Date.now,
  contains: (details) => browser.permissions.contains(details),
  enable: async (provider) => { await extensionHost.setEnabled(provider, true); await controller.tickAndHandOff(["twitch"], "manual_tick"); },
});

// The lane follows the controller's accepted commits (#594), not storage events
// or alarms. A worker wake, startup and an auth check reconcile it too.
const extensionCommits = createTwitchExtensionCommitHook(extensionHost, () => {
  // Never include transport/provider exceptions or payloads in diagnostics.
  void reportEvents([{ category: "diagnostic", platform: "twitch", level: "warn", message: "Twitch Extension background reconciliation failed." }]).catch(() => undefined);
});
controller.onCommit(extensionCommits.onCommit);
const reconcileExtensions = extensionCommits.reconcile;

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
  exportCliCredentials: () => buildCliCredentialBlob(
    async (url, name, partitionedUnder) => {
      try {
        const details = partitionedUnder ? { url, name, partitionKey: { topLevelSite: partitionedUnder } } : { url, name };
        return (await browser.cookies.get(details))?.value ?? undefined;
      } catch {
        // Browsers without partitioned-cookie support reject `partitionKey`.
        return undefined;
      }
    },
    () => browser.permissions.contains({ origins: [KASADA_COOKIE_ORIGIN] }),
  ),
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
        // A Twitch cookie change may be a different account: the providers
        // stop, and what the lane learned is dropped if the login changed.
        if (platform === "twitch") void extensionHost.credentialsChanged().catch(() => undefined);
        return controller.invalidateAuthHealth(platform);
      },
      checkAuthHealth: async (platform) => {
        await controller.checkAuthHealth(platform);
        if (platform === "twitch") await reconcileExtensions();
      },
    },
    createCredentialReader(credentialCookies),
  );

  browser.permissions.onAdded.addListener((details) => {
    void extensionGrantCompletion.added(details).catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((details) => {
    void extensionGrantCompletion.removed(details).catch(() => undefined);
    void extensionHost.removed(details).catch(() => undefined);
  });
  // The grant flow's own intent keys; the lane itself follows commits.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    void extensionGrantCompletion.changed(changes).catch(() => undefined);
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
  // (drop claims). Registered at top level so it re-binds on each SW wake. The
  // background's own replays are seen here too, with tab id -1; the controller
  // ignores those.
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
    void dispatchRuntimeMessage(message, sender).then(sendResponse, () => sendResponse(REQUEST_FAILED_RESPONSE));
    return true;
  });

});
