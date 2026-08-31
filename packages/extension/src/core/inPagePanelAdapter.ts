import { browser } from "wxt/browser";
import { openHttpsLink, type PopupAdapter } from "@lurkloot/popup-ui";

// Popup adapter for the in-page panel.
//
// Every optional `PopupAdapter` member left out here is left out on purpose:
// omitting one hides its action in the UI, which is the same mechanism
// `createDemoPopupAdapter` uses for the site demo. The omissions are the
// mitigation — a shadow root is not a security boundary, and an open shadow
// root is reachable from the host page.
//
//   exportCredentials  Writes the Twitch auth-token and Kick session_token to a
//                      file. It must not exist on a surface rendered inside a
//                      streaming page; see CLAUDE.md on credential export.
//   exportSettings     File pickers and downloads belong in the toolbar popup.
//   importSettings
//   downloadFile
//   resetExtension     Destructive; keep it behind the toolbar popup.
//   writeClipboard     Avoids a clipboard write reachable from a page surface.
//   getPendingChangelogVersion / dismissPendingChangelogVersion / changelogUrl
//                      Update notices belong to the toolbar popup.
//   compatibilityRegistry / resolveCompatibility
//                      Only the settings view needs these, and the panel is
//                      read-mostly. Leaving them out keeps @lurkloot/core out
//                      of the content-script bundle entirely.
export function createInPagePanelAdapter(): PopupAdapter {
  return {
    version: browser.runtime.getManifest().version,
    send: (message) => browser.runtime.sendMessage(message),
    getStorage: (keys) => browser.storage.local.get(keys),
    setStorage: (values) => browser.storage.local.set(values),
    getMessage: (key, substitutions) => browser.i18n.getMessage(key as never, substitutions),
    getUiLanguage: () => browser.i18n.getUILanguage(),
    // `browser.tabs` is not exposed to content scripts, so the popup's
    // `tabs.create` route is unavailable here. `window.open` is equivalent for
    // this purpose and still routed through openHttpsLink, which enforces the
    // https-only scheme check.
    openLink: (url) => openHttpsLink(url, (safeUrl) => void window.open(safeUrl, "_blank", "noopener,noreferrer")),
  };
}
