import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

// #922: campaignPins is one list for both platforms, so Unpin all on one
// platform's Queue must leave the other platform's pins, and ids no list
// reports, where they are.
describe("popup Unpin all", () => {
  it("removes only the open platform's pins", async () => {
    const { document, window } = parseHTML("<div id=app></div>");
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));

    const pins = ["kick-arena", "tw-marathon", "ended-campaign", "tw-starfall"];
    const demo = createDemoPopupAdapter();
    const saved: string[][] = [];
    const adapter: PopupAdapter = {
      ...demo,
      send: async <T,>(message: RuntimeMessage): Promise<T> => {
        const reply = await demo.send<RuntimeSnapshot | undefined>(message);
        if (message.type === "saveSettings" && message.settingsPatch.campaignPins)
          saved.push(message.settingsPatch.campaignPins);
        if (message.type === "getSnapshot" && reply)
          return { ...reply, settings: { ...reply.settings, campaignPins: pins } } as T;
        return reply as T;
      },
    };
    const container = document.getElementById("app")!;

    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={adapter} />);
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const unpinAll = container.querySelector<HTMLButtonElement>("[data-queue-unpin-all]");
    expect(unpinAll).not.toBeNull();
    // The open platform is Twitch: two of the four stored pins are its own.
    expect(unpinAll!.textContent).toContain("2");
    await act(async () => {
      unpinAll!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(saved).toEqual([["kick-arena", "ended-campaign"]]);
  });
});
