import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@lurkloot/shared/models";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mountForPlatform(platform: Platform) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(Date.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));

  const demo = createDemoPopupAdapter();
  const openLink = vi.fn();
  const adapter: PopupAdapter = {
    ...demo,
    openLink,
    getStorage: async () => ({ "popup:selectedPlatform": platform }),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  await waitForCatalog();

  const button = container.querySelector('button[aria-label="Open inventory"]');
  if (!button) throw new Error("Missing inventory button");
  return { button: button as HTMLButtonElement, openLink };
}

describe("popup inventory link", () => {
  it("opens the Twitch inventory page for the Twitch platform", async () => {
    const { button, openLink } = await mountForPlatform("twitch");
    act(() => button.click());
    expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/drops/inventory");
  });

  it("opens the Kick inventory page for the Kick platform", async () => {
    const { button, openLink } = await mountForPlatform("kick");
    act(() => button.click());
    expect(openLink).toHaveBeenCalledWith("https://kick.com/drops/inventory");
  });
});
