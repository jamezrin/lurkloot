import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup } from "@lurkloot/popup-ui";
import { PopupFrame, type PopupTourFrame } from "../../popup-ui/src/Popup";
import { TOUR_STEPS } from "../../popup-ui/src/onboardingTour.logic";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { resetCatalogTracking, waitForCatalog } from "./helpers/popupCatalog";

vi.mock("@lurkloot/locales", async (importOriginal) =>
  (await import("./helpers/popupCatalog")).delayedLocales(importOriginal),
);

let root: Root | undefined;

afterEach(() => {
  resetCatalogTracking();
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function stubDom(): HTMLElement {
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
  return document.getElementById("app")!;
}

async function settle(): Promise<void> {
  // The tour demo answers every request with a resolved promise; a few
  // microtask turns let the snapshot, the activity page and the effects they
  // trigger all land.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function tourFrame(step: (typeof TOUR_STEPS)[number]): PopupTourFrame {
  return {
    view: step.view,
    platform: step.platform,
    ...(step.settingsFocus ? { settingsFocus: step.settingsFocus } : {}),
    overlay: <div data-test-overlay />,
  };
}

async function mountFrame(
  adapter: PopupAdapter,
  tour: PopupTourFrame | undefined,
): Promise<HTMLElement> {
  const container = stubDom();
  await act(async () => {
    root = createRoot(container);
    root.render(<PopupFrame adapter={adapter} initialState={{ preview: true }} tour={tour} />);
  });
  await waitForCatalog();
  await settle();
  return container;
}

async function rerenderFrame(adapter: PopupAdapter, tour: PopupTourFrame): Promise<void> {
  await act(async () => {
    root?.render(<PopupFrame adapter={adapter} initialState={{ preview: true }} tour={tour} />);
  });
  await settle();
}

function expectStep(container: HTMLElement, step: (typeof TOUR_STEPS)[number]): void {
  const main = container.querySelector("main");
  expect(main?.getAttribute("data-view"), step.id).toBe(step.view);
  expect(main?.getAttribute("data-platform"), step.id).toBe(step.platform);
  for (const target of step.targets) {
    expect(container.querySelector(target), `${step.id}: ${target}`).not.toBeNull();
  }
}

describe("popup frame in tour mode", () => {
  it.each(TOUR_STEPS.map((step) => [step.id, step] as const))(
    "shows every target of the %s step",
    async (_id, step) => {
      const container = await mountFrame(
        createDemoPopupAdapter({ scenario: "tour" }),
        tourFrame(step),
      );
      expectStep(container, step);
    },
  );

  it("follows the tour from step to step in one frame", async () => {
    const adapter = createDemoPopupAdapter({ scenario: "tour" });
    const [first, ...rest] = TOUR_STEPS;
    const container = await mountFrame(adapter, tourFrame(first!));
    expectStep(container, first!);
    for (const step of rest) {
      await rerenderFrame(adapter, tourFrame(step));
      expectStep(container, step);
    }
  });

  it("makes the frame inert and renders the overlay inside main", async () => {
    const container = await mountFrame(
      createDemoPopupAdapter({ scenario: "tour" }),
      tourFrame(TOUR_STEPS[0]!),
    );
    const main = container.querySelector("main")!;
    expect(main.querySelector("[data-test-overlay]")).not.toBeNull();
    const inert = main.querySelector(":scope > div[inert]");
    expect(inert).not.toBeNull();
    expect(inert?.querySelector("nav")).not.toBeNull();
    expect(inert?.querySelector("[data-test-overlay]")).toBeNull();
  });

  it("leaves the frame interactive without a tour", async () => {
    const container = await mountFrame(createDemoPopupAdapter({ scenario: "tour" }), undefined);
    expect(container.querySelector("main")).not.toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("keeps the Popup export rendering the frame", async () => {
    const container = stubDom();
    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={createDemoPopupAdapter()} />);
    });
    await waitForCatalog();
    expect(container.querySelector("main nav")).not.toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
  });
});
