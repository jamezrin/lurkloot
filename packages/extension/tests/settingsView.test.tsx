import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import { SettingsView } from "../../popup-ui/src/settings";
import type { PopupAdapter } from "../../popup-ui/src/types";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe("deadline feasibility setting", () => {
  function mountSettings(settings = DEFAULT_SETTINGS) {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSettingsChange = vi.fn(async () => undefined);
    const labels: Record<string, string> = {
      advancedTitle: "Advanced",
      deadlineSafetyMarginTitle: "Deadline safety margin",
      deadlineSafetyMarginDescription: "Extra buffer minutes.",
      minutesSuffix: "min",
      skipUnfinishableRewardsTitle: "Skip rewards that cannot be completed",
      skipUnfinishableRewardsDescription: "Do not farm impossible rewards.",
    };
    const adapter = {} as PopupAdapter;
    const container = document.getElementById("app")!;

    act(() => {
      root = createRoot(container);
      root.render(
        <PopupRuntimeContext.Provider value={{ adapter, preview: true }}>
          <I18nContext.Provider value={{ t: (key) => labels[key] ?? key, dir: "ltr", locale: "en" }}>
            <SettingsView
              suggestions={{ twitch: [], kick: [] }}
              onSearchCategories={async () => []}
              settings={settings}
              onSettingsChange={onSettingsChange}
              exportConfirmationResetKey={0}
            />
          </I18nContext.Provider>
        </PopupRuntimeContext.Provider>,
      );
    });

    const advanced = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Advanced"));
    act(() => advanced?.click());
    return { container, onSettingsChange };
  }

  it("defaults the toggle on and saves changes immediately", () => {
    const { container, onSettingsChange } = mountSettings();
    const toggle = container.querySelector('[role="switch"][aria-label="Skip rewards that cannot be completed"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    act(() => toggle.click());
    expect(onSettingsChange).toHaveBeenCalledWith(
      { skipUnfinishableRewards: false },
      { tickAfterSave: true },
    );
  });

  it("disables but preserves the margin input when filtering is off", () => {
    const { container } = mountSettings({ ...DEFAULT_SETTINGS, skipUnfinishableRewards: false, deadlineSafetyMarginMinutes: 17 });
    const input = container.querySelector('input[aria-label="Deadline safety margin"]') as HTMLInputElement;
    expect(input.value).toBe("17");
    expect(input.disabled).toBe(true);
  });
});
