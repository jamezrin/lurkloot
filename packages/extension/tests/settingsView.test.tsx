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
  it("shows the shared value in Advanced settings and saves -1 immediately", () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSettingsChange = vi.fn(async () => undefined);
    const labels: Record<string, string> = {
      advancedTitle: "Advanced",
      deadlineSafetyMarginTitle: "Deadline safety margin",
      deadlineSafetyMarginDescription: "Use -1 to disable deadline filtering.",
      disabled: "Disabled",
      minutesSuffix: "min",
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
              settings={DEFAULT_SETTINGS}
              onSettingsChange={onSettingsChange}
              exportConfirmationResetKey={0}
            />
          </I18nContext.Provider>
        </PopupRuntimeContext.Provider>,
      );
    });

    const advanced = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Advanced"));
    act(() => advanced?.click());
    const input = container.querySelector('input[aria-label="Deadline safety margin"]') as HTMLInputElement;
    expect(input.value).toBe("5");

    act(() => {
      Object.defineProperty(input, "value", { configurable: true, value: "-1" });
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
    });
    expect(onSettingsChange).toHaveBeenCalledWith(
      { deadlineSafetyMarginMinutes: -1 },
      { tickAfterSave: true },
    );
  });
});
