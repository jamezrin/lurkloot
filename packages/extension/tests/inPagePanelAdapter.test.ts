import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { getManifest: () => ({ version: "9.9.9" }), sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    i18n: { getMessage: vi.fn(() => "message"), getUILanguage: () => "en" },
    tabs: { create: vi.fn() },
  },
}));

const { createInPagePanelAdapter } = await import("../src/core/inPagePanelAdapter");

describe("in-page panel adapter", () => {
  // These are not incidental gaps. `PopupAdapter` makes them optional precisely
  // so a host can decline them, and the popup hides the corresponding action
  // when one is absent. exportCredentials is the load-bearing case: it writes
  // the Twitch auth-token and Kick session_token to a file, and must not be
  // reachable from a surface opened on a streaming page. If someone adds one of
  // these to the adapter, that action silently appears in the in-page panel.
  it.each([
    "exportCredentials",
    "exportSettings",
    "importSettings",
    "downloadFile",
    "resetExtension",
    "writeClipboard",
    "getPendingChangelogVersion",
    "dismissPendingChangelogVersion",
    "changelogUrl",
  ])("does not expose %s", (member) => {
    expect(createInPagePanelAdapter()).not.toHaveProperty(member);
  });

  // Omitting these keeps @lurkloot/core out of the panel bundle entirely, which
  // is why the panel is read-mostly rather than full popup parity.
  it("does not pull in the compatibility registry", () => {
    const adapter = createInPagePanelAdapter();
    expect(adapter).not.toHaveProperty("compatibilityRegistry");
    expect(adapter).not.toHaveProperty("resolveCompatibility");
  });

  it("implements what the read-mostly panel needs", () => {
    const adapter = createInPagePanelAdapter();
    expect(adapter.version).toBe("9.9.9");
    for (const member of [
      "send",
      "getStorage",
      "setStorage",
      "getMessage",
      "getUiLanguage",
      "openLink",
    ]) {
      expect(typeof adapter[member as keyof typeof adapter]).toBe("function");
    }
  });

  // The panel shows the rate nudge, and an adapter without reviewStore falls
  // back to the Chrome Web Store, which would be wrong in the Firefox build.
  it("names the store this build is installed from", async () => {
    const { EXTENSION_REVIEW_STORE, reviewStoreFor } = await import("../src/core/reviewStore");
    expect(createInPagePanelAdapter().reviewStore).toBe(EXTENSION_REVIEW_STORE);
    expect(reviewStoreFor(true)).toBe("firefox-add-ons");
    expect(reviewStoreFor(false)).toBe("chrome-web-store");
  });

  it("refuses to open a non-https link", async () => {
    const { browser } = await import("wxt/browser");
    createInPagePanelAdapter().openLink("javascript:alert(1)");
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
});
