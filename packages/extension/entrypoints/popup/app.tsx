import { browser } from "wxt/browser";
import type React from "react";
import {
  Popup,
  PromoTile,
  StoreScreenshot,
  createDemoPopupAdapter,
  openHttpsLink,
  screenshotVariant,
  variantShowsPopup,
  type PopupAdapter,
  type ScreenshotVariant,
} from "@lurkloot/popup-ui";
import { SUPPORTED_LOCALES } from "@lurkloot/shared/settings";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import {
  changelogUrl,
  dismissPendingChangelogVersion,
  loadPendingChangelogVersion,
} from "../../src/core/updateNotice";

const URL_PARAMS = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");

function localeFromUrl(): SupportedLocale | undefined {
  const value = URL_PARAMS.get("locale");
  return value && SUPPORTED_LOCALES.includes(value as SupportedLocale) ? (value as SupportedLocale) : undefined;
}

export const SCREENSHOT_MODE = URL_PARAMS.get("screenshot") === "store";
export const PROMO_MODE = URL_PARAMS.get("screenshot") === "promo";
export const PROMO_FORMAT: "small" | "marquee" =
  URL_PARAMS.get("format") === "marquee" ? "marquee" : "small";
export const SCREENSHOT_VARIANT: ScreenshotVariant = screenshotVariant(URL_PARAMS.get("variant"));
export const POPUP_LOCALE = localeFromUrl();

export function createExtensionPopupAdapter(): PopupAdapter {
  return {
    version: browser.runtime.getManifest().version,
    send: (message) => browser.runtime.sendMessage(message),
    getStorage: (keys) => browser.storage.local.get(keys),
    setStorage: (values) => browser.storage.local.set(values),
    getMessage: (key, substitutions) => browser.i18n.getMessage(key as never, substitutions),
    getUiLanguage: () => browser.i18n.getUILanguage(),
    openLink: (url) => openHttpsLink(url, (safeUrl) => void browser.tabs.create({ url: safeUrl })),
    getPendingChangelogVersion: loadPendingChangelogVersion,
    dismissPendingChangelogVersion,
    changelogUrl,
    exportCredentials: (blob) => {
      // Download the credential blob the CLI's `login --import` consumes. The
      // popup is a normal extension page, so a Blob URL + anchor works without
      // the downloads permission.
      const url = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "lurkloot-credentials.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    exportSettings: (payload) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "lurkloot-settings.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    downloadFile: (filename, contents, mimeType = "text/plain") => {
      const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    importSettings: () => new Promise<unknown | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      let settled = false;
      const settle = (result: Promise<unknown | null> | unknown | null) => {
        if (settled) return;
        settled = true;
        Promise.resolve(result).then(resolve, reject);
      };
      input.onchange = () => {
        const file = input.files?.[0];
        settle(file ? file.text().then((text) => JSON.parse(text)) : null);
      };
      // Some browsers never fire onchange when the picker is dismissed without
      // a selection. `focus` fires right after the dialog closes either way; by
      // then `input.files` already reflects the user's choice, so this only
      // resolves the no-selection case. If a file WAS chosen, do nothing here —
      // onchange (already in flight or about to fire) owns settling the promise.
      window.addEventListener("focus", () => setTimeout(() => {
        if (!input.files?.length) settle(null);
      }, 300), { once: true });
      input.click();
    }),
    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard access can be denied or unavailable; the caller falls back
        // to showing the text for manual copying.
        return false;
      }
    },
    resetExtension: () => browser.runtime.sendMessage({ type: "resetExtension" }),
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    resolveCompatibility: (settings) => resolveCompatibility(settings, { host: "extension", twitchIdentity: "web" }),
  };
}

export const POPUP_ADAPTER: PopupAdapter = SCREENSHOT_MODE || PROMO_MODE
  ? createDemoPopupAdapter({
      locale: POPUP_LOCALE,
      version: browser.runtime.getManifest().version,
    })
  : createExtensionPopupAdapter();

export function PopupApp(): React.ReactElement {
  if (PROMO_MODE) {
    return <PromoTile format={PROMO_FORMAT} locale={POPUP_LOCALE} />;
  }

  if (SCREENSHOT_MODE) {
    return (
      <StoreScreenshot variant={SCREENSHOT_VARIANT} locale={POPUP_LOCALE}>
        {variantShowsPopup(SCREENSHOT_VARIANT) ? (
          <Popup adapter={POPUP_ADAPTER} initialState={{ preview: true, locale: POPUP_LOCALE, variant: SCREENSHOT_VARIANT }} />
        ) : null}
      </StoreScreenshot>
    );
  }

  return <Popup adapter={POPUP_ADAPTER} />;
}
