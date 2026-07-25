import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { Platform } from "@lurkloot/shared/models";
import { DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
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
  await act(async () => {
    await Promise.resolve();
  });

  return { container, sent, adapter };
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
