import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { PopupInitialState } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import { TOUR_STEPS } from "../../popup-ui/src/onboardingTour.logic";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal),
);

let root: Root | undefined;
let win: (Window & { Event: typeof Event }) | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  win = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubDom(): HTMLElement {
  const { document, window } = parseHTML("<div id=app></div>");
  win = window as unknown as Window & { Event: typeof Event };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Timer-backed, as in a browser: a frame runs after React has committed the
  // frame's own view change, not synchronously inside the effect asking for it.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) =>
    clearTimeout(handle),
  );
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  return document.getElementById("app")!;
}

async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface FakeOptions {
  pending?: boolean | "reject";
  withHook?: boolean;
  uiLanguage?: string;
}

function fakeAdapter({ pending = true, withHook = true, uiLanguage = "en" }: FakeOptions = {}) {
  const demo = createDemoPopupAdapter();
  const send = vi.fn((message: RuntimeMessage) => demo.send(message));
  const getPendingOnboarding = vi.fn(() =>
    pending === "reject" ? Promise.reject(new Error("storage")) : Promise.resolve(pending),
  );
  const dismissPendingOnboarding = vi.fn(async () => undefined);
  const resetExtension = vi.fn(() => demo.send<RuntimeSnapshot>({ type: "getSnapshot" }));
  const adapter: PopupAdapter = {
    ...demo,
    send: send as PopupAdapter["send"],
    getUiLanguage: () => uiLanguage,
    ...(withHook ? { getPendingOnboarding, dismissPendingOnboarding } : {}),
    resetExtension,
  };
  return { adapter, send, getPendingOnboarding, dismissPendingOnboarding, resetExtension };
}

async function mount(
  adapter: PopupAdapter,
  initialState?: PopupInitialState,
): Promise<HTMLElement> {
  const container = stubDom();
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} initialState={initialState} />);
  });
  await waitForCatalog();
  await settle();
  return container;
}

function dialog(container: Element): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

function action(container: Element, name: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[role="dialog"] [data-tour-action="${name}"]`);
}

async function press(container: Element, name: string, turns?: number): Promise<void> {
  const button = action(container, name);
  if (!button) throw new Error(`Missing tour action: ${name}`);
  await act(async () => button.click());
  await settle(turns);
}

async function key(name: string): Promise<void> {
  const event = Object.assign(new win!.Event("keydown", { bubbles: true, cancelable: true }), {
    key: name,
  });
  await act(async () => {
    document.dispatchEvent(event);
  });
  await settle();
}

function progress(container: Element): string | null | undefined {
  return dialog(container)?.querySelector("[data-tour-progress]")?.textContent;
}

function main(container: Element): HTMLElement {
  return container.querySelector<HTMLElement>("main")!;
}

function byText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

function expectRealFrame(container: Element): void {
  expect(dialog(container)).toBeNull();
  expect(main(container).getAttribute("data-view")).toBe("queue");
  expect(container.querySelector("[inert]")).toBeNull();
}

describe("onboarding tour host", () => {
  it("opens on the welcome card over an inert frame when onboarding is pending", async () => {
    const { adapter } = fakeAdapter();
    const container = await mount(adapter);
    const card = dialog(container);
    expect(card?.textContent).toContain("Welcome to Lurkloot");
    expect(card?.getAttribute("aria-modal")).toBe("true");
    expect(card?.getAttribute("data-side")).toBe("center");
    expect(container.querySelector("[inert] nav")).not.toBeNull();
    expect(container.querySelector("[inert] [role='dialog']")).toBeNull();
  });

  it("renders the real frame when onboarding is not pending", async () => {
    const { adapter } = fakeAdapter({ pending: false });
    expectRealFrame(await mount(adapter));
  });

  it("renders the loading shell while the pending check is unresolved", async () => {
    const fake = fakeAdapter();
    fake.getPendingOnboarding.mockImplementation(() => new Promise<boolean>(() => undefined));
    const container = stubDom();
    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={fake.adapter} />);
    });
    await settle();
    expect(container.querySelector("main")).not.toBeNull();
    expect(container.querySelector("main nav")).toBeNull();
    expect(dialog(container)).toBeNull();
  });

  it("never asks a host without the hook", async () => {
    const { adapter, getPendingOnboarding } = fakeAdapter({ withHook: false });
    expectRealFrame(await mount(adapter));
    expect(getPendingOnboarding).not.toHaveBeenCalled();
  });

  it("never asks in a preview", async () => {
    const { adapter, getPendingOnboarding } = fakeAdapter();
    const container = await mount(adapter, { preview: true });
    expect(dialog(container)).toBeNull();
    expect(container.querySelector("main nav")).not.toBeNull();
    expect(getPendingOnboarding).not.toHaveBeenCalled();
  });

  it("renders the real frame when the pending check fails", async () => {
    const { adapter } = fakeAdapter({ pending: "reject" });
    expectRealFrame(await mount(adapter));
  });

  it("walks all twelve steps, then finishes for good", async () => {
    const fake = fakeAdapter();
    const container = await mount(fake.adapter);
    await press(container, "start");
    for (const [index, step] of TOUR_STEPS.entries()) {
      if (index > 0) await press(container, "next");
      expect(main(container).getAttribute("data-view"), step.id).toBe(step.view);
      expect(main(container).getAttribute("data-platform"), step.id).toBe(step.platform);
      expect(progress(container), step.id).toBe(`${index + 1} / 12`);
      // Every step's target exists, so the card is anchored to a spotlight.
      expect(dialog(container)?.getAttribute("data-side"), step.id).not.toBe("center");
      expect(container.querySelector("[data-tour-spotlight]"), step.id).not.toBeNull();
      expect(container.querySelector("[data-tour-scrim]"), step.id).toBeNull();
      if (step.id === "activity") {
        expect(
          container.querySelector('[data-tour="activity-list"] [data-activity-card]'),
        ).not.toBeNull();
      }
    }
    await press(container, "next");
    expect(dialog(container)?.textContent).toContain("You're set!");
    expect(action(container, "finish")?.textContent).toContain("Let's go!");
    // The tour talks only to its demo adapter until it closes.
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.dismissPendingOnboarding).not.toHaveBeenCalled();

    await press(container, "finish");
    expect(fake.dismissPendingOnboarding).toHaveBeenCalledOnce();
    expectRealFrame(container);
  });

  it("goes back a step and hides Back on the first step", async () => {
    const { adapter } = fakeAdapter();
    const container = await mount(adapter);
    await press(container, "start");
    expect(action(container, "back")).toBeNull();
    await press(container, "next");
    expect(progress(container)).toBe("2 / 12");
    await press(container, "back");
    expect(progress(container)).toBe("1 / 12");
    expect(action(container, "back")).toBeNull();
  });

  it("skips for good from the welcome card", async () => {
    const fake = fakeAdapter();
    const container = await mount(fake.adapter);
    await press(container, "skip");
    expect(fake.dismissPendingOnboarding).toHaveBeenCalledOnce();
    expectRealFrame(container);
  });

  it("skips for good mid-tour", async () => {
    const fake = fakeAdapter();
    const container = await mount(fake.adapter);
    await press(container, "start");
    await press(container, "next");
    await press(container, "next");
    await press(container, "skip");
    expect(fake.dismissPendingOnboarding).toHaveBeenCalledOnce();
    expectRealFrame(container);
  });

  it("skips for good on Escape", async () => {
    const fake = fakeAdapter();
    const container = await mount(fake.adapter);
    await press(container, "start");
    await key("Escape");
    expect(fake.dismissPendingOnboarding).toHaveBeenCalledOnce();
    expectRealFrame(container);
  });

  it("still closes when dismissing fails", async () => {
    const fake = fakeAdapter();
    fake.dismissPendingOnboarding.mockRejectedValueOnce(new Error("storage"));
    const container = await mount(fake.adapter);
    await press(container, "skip");
    expectRealFrame(container);
  });

  it("does not dismiss when the popup closes mid-tour", async () => {
    const fake = fakeAdapter();
    const container = await mount(fake.adapter);
    await press(container, "start");
    for (let i = 0; i < 4; i += 1) await press(container, "next");
    expect(progress(container)).toBe("5 / 12");
    act(() => root?.unmount());
    root = undefined;
    expect(fake.dismissPendingOnboarding).not.toHaveBeenCalled();
  });

  it("shows the welcome card again after a factory reset", async () => {
    const fake = fakeAdapter({ pending: false });
    const container = await mount(fake.adapter);
    expectRealFrame(container);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[data-view="settings"]')!.click(),
    );
    await settle();
    await act(async () => byText(container, "Reset Lurkloot").click());
    await settle();
    await act(async () => byText(container, "Reset everything").click());
    await settle();
    expect(fake.resetExtension).toHaveBeenCalledOnce();
    expect(dialog(container)?.textContent).toContain("Welcome to Lurkloot");
    // The wrapped reset armed the tour; nothing asked storage again.
    expect(fake.getPendingOnboarding).toHaveBeenCalledOnce();
  });

  it("keeps one spotlight gliding between steps, across a view switch too", async () => {
    const { adapter } = fakeAdapter();
    const container = await mount(adapter);
    await press(container, "start");
    const spotlight = container.querySelector("[data-tour-spotlight]");
    expect(spotlight).not.toBeNull();
    // Steps 1 to 4 share the queue; step 5 switches to Completed.
    for (let i = 0; i < 4; i += 1) {
      // Right after the click, before any frame has measured the new target,
      // the previous rect still shows: no scrim, no centred card.
      act(() => action(container, "next")!.click());
      expect(container.querySelector("[data-tour-spotlight]")).toBe(spotlight);
      expect(container.querySelector("[data-tour-scrim]")).toBeNull();
      expect(dialog(container)?.getAttribute("data-side")).not.toBe("center");
      await settle();
      expect(container.querySelector("[data-tour-spotlight]")).toBe(spotlight);
    }
    expect(progress(container)).toBe("5 / 12");
    expect(main(container).getAttribute("data-view")).toBe("completed");
  });

  it("centres the card when a step's target is missing, and still advances", async () => {
    const { adapter } = fakeAdapter();
    const container = await mount(adapter);
    await press(container, "start");
    for (let i = 0; i < 4; i += 1) await press(container, "next");
    const frame = main(container);
    const original = frame.querySelector.bind(frame);
    vi.spyOn(frame, "querySelector").mockImplementation(((selector: string) =>
      selector === '[data-tour="games-mode"]' ? null : original(selector)) as never);
    await press(container, "next", 60);
    expect(progress(container)).toBe("6 / 12");
    expect(dialog(container)?.getAttribute("data-side")).toBe("center");
    expect(container.querySelector("[data-tour-scrim]")).not.toBeNull();
    expect(container.querySelector("[data-tour-spotlight]")).toBeNull();
    await press(container, "next");
    expect(progress(container)).toBe("7 / 12");
  });

  it("moves forward with Enter and the arrow keys", async () => {
    const { adapter } = fakeAdapter();
    const container = await mount(adapter);
    await key("Enter");
    expect(progress(container)).toBe("1 / 12");
    await key("ArrowRight");
    expect(progress(container)).toBe("2 / 12");
    await key("ArrowLeft");
    expect(progress(container)).toBe("1 / 12");
  });

  it("swaps the arrow keys in a right-to-left locale", async () => {
    const { adapter } = fakeAdapter({ uiLanguage: "ar" });
    const container = await mount(adapter);
    expect(main(container).getAttribute("dir")).toBe("rtl");
    await press(container, "start");
    await key("ArrowLeft");
    expect(progress(container)).toBe("2 / 12");
    await key("ArrowRight");
    expect(progress(container)).toBe("1 / 12");
  });
});
