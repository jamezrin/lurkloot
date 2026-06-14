import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import { SETTINGS_SESSION_PORT, type CliCredentialExport, type RuntimeMessage } from "@stream-autopilot/shared/messages";
import {
  applyAdFocus,
  ensureTwitchIntegrity,
  fetchJsonInPage,
  fetchKickInBackground,
  fetchTwitchInBackground,
  openPinnedMutedTab,
  stopManagedPageContextTabs,
  stopWatchTab,
} from "../src/core/tabs";
import { ALARM_NAME, WATCH_ALARM_NAME, createBackgroundController } from "@stream-autopilot/core/controller";
import { effectiveLocale, loadLocaleCatalog, translateFromCatalogs, type MessageCatalog } from "@stream-autopilot/shared/i18n";
import type { ExtensionSettings, SupportedLocale } from "@stream-autopilot/shared/models";
import type { WatchTabPort } from "@stream-autopilot/core/adapter";
import { createKickFetcher, KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";

const localeCatalogs = new Map<string, MessageCatalog | undefined>();
const getMessage = browser.i18n.getMessage as (key: string, substitutions?: string | string[]) => string;
const getUrl = (path: string) => browser.runtime.getURL(path as never);

async function catalog(locale: string): Promise<MessageCatalog | undefined> {
  if (localeCatalogs.has(locale)) return localeCatalogs.get(locale);
  const loaded = await loadLocaleCatalog(locale as SupportedLocale, getUrl);
  localeCatalogs.set(locale, loaded);
  return loaded;
}

async function translate(settings: ExtensionSettings, key: string, substitutions?: string | string[]): Promise<string> {
  if (settings.languageOverride === "browser") {
    const message = getMessage(key, substitutions);
    if (message) return message;
  }
  const locale = effectiveLocale(settings.languageOverride, browser.i18n.getUILanguage());
  const [active, fallback] = await Promise.all([catalog(locale), catalog("en")]);
  return translateFromCatalogs(key, substitutions, active, fallback ?? {});
}

const controller = createBackgroundController({
  loadSettings,
  saveSettings,
  loadState,
  saveState,
  createAlarm: (name, options) => browser.alarms.create(name, options),
  closeManagedTabsByUrl: async (urls) => {
    for (const url of urls) {
      const tabs = await browser.tabs.query({ url });
      await Promise.all(tabs.map(async (tab) => {
        if (tab.id != null) await browser.tabs.remove(tab.id);
      }));
    }
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
  applyAdFocus: (platform, tabId, adActive, mode) => applyAdFocus(platform, tabId, adActive, mode),
  stopPageContextTabs: (contexts, options) => stopManagedPageContextTabs(contexts, options),
  loadTwitchIntegrity,
  saveTwitchIntegrity,
  createAdapters: () => {
    // Browser bindings injected into the (browser-free) core adapters.
    const watchTabs: WatchTabPort = { openPinnedMutedTab, stopWatchTab };
    return {
      twitch: new TwitchAdapter(
        { fetchJson: (url, init) => fetchTwitchInBackground(url, init) },
        { ensureIntegrity: ensureTwitchIntegrity, watchTabs },
      ),
      kick: new KickAdapter(
        createKickFetcher({
          background: (url, init) => fetchKickInBackground(url, init),
          pageFetch: (url, init) => fetchJsonInPage("https://kick.com", url, init, { retainPageContext: { platform: "kick" } }),
        }),
        { watchTabs },
      ),
    };
  },
});

// Builds the credential blob for the CLI's `login --import`, reading the same
// cookies the background already uses to authenticate (auth-token/unique_id for
// Twitch, session_token for Kick) plus the captured integrity token.
async function cookieValue(url: string, name: string): Promise<string | undefined> {
  return (await browser.cookies.get({ url, name }))?.value ?? undefined;
}

async function buildCliCredentialExport(): Promise<CliCredentialExport> {
  const blob: CliCredentialExport = { v: 1 };
  const authToken = await cookieValue("https://www.twitch.tv", "auth-token");
  if (authToken) {
    blob.twitch = { authToken, deviceId: await cookieValue("https://www.twitch.tv", "unique_id") };
  }
  const sessionToken = await cookieValue("https://kick.com", "session_token");
  if (sessionToken) blob.kick = { sessionToken: decodeURIComponent(sessionToken) };
  const integrity = await loadTwitchIntegrity();
  if (integrity && integrity.expiresAt > Date.now()) blob.integrity = integrity;
  return blob;
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await controller.ensureAlarm();
  });

  browser.runtime.onStartup.addListener(async () => {
    await controller.handleStartup();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void controller.tick();
    } else if (alarm.name === WATCH_ALARM_NAME) {
      void controller.runWatchHeartbeat();
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
      void controller.captureTwitchIntegrity(details.requestHeaders);
      return undefined;
    },
    { urls: ["https://gql.twitch.tv/*"] },
    ["requestHeaders"],
  );

  browser.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    // Browser-only concern (reads cookies + stored integrity), handled here rather
    // than in the browser-free core controller.
    if (message.type === "exportCliCredentials") {
      void buildCliCredentialExport().then(sendResponse);
      return true;
    }
    void controller.handleMessage(message, sender).then(sendResponse);
    return true;
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== SETTINGS_SESSION_PORT) return;
    void controller.beginSettingsSession();
    port.onDisconnect.addListener(() => {
      void controller.endSettingsSession();
    });
  });
});
