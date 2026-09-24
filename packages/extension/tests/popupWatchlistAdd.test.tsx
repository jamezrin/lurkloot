import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "@lurkloot/shared/messages";
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
    callback(Date.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));

  const demo = createDemoPopupAdapter();
  const sent: RuntimeMessage[] = [];
  const adapter: PopupAdapter = {
    ...demo,
    send: async <T,>(message: RuntimeMessage) => {
      sent.push(message);
      return demo.send<T>(message);
    },
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  await waitForCatalog();
  return { container, sent };
}

const byLabel = (container: Element, label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label);

// The Idle Watchlist is its own rail destination now, so the form is reached by
// navigating there rather than by expanding a section of the drops list. The
// view swaps outright, so one act() settles it.
function openWatchlist(container: Element): void {
  act(() => { container.querySelector<HTMLButtonElement>('button[data-view="watchlist"]')?.click(); });
}

describe("idle watchlist add form", () => {
  // The add form and its text used to survive a platform switch, so a channel
  // typed for Twitch could be submitted into Kick's watchlist.
  it("drops a half-typed channel when the platform changes", async () => {
    const { container, sent } = await mountPopup();

    openWatchlist(container);
    const input = container.querySelector<HTMLInputElement>("[data-watchlist-input]");
    expect(input).not.toBeNull();
    act(() => {
      input!.value = "typed-for-twitch";
      input!.dispatchEvent(new (container.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });

    act(() => byLabel(container, "Kick")?.click());

    // The field stays open on Kick, but starts empty rather than carrying the
    // Twitch draft.
    openWatchlist(container);
    expect(container.querySelector<HTMLInputElement>("[data-watchlist-input]")?.value ?? "").toBe("");
    expect(sent.filter((message) => message.type === "saveSettings")).toHaveLength(0);
  });
});
