import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function mountPopup() {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));

  const adapter: PopupAdapter = {
    ...createDemoPopupAdapter(),
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  await waitForCatalog();
  return { container, view: window };
}

describe("native drag inside sortable rows", () => {
  it("suppresses dragstart from a link inside a reorderable row", async () => {
    // Links and images are natively draggable, so grabbing a row by its body
    // used to start an HTML5 link drag (a link ghost trailing the cursor)
    // instead of doing nothing. Reordering runs off the grip handle.
    const { container, view } = await mountPopup();

    // An anchor that actually sits inside a reorderable campaign card.
    const link = container.querySelector<HTMLAnchorElement>("[data-campaign-id] a[href]");
    expect(link).toBeTruthy();

    const event = new view.Event("dragstart", { bubbles: true, cancelable: true });
    act(() => { link!.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
  });
});
