import { browser } from "wxt/browser";
import { loadSettings, loadState, loadTwitchIntegrity, saveSettings, saveState, saveTwitchIntegrity } from "../src/core/storage";
import { SETTINGS_SESSION_PORT, type CliCredentialBlob, type RuntimeMessage } from "@lurkloot/shared/messages";
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
import { ALARM_NAME, WATCH_ALARM_NAME, createBackgroundController } from "@lurkloot/core/controller";
import { applySettingsPatch } from "@lurkloot/shared/settings";
import { effectiveLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import type { ExtensionSettings, SupportedLocale } from "@lurkloot/shared/models";
import type { WatchTabPort } from "@lurkloot/core/adapter";
import { createKickFetcher, KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import { isMinorOrMajorBump } from "../src/core/version";
import { CHANGELOG_URL } from "../src/core/links";

const localeCatalogs = new Map<string, MessageCatalog | undefined>();
const getMessage = browser.i18n.getMessage as (key: string, substitutions?: string | string[]) => string;

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

// Browser-backed watch-tab port shared by both adapters: binds the engine's
// WatchTabPort to the extension's wxt/browser tab wrappers. The host owns the tab
// policy (mute / keep-unmuted / auto-close), filling it from its own settings
// before delegating — the engine never reads those fields.
const watchTabPort: WatchTabPort = {
  openPinnedMutedTab: async (channel, session, options) => {
    const settings = await loadSettings();
    return openPinnedMutedTab(channel, session, {
      muted: settings.muteFarmingTabs,
      keepVideosUnmuted: settings.keepFarmingVideosUnmuted,
      closeManagedTabs: settings.autoCloseFinishedDrops,
      ...options,
    });
  },
  stopWatchTab: async (session, options) => {
    const settings = await loadSettings();
    return stopWatchTab(session, { closeManagedTabs: settings.autoCloseFinishedDrops, ...options });
  },
};

const controller = createBackgroundController<ExtensionSettings>({
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
  applySettingsPatch,
  applyAdFocus: async (platform, tabId, adActive) => {
    const { adFocusMode } = await loadSettings();
    await applyAdFocus(platform, tabId, adActive, adFocusMode);
  },
  loadTabPlaybackPolicy: async () => ({ keepVideosUnmuted: (await loadSettings()).keepFarmingVideosUnmuted !== false }),
  loadTwitchIntegrity,
  saveTwitchIntegrity,
  stopPageContextTabs: (contexts, options) => stopManagedPageContextTabs(contexts, options),
  createAdapters: () => ({
    twitch: new TwitchAdapter(
      { fetchJson: (url, init) => fetchTwitchInBackground(url, init) },
      ensureTwitchIntegrity,
      watchTabPort,
    ),
    kick: new KickAdapter(
      createKickFetcher({
        background: (url, init) => fetchKickInBackground<unknown>(url, init),
        pageFetch: (url, init) => fetchJsonInPage<unknown>("https://kick.com", url, init, { retainPageContext: { platform: "kick" } }),
      }),
      watchTabPort,
    ),
  }),
});

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

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async (details) => {
    await controller.ensureAlarm();
    // Stamp the install date once so the popup can time the rate/review nudge.
    // Set-if-missing (rather than gating on reason === "install") also backfills
    // a sane date for users upgrading from a pre-nudge version.
    const state = await loadState();
    if (!state.installedAt) {
      await saveState({ ...state, installedAt: new Date().toISOString() });
    }

    // On a meaningful update (major/minor — not a patch bugfix, not a fresh
    // install), open the changelog so returning users see what's new.
    const currentVersion = browser.runtime.getManifest().version;
    if (details.reason === "update" && isMinorOrMajorBump(details.previousVersion, currentVersion)) {
      await browser.tabs.create({ url: `${CHANGELOG_URL}#v${currentVersion}` });
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
    // Credential export reads the user's live session cookies, which only the
    // extension can do — handle it here rather than in the browser-free engine.
    // The popup gates this behind an explicit confirm dialog.
    if (message.type === "exportCliCredentials") {
      void buildCliCredentialBlob().then(sendResponse);
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
