import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { Platform } from "@lurkloot/shared/models";
import { DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";

// Reproduces the cold module cache deterministically: the real loadCatalog is a
// dynamic import(), so its resolution can take several macrotasks the first time
// a worker loads the catalog. Tests set this to emulate that first load.
const catalogDelay = { ticks: 0 };

vi.mock("@lurkloot/locales", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lurkloot/locales")>();
  return {
    ...actual,
    loadCatalog: async (locale: Parameters<typeof actual.loadCatalog>[0]) => {
      for (let tick = 0; tick < catalogDelay.ticks; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return actual.loadCatalog(locale);
    },
  };
});

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  catalogDelay.ticks = 0;
  vi.unstubAllGlobals();
});

const FLAGGED = {
  ...DEFAULT_CRITICAL_HEALTH,
  status: "flagged" as const,
  reason: "page_context_churn" as const,
  flaggedAt: "2026-07-25T11:59:00.000Z",
  breakerOpen: true,
};

async function mountPopup(options: { flagged: Platform | null; promptEnabled?: boolean }) {
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
  const base = await demo.send<RuntimeSnapshot>({ type: "getSnapshot" });
  const snapshot: RuntimeSnapshot = {
    ...base,
    settings: {
      ...base.settings,
      running: true,
      criticalFailurePromptEnabled: options.promptEnabled ?? true,
    },
    state: {
      ...base.state,
      ...(options.flagged ? { criticalHealth: { [options.flagged]: FLAGGED } } : {}),
    },
  };

  const sent: RuntimeMessage[] = [];
  const send = async <T,>(message: RuntimeMessage): Promise<T> => {
    sent.push(message);
    if (message.type === "getSnapshot") return snapshot as T;
    return demo.send<T>(message);
  };
  const adapter: PopupAdapter = {
    ...demo,
    send,
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
    writeClipboard: vi.fn(async () => true),
    openLink: vi.fn(),
  };

  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container as unknown as HTMLElement);
    root.render(<Popup adapter={adapter} />);
    await Promise.resolve();
  });
  await waitForCatalog(container);

  return { container, sent, adapter };
}

// The popup fills its labels from loadCatalog(), a dynamic import() of a JSON
// catalog. That needs real module resolution rather than a fixed number of
// microtask flushes, so whether the labels are translated by the time the
// assertions run depends on which test file warmed the module cache first. Until
// it resolves the header status line renders its raw key ("automationRunning ·
// Twitch" instead of "Running · Twitch") and every copy assertion fails.
//
// Yield to the macrotask queue until the status line is translated. Match on the
// untranslated form: a raw "automationRunning" also appears elsewhere in the
// header regardless of the catalog, and "Running · Twitch" is a substring of the
// untranslated "automationRunning · Twitch", so neither works as a positive
// signal.
async function waitForCatalog(container: Element): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!container.textContent?.includes("automationRunning · Twitch")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(
    `Popup message catalog never loaded; rendered text was: ${container.textContent?.slice(0, 200)}`,
  );
}

describe("critical failure prompt in the popup", () => {
  it("replaces the drops list for the flagged platform", async () => {
    const { container } = await mountPopup({ flagged: "twitch" });

    expect(container.textContent).toContain("Copy logs & open issue");
    expect(container.textContent).toContain("Dismiss and try again");
  });

  it("leaves the popup alone when the other platform is the flagged one", async () => {
    const { container } = await mountPopup({ flagged: "kick" });

    expect(container.textContent).not.toContain("Copy logs & open issue");
  });

  it("respects the criticalFailurePromptEnabled kill switch", async () => {
    const { container } = await mountPopup({ flagged: "twitch", promptEnabled: false });

    expect(container.textContent).not.toContain("Copy logs & open issue");
  });

  // Regression guard for the intermittent failure this file used to produce: the
  // assertions ran against raw message keys whenever the catalog import needed
  // more than the microtask flushes the mount helper used to perform.
  it("renders translated copy even when the catalog import resolves late", async () => {
    catalogDelay.ticks = 5;

    const { container } = await mountPopup({ flagged: "twitch" });

    expect(container.textContent).toContain("Copy logs & open issue");
    expect(container.textContent).not.toContain("automationRunning · Twitch");
  });

  it("asks the background to dismiss, then refreshes", async () => {
    const { container, sent } = await mountPopup({ flagged: "twitch" });

    const dismiss = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Dismiss and try again"));
    expect(dismiss).toBeDefined();

    await act(async () => {
      (dismiss as unknown as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(sent).toContainEqual({ type: "dismissCriticalFailure", platform: "twitch" });
  });
});
