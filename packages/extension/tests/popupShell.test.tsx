import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup } from "@lurkloot/popup-ui";
import { WorkspaceRail } from "../../popup-ui/src/shell";
import type { AutomationPresentation } from "../../popup-ui/src/automationStatus";
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
    for (const view of ["queue", "completed", "games", "watchlist", "nopixel", "fortnite", "activity", "settings"]) {
      expect(rail(container, view), view).not.toBeNull();
    }
  });

  it("swaps the panel for the destination that was picked", async () => {
    const container = await mountPopup();

    go(container, "watchlist");
    expect(currentView(container)).toBe("watchlist");
    // The rail and the view title already say "Idle watchlist", so the panel
    // itself carries the channels rather than repeating the name a third time.
    expect(container.querySelector("#idle-watchlist")).not.toBeNull();
    expect(panelText(container)).toContain("RivalsPilot");

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

  // The status strip shows in every view, but only the queue can reveal the
  // farmed campaign's card: the link used to leave the user where they were.
  it("opens the queue on the farmed campaign from any destination", async () => {
    const container = await mountPopup();
    go(container, "games");
    const link = container.querySelector<HTMLButtonElement>('[data-automation-state="running"] button');
    expect(link).not.toBeNull();

    act(() => link!.click());

    expect(currentView(container)).toBe("queue");
    expect(container.querySelector('[data-campaign-id="tw-marathon"] article button[aria-expanded="true"]')).not.toBeNull();
  });

  it("names the watched channel's viewer count for screen readers", async () => {
    const container = await mountPopup();
    const count = container.querySelector('[data-automation-state="running"] [role="img"][aria-label$="viewers"]');
    expect(count?.getAttribute("aria-label")).toBe("18K viewers");
  });

  it("opens the Games view of the platform whose settings link was used", async () => {
    const container = await mountPopup();
    go(container, "settings");
    const links = [...container.querySelectorAll<HTMLButtonElement>("[data-settings-link]")].filter((link) => link.textContent?.includes("Open Games"));
    // One per platform, Twitch first then Kick.
    expect(links).toHaveLength(2);

    act(() => links[1]!.click());

    expect(currentView(container)).toBe("games");
    expect(container.querySelector('[role="tab"][aria-label="Kick"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("marks the Twitch extension destinations as beta, and only them", async () => {
    const container = await mountPopup();
    const beta = [...container.querySelectorAll("[data-rail-beta]")].map((tag) => tag.closest("button")?.getAttribute("data-view"));
    expect(beta).toEqual(["nopixel", "fortnite"]);
    expect(rail(container, "nopixel")?.getAttribute("aria-label")).toBe("NoPixel V, Beta");
  });

  it("starts the Games search afresh on the other platform", async () => {
    const container = await mountPopup();
    go(container, "games");
    const input = container.querySelector<HTMLInputElement>("[data-games-search]")!;
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    input.value = "marathon";
    act(() => (input as unknown as Record<string, { onChange(event: { target: HTMLInputElement }): void }>)[propsKey]!.onChange({ target: input }));
    // The search took: it narrowed the Twitch list to the one match.
    expect([...container.querySelectorAll("[data-game]")].map((row) => row.getAttribute("data-game"))).toEqual(["marathon legends"]);

    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(container.querySelector<HTMLInputElement>("[data-games-search]")?.value).toBe("");
  });

  it("hides the Twitch-only extension destinations on Kick", async () => {
    const container = await mountPopup();

    expect(rail(container, "nopixel")).not.toBeNull();
    expect(rail(container, "fortnite")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(rail(container, "nopixel")).toBeNull();
    expect(rail(container, "fortnite")).toBeNull();
  });

  it("leaves a Twitch-only destination when the platform changes under it", async () => {
    const container = await mountPopup();

    go(container, "fortnite");
    expect(currentView(container)).toBe("fortnite");

    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());

    expect(currentView(container)).toBe("queue");
  });

  it("does not strand the rail when a Twitch-only destination is left and returned to", async () => {
    const container = await mountPopup();

    go(container, "nopixel");
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Kick"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Twitch"]')?.click());

    // Back on Twitch the entry exists again, but the view stayed where the
    // fallback put it, so exactly one rail entry is current.
    expect(currentView(container)).toBe("queue");
    expect(rail(container, "nopixel")).not.toBeNull();
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

  it("names the live watch source and links to its place in the order", async () => {
    const container = await mountPopup();

    const chip = container.querySelector<HTMLButtonElement>("[data-watch-source-chip]");
    expect(chip?.dataset.watchSourceChip).toBe("drops");
    expect(chip?.textContent).toBe("Drops · 1 of 4");
    expect(rail(container, "queue")?.querySelector("[data-rail-live]")).not.toBeNull();

    act(() => chip!.click());
    expect(currentView(container)).toBe("settings");
  });

  it("jumps to Watch order by scrolling the panel alone, never the popup frame", async () => {
    const container = await mountPopup();
    const view = container.ownerDocument.defaultView as unknown as typeof globalThis;
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(view.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    Object.defineProperty(view.HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    Object.defineProperty(view.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0 }) });

    act(() => container.querySelector<HTMLButtonElement>("[data-watch-source-chip]")!.click());

    expect(currentView(container)).toBe("settings");
    // scrollIntoView also scrolls every ancestor a script can scroll, which is
    // what shifted the whole popup up out of its window.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo.mock.contexts[0]).toBe(container.querySelector("[data-scroll-panel]"));
    // And the frame clips rather than hides, so no script can scroll it either.
    expect(container.querySelector("main")?.className).toContain("overflow-clip");
  });

  it("says where an extension sits in the watch order, and links to change it", async () => {
    const container = await mountPopup();
    go(container, "fortnite");

    const place = container.querySelector("[data-watch-source-place='fortnite']");
    expect(place?.textContent).toContain("3 of 4");
    expect(place?.textContent).toContain("Drops, NoPixelV");

    act(() => place!.querySelector<HTMLButtonElement>("button")!.click());
    expect(currentView(container)).toBe("settings");
  });

  it("marks the current destination for assistive technology", async () => {
    const container = await mountPopup();

    go(container, "games");

    expect(rail(container, "games")?.getAttribute("aria-current")).toBe("page");
    expect(rail(container, "queue")?.getAttribute("aria-current")).toBeNull();
  });
});

describe("workspace rail sources", () => {
  function mountRail(props: Partial<React.ComponentProps<typeof WorkspaceRail>>): HTMLElement {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const idle = { state: "idle" } as unknown as AutomationPresentation;
    const container = document.getElementById("app")!;
    act(() => {
      root = createRoot(container);
      root.render(
        <WorkspaceRail
          view="queue"
          platform="twitch"
          counts={{}}
          sourceOrder={["drops", "nopixel", "fortnite", "idle_watchlist"]}
          presentation={{ twitch: idle, kick: idle }}
          version="0.0.0"
          onViewChange={() => undefined}
          onPlatformChange={() => undefined}
          onOpenInventory={() => undefined}
          {...props}
        />,
      );
    });
    return container;
  }

  const sources = (container: Element): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>("button[data-view]")]
      .map((button) => button.dataset.view!)
      .filter((view) => ["nopixel", "fortnite", "watchlist"].includes(view));

  const group = (container: Element, key: string): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>(`[data-rail-group="${key}"] button[data-view]`)].map((button) => button.dataset.view!);

  it("groups the Twitch extensions apart from the other sources, each in watch order", () => {
    const container = mountRail({ sourceOrder: ["idle_watchlist", "drops", "fortnite", "nopixel"] });
    expect(group(container, "navExtensions")).toEqual(["fortnite", "nopixel"]);
    expect(group(container, "navGroupOthers")).toEqual(["watchlist"]);
    // Extensions first, then the rest, whatever the watch order.
    expect(sources(container)).toEqual(["fortnite", "nopixel", "watchlist"]);
  });

  it("marks only the source being watched", () => {
    const container = mountRail({ liveSource: "nopixel" });
    const live = [...container.querySelectorAll("[data-rail-live]")].map((dot) => dot.closest("button")?.dataset.view);
    expect(live).toEqual(["nopixel"]);
  });

  it("keeps Twitch-only sources off the Kick rail whatever the order says", () => {
    const container = mountRail({ platform: "kick", sourceOrder: ["drops", "idle_watchlist"] });
    expect(sources(container)).toEqual(["watchlist"]);
    // With no extensions on Kick, the group and its heading are left out.
    expect(container.querySelector('[data-rail-group="navExtensions"]')).toBeNull();
  });
});
