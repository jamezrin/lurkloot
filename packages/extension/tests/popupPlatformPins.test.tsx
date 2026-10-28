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

// #922/#930: Unpin all on one platform's Queue saves only that platform's pins,
// and keeps every id in its list the Queue does not show: one migration 11
// copied in from the other platform, or one no list reports.
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
    const patches: unknown[] = [];
    const adapter: PopupAdapter = {
      ...demo,
      send: async <T,>(message: RuntimeMessage): Promise<T> => {
        const reply = await demo.send<RuntimeSnapshot | undefined>(message);
        if (message.type === "saveSettings") patches.push(message.settingsPatch);
        if (message.type === "getSnapshot" && reply) {
          const twitch = { ...reply.settings.platform.twitch, campaignPins: pins };
          const kick = { ...reply.settings.platform.kick, campaignPins: ["kick-arena"] };
          return {
            ...reply,
            settings: { ...reply.settings, platform: { twitch, kick } },
          } as T;
        }
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

    expect(patches).toEqual([
      { platform: { twitch: { campaignPins: ["kick-arena", "ended-campaign"] } } },
    ]);
  });
});
