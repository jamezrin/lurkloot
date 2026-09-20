import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup } from "@lurkloot/popup-ui";
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

async function mountPopup(): Promise<HTMLElement> {
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

  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={createDemoPopupAdapter()} />);
  });
  await waitForCatalog();
  return container;
}

function rail(container: Element, view: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[data-view="${view}"]`);
}

function go(container: Element, view: string): void {
  const button = rail(container, view);
  if (!button) throw new Error(`Missing rail destination: ${view}`);
  act(() => button.click());
}

function currentView(container: Element): string | null {
  return container.querySelector("main")?.getAttribute("data-view") ?? null;
}

function panelText(container: Element): string {
  return container.querySelector("#popup-platform-panel")?.textContent ?? "";
}

describe("popup workspace shell", () => {
  it("opens on the queue and lists every destination", async () => {
    const container = await mountPopup();

    expect(currentView(container)).toBe("queue");
    for (const view of ["queue", "completed", "games", "watchlist", "extensions", "activity", "settings"]) {
      expect(rail(container, view), view).not.toBeNull();
    }
  });

  it("swaps the panel for the destination that was picked", async () => {
    const container = await mountPopup();

    go(container, "watchlist");
    expect(currentView(container)).toBe("watchlist");
    expect(panelText(container)).toContain("Idle Watchlist");

    go(container, "settings");
    expect(currentView(container)).toBe("settings");
    expect(panelText(container)).toContain("Language");

    go(container, "queue");
    expect(currentView(container)).toBe("queue");
    expect(panelText(container)).toContain("Drops");
  });

  it("keeps the status strip above every destination", async () => {
    const container = await mountPopup();
    const statusText = () => container.querySelector('[data-automation-state]')?.textContent ?? "";

    const onQueue = statusText();
    expect(onQueue).not.toBe("");
    for (const view of ["settings", "activity", "games"]) {
      go(container, view);
      expect(statusText(), view).toBe(onQueue);
    }
  });

  it("hides the Twitch-only extensions destination on Kick", async () => {
    const container = await mountPopup();

    expect(rail(container, "extensions")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(rail(container, "extensions")).toBeNull();
  });

  it("leaves a Twitch-only destination when the platform changes under it", async () => {
    const container = await mountPopup();

    go(container, "extensions");
    expect(currentView(container)).toBe("extensions");

    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(currentView(container)).toBe("queue");
  });

  it("does not strand the rail when a Twitch-only destination is left and returned to", async () => {
    const container = await mountPopup();

    go(container, "extensions");
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Twitch"]')?.click());

    // Back on Twitch the entry exists again, but the view stayed where the
    // fallback put it, so exactly one rail entry is current.
    expect(currentView(container)).toBe("queue");
    expect(rail(container, "extensions")).not.toBeNull();
    expect([...container.querySelectorAll('[aria-current="page"]')]).toHaveLength(1);
    expect(rail(container, "queue")?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps the destination when the platform changes under a shared view", async () => {
    const container = await mountPopup();

    go(container, "watchlist");
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(currentView(container)).toBe("watchlist");
  });

  it("keeps the inventory link with the other bottom entries, not as a stray icon", async () => {
    const container = await mountPopup();

    const rail = container.querySelector("nav")!;
    const order = [...rail.querySelectorAll<HTMLButtonElement>("button[data-view], button[data-rail-link]")]
      .map((button) => button.dataset.view ?? `link:${button.dataset.railLink}`);

    expect(order.slice(-3)).toEqual(["link:inventory", "activity", "settings"]);
    // And it is a way out, never a destination that could read as current.
    expect(rail.querySelector("[data-rail-link]")?.hasAttribute("aria-current")).toBe(false);
    expect(container.querySelector('#popup-platform-panel button[aria-label="Open inventory"]')).toBeNull();
  });

  it("marks the current destination for assistive technology", async () => {
    const container = await mountPopup();

    go(container, "games");

    expect(rail(container, "games")?.getAttribute("aria-current")).toBe("page");
    expect(rail(container, "queue")?.getAttribute("aria-current")).toBeNull();
  });
});
