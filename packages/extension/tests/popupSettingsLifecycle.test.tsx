import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function byLabel(container: Element, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button label: ${label}`);
  return button as HTMLButtonElement;
}

describe("popup settings lifecycle", () => {
  it("opens and closes settings without a background lifecycle connection", async () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));

    const demo = createDemoPopupAdapter();
    const connectSettingsSession = vi.fn(() => vi.fn());
    const adapter: PopupAdapter & { connectSettingsSession: () => () => void } = {
      ...demo,
      connectSettingsSession,
      getMessage: (key) => ({
        openSettings: "Open settings",
        back: "Back",
      })[key] ?? demo.getMessage(key),
    };
    const container = document.getElementById("app")!;

    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={adapter} />);
      await Promise.resolve();
    });

    act(() => byLabel(container, "Open settings").click());
    expect(connectSettingsSession).not.toHaveBeenCalled();

    act(() => byLabel(container, "Back").click());
    expect(connectSettingsSession).not.toHaveBeenCalled();
  });
});
