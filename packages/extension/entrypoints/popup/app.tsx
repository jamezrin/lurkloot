import { browser } from "wxt/browser";
import type React from "react";
import {
  Popup,
  PromoTile,
  StoreScreenshot,
  createDemoPopupAdapter,
  screenshotVariant,
  type PopupAdapter,
  type ScreenshotVariant,
} from "@lurkloot/popup-ui";
import { SETTINGS_SESSION_PORT } from "@lurkloot/shared/messages";
import { SUPPORTED_LOCALES } from "@lurkloot/shared/settings";
import type { SupportedLocale } from "@lurkloot/shared/models";

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
    connectSettingsSession: () => {
      const port = browser.runtime.connect({ name: SETTINGS_SESSION_PORT });
      return () => port.disconnect();
    },
    getMessage: (key, substitutions) => browser.i18n.getMessage(key as never, substitutions),
    getUiLanguage: () => browser.i18n.getUILanguage(),
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
        <Popup adapter={POPUP_ADAPTER} initialState={{ preview: true, locale: POPUP_LOCALE, variant: SCREENSHOT_VARIANT }} />
      </StoreScreenshot>
    );
  }

  return <Popup adapter={POPUP_ADAPTER} />;
}
