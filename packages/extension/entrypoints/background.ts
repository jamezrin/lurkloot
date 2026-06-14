import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import { SETTINGS_SESSION_PORT, type RuntimeMessage } from "@lurkloot/shared/messages";
import { applyAdFocus } from "../src/core/tabs";
import { ALARM_NAME, WATCH_ALARM_NAME, createBackgroundController } from "../src/background/controller";
import { effectiveLocale, loadLocaleCatalog, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import type { ExtensionSettings, SupportedLocale } from "@lurkloot/shared/models";
import { KickAdapter } from "../src/platforms/kick";
import { TwitchAdapter } from "../src/platforms/twitch";

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
  loadTwitchIntegrity,
  saveTwitchIntegrity,
  createAdapters: () => ({
    twitch: new TwitchAdapter(),
    kick: new KickAdapter(),
  }),
});

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await controller.ensureAlarm();
    // Stamp the install date once so the popup can time the rate/review nudge.
    // Set-if-missing (rather than gating on reason === "install") also backfills
    // a sane date for users upgrading from a pre-nudge version.
    const state = await loadState();
    if (!state.installedAt) {
      await saveState({ ...state, installedAt: new Date().toISOString() });
    }
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
