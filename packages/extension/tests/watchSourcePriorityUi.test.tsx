import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, applySettingsPatch, type SettingsPatch } from "@lurkloot/shared/settings";
import { translateFromCatalogs } from "@lurkloot/shared/i18n";
import english from "../../locales/messages/en.json";
import { I18nContext } from "../../popup-ui/src/context";
import { buildSettingsRegistry, type SettingsChangeOptions } from "../../popup-ui/src/settingsRegistry";
import { filterSettingsTree } from "../../popup-ui/src/settingsSearch";
import type { Platform } from "@lurkloot/shared/models";

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(platform: Platform, saveDelay?: Promise<void>) {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Linkedom has no browser focus state. Model native focus, including its
  // refusal to focus disabled buttons, so save timing can be tested here.
  let activeElement: Element = document.body;
  Object.defineProperty(document, "activeElement", { get: () => activeElement });
  vi.spyOn(window.HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute("disabled")) activeElement = this;
  });
  const saved: { patch: SettingsPatch; options?: SettingsChangeOptions }[] = [];
  const t = (key: string, substitutions?: string | string[]) => translateFromCatalogs(key, substitutions, english, english);
  function Harness() {
    const [settings, setSettings] = React.useState(() => applySettingsPatch(DEFAULT_SETTINGS, {}));
    const registry = buildSettingsRegistry({ t, settings, suggestions: { twitch: [], kick: [] }, onSearchCategories: async () => [], onSettingsChange: async (patch, options) => {
      saved.push({ patch, options });
      if (saveDelay) await saveDelay;
      setSettings((current) => applySettingsPatch(current, patch));
    } });
    const entry = registry.flatMap((section) => section.groups.flatMap((group) => group.entries)).find((item) => item.id === `${platform}.watchSourcePriority.order`);
    return <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>{entry?.render()}</I18nContext.Provider>;
  }
  root = createRoot(document.getElementById("root")!);
  act(() => root?.render(<Harness />));
  const click = (label: string) => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label);
    expect(button, label).toBeTruthy();
    act(() => button?.dispatchEvent(new window.Event("click", { bubbles: true })));
  };
  const order = () => [...document.querySelectorAll("li")].map((row) => row.getAttribute("data-watch-source"));
  return { document, saved, click, order };
}

describe("watch-source priority controls", () => {
  it("reorders disabled providers and resets Twitch with a platform-specific scheduler tick", () => {
    const view = mount("twitch");
    expect(view.order()).toEqual(["drops", "nopixel", "fortnite", "idle_watchlist"]);
    expect(view.document.querySelector("ol")).toBeTruthy();
    view.click("Move NoPixelV up");
    expect(view.order()).toEqual(["nopixel", "drops", "fortnite", "idle_watchlist"]);
    expect(view.saved.at(-1)).toMatchObject({ patch: { platform: { twitch: { watchSourcePriority: view.order() } } }, options: { tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] } });
    view.click("Move NoPixelV down");
    expect(view.order()).toEqual(["drops", "nopixel", "fortnite", "idle_watchlist"]);
    view.click("Move Idle Watchlist up");
    view.click("Reset priority");
    expect(view.order()).toEqual(["drops", "nopixel", "fortnite", "idle_watchlist"]);
    expect(view.document.querySelectorAll("li")[0].querySelector('button[aria-label="Move Drops up"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("offers only Kick's supported sources", () => {
    const view = mount("kick");
    expect(view.order()).toEqual(["drops", "idle_watchlist"]);
    view.click("Move Idle Watchlist up");
    expect(view.order()).toEqual(["idle_watchlist", "drops"]);
    expect(view.saved.at(-1)?.patch.platform).not.toHaveProperty("twitch");
  });

  it("keeps keyboard focus on the moved source when its original button reaches a boundary", () => {
    const view = mount("twitch");
    const up = view.document.querySelector('button[aria-label="Move NoPixelV up"]') as HTMLButtonElement;
    up.focus();
    view.click("Move NoPixelV up");
    expect(view.document.activeElement?.getAttribute("aria-label")).toBe("Move NoPixelV down");
    view.click("Move NoPixelV down");
    expect(view.document.activeElement?.getAttribute("aria-label")).toBe("Move NoPixelV down");
  });

  it("preserves focus the user moved elsewhere while an asynchronous save was pending", async () => {
    let finishSave!: () => void;
    const delay = new Promise<void>((resolve) => { finishSave = resolve; });
    const view = mount("twitch", delay);
    const up = view.document.querySelector('button[aria-label="Move NoPixelV up"]') as HTMLButtonElement;
    up.focus();
    view.click("Move NoPixelV up");
    const reset = [...view.document.querySelectorAll("button")].find((button) => button.textContent === "Reset priority") as HTMLButtonElement;
    reset.focus();
    await act(async () => { finishSave(); await delay; });
    expect(view.order()[0]).toBe("nopixel");
    expect(view.document.activeElement === reset).toBe(true);
  });

  it("replaces the global fallback toggle with searchable per-platform priority entries", () => {
    const sections = buildSettingsRegistry({ t: (key) => key, settings: DEFAULT_SETTINGS, onSettingsChange: async () => undefined, suggestions: { twitch: [], kick: [] }, onSearchCategories: async () => [] });
    const entries = sections.flatMap((section) => [...section.rows, ...section.groups.flatMap((group) => group.entries)]);
    expect(entries.map((entry) => entry.id)).not.toContain("general.drops.idleWatchlistFallbackOnly");
    expect(entries.filter((entry) => entry.titleKey === "watchSourcePriorityTitle").map((entry) => entry.id)).toEqual(["twitch.watchSourcePriority.order", "kick.watchSourcePriority.order"]);
    const filtered = filterSettingsTree(sections, { t: (key) => translateFromCatalogs(key, undefined, english, english), query: "NoPixelV", showAdvanced: false });
    expect(filtered.flatMap((section) => section.groups.flatMap((group) => group.entries)).map((entry) => entry.id)).toContain("twitch.watchSourcePriority.order");
  });
});
