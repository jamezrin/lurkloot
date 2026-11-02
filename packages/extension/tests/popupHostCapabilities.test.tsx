// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDemoPopupAdapter,
  DEFAULT_HOST_CAPABILITIES,
  Popup,
  screenshotVariant,
  type PopupAdapter,
  type PopupHostCapabilities,
} from "@lurkloot/popup-ui";
import type { WatchSourceId } from "@lurkloot/shared/models";
import { HostCapabilitiesContext } from "../../popup-ui/src/hostCapabilities";
import { WatchSourcePriority } from "../../popup-ui/src/watchSourcePriority";

// What a UI over the headless CLI supports: no tabs, no Twitch Extension
// providers, no credential export and none of the extension's own preferences.
// Declared here, not in popup-ui, because the CLI host owns that answer.
const CLI_CAPABILITIES: PopupHostCapabilities = {
  tabs: false,
  twitchExtensions: false,
  credentialExport: false,
  extensionPreferences: false,
};

// Settings that depend on a capability, by message key. Labels render as
// their keys, so the assertions do not depend on the English copy.
const TAB_KEYS = [
  "tablessTitle",
  "autoCloseTabsTitle",
  "muteTabsTitle",
  "keepVideosUnmutedTitle",
  "adFocusTitle",
  "pauseManualTitle",
  "tablessFallbackFailureLimitTitle",
  "kickPageContextRecoverySuccessesTitle",
];
const PREFERENCE_KEYS = [
  "settingsLanguageTitle",
  "autoStartTitle",
  "hideTipsTitle",
  "inPagePanelTitle",
  "diagnosticLoggingTitle",
];

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountPopup(
  hostCapabilities: PopupHostCapabilities | undefined,
  view: "settings" | "nopixel" = "settings",
): Promise<HTMLElement> {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const demo = createDemoPopupAdapter();
  const adapter: PopupAdapter = {
    ...demo,
    getMessage: (key) => `[${key}]`,
    requestTwitchExtensionPermission: async () => true,
    exportCredentials: vi.fn(),
    ...(hostCapabilities ? { hostCapabilities } : {}),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Popup
        adapter={adapter}
        initialState={{ preview: true, variant: screenshotVariant("settings"), view }}
      />,
    );
    await Promise.resolve();
  });
  return container;
}

// The first watch order on the page is Twitch's; Kick's follows in its section.
function shownSources(container: Element): string[] {
  const list = container.querySelector("ol");
  return [...(list?.querySelectorAll("[data-watch-source]") ?? [])].map(
    (item) => item.getAttribute("data-watch-source") ?? "",
  );
}

describe("popup host capabilities", () => {
  it("defaults to every capability, the extension's own", () => {
    expect(DEFAULT_HOST_CAPABILITIES).toEqual({
      tabs: true,
      twitchExtensions: true,
      credentialExport: true,
      extensionPreferences: true,
    });
  });

  it("shows every host-dependent control when the host declares none", async () => {
    const container = await mountPopup(undefined);
    const text = container.textContent ?? "";

    for (const key of [...TAB_KEYS, ...PREFERENCE_KEYS, "cliExportButton"]) {
      expect(text, key).toContain(`[${key}]`);
    }
    expect(container.querySelector('[id="settings-section-general.farmingTabs"]')).not.toBeNull();
    expect(container.querySelector('[id="settings-section-twitch.extensions"]')).not.toBeNull();
    expect(container.querySelector('button[data-view="nopixel"]')).not.toBeNull();
    expect(container.querySelector('button[data-view="fortnite"]')).not.toBeNull();
    expect(shownSources(container)).toEqual([
      "watch_streaks",
      "drops",
      "nopixel",
      "fortnite",
      "watchlist",
    ]);
  });

  it("leaves out tab, mute, tabless, Twitch Extension and credential controls for a CLI host", async () => {
    const container = await mountPopup(CLI_CAPABILITIES);
    const text = container.textContent ?? "";

    for (const key of [...TAB_KEYS, ...PREFERENCE_KEYS, "cliExportButton", "cliExportTitle"]) {
      expect(text, key).not.toContain(`[${key}]`);
    }
    // Hidden, not disabled: the group and its rows are not in the DOM at all.
    expect(container.querySelector('[id="settings-section-general.farmingTabs"]')).toBeNull();
    expect(container.querySelector('[id="settings-section-twitch.extensions"]')).toBeNull();
    expect(container.querySelector('[data-rail-group="navExtensions"]')).toBeNull();
    expect(container.querySelector('button[data-view="nopixel"]')).toBeNull();
    expect(container.querySelector('button[data-view="fortnite"]')).toBeNull();
    expect(shownSources(container)).toEqual(["watch_streaks", "drops", "watchlist"]);

    // What the CLI does support is still there.
    expect(text).toContain("[autoClaimTitle]");
    expect(text).toContain("[schedulerIntervalTitle]");
    expect(text).toContain("[alwaysEnterChatTitle]");
  });

  it("sends a Twitch Extension view the host cannot show to the Queue", async () => {
    const container = await mountPopup(CLI_CAPABILITIES, "nopixel");

    expect(container.querySelector('button[data-view="queue"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(container.querySelector('section[aria-label="NoPixelV"]')).toBeNull();
  });
});

describe("watch order with hidden sources", () => {
  function mountOrder(value: WatchSourceId[]) {
    document.body.innerHTML = "<div id=app></div>";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onChange = vi.fn();
    const container = document.getElementById("app")!;
    act(() => {
      root = createRoot(container);
      root.render(
        <HostCapabilitiesContext.Provider value={CLI_CAPABILITIES}>
          <WatchSourcePriority platform="twitch" value={value} onChange={onChange} />
        </HostCapabilitiesContext.Provider>,
      );
    });
    return { container, onChange };
  }

  function moveButton(container: Element, source: WatchSourceId, index: 0 | 1) {
    return container.querySelectorAll<HTMLButtonElement>(
      `li[data-watch-source="${source}"] button`,
    )[index];
  }

  it("keeps hidden sources in place when a listed one moves past them", () => {
    const { container, onChange } = mountOrder([
      "watch_streaks",
      "drops",
      "nopixel",
      "fortnite",
      "watchlist",
    ]);

    expect(shownSources(container)).toEqual(["watch_streaks", "drops", "watchlist"]);
    // The last listed row cannot move down, though hidden rows follow none.
    expect(moveButton(container, "watchlist", 1).disabled).toBe(true);

    act(() => moveButton(container, "watchlist", 0).click());
    expect(onChange).toHaveBeenCalledWith([
      "watch_streaks",
      "watchlist",
      "nopixel",
      "fortnite",
      "drops",
    ]);
  });
});
