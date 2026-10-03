// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { applySettingsPatch, mergeSettings } from "@lurkloot/shared/settings";
import { createRuntimeRequestSender, REQUEST_FAILED_RESPONSE, RuntimeRequestError } from "../src/core/runtimeRequests";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime request sender", () => {
  it("rejects the background's failed-handler envelope", async () => {
    const send = createRuntimeRequestSender(async () => REQUEST_FAILED_RESPONSE);
    await expect(send({ type: "saveSettings" })).rejects.toBeInstanceOf(RuntimeRequestError);
  });

  it("passes every other response through, including empty ones", async () => {
    const snapshot = { state: {}, settings: {} };
    expect(await createRuntimeRequestSender(async () => snapshot)({ type: "getSnapshot" })).toBe(snapshot);
    expect(await createRuntimeRequestSender(async () => undefined)({ type: "clearActivity" })).toBeUndefined();
  });
});

function switchLabelled(container: Element, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[role="switch"][aria-label="${label}"]`);
  if (!button) throw new Error(`Missing switch: ${label}`);
  return button as HTMLButtonElement;
}

// Renders the popup over the extension's real sender, backed by the demo
// handlers until `failing` is set, after which every handler "throws" the way
// background.ts reports it: a resolved REQUEST_FAILED_RESPONSE. `handle` can
// answer a message first; whatever it leaves undefined goes to the demo.
async function renderPopup(handle?: (message: RuntimeMessage, demo: PopupAdapter) => Promise<unknown>) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const demo = createDemoPopupAdapter();
  const control = { failing: false };
  const sendMessage = vi.fn(async (message: unknown) => {
    if (control.failing) return REQUEST_FAILED_RESPONSE;
    const request = message as RuntimeMessage;
    return await handle?.(request, demo) ?? demo.send(request);
  });
  const adapter: PopupAdapter = { ...demo, send: createRuntimeRequestSender(sendMessage) as PopupAdapter["send"] };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
    await Promise.resolve();
  });
  return { container, control, sendMessage };
}

describe("popup background request failures", () => {
  it("rolls an optimistic settings change back when the save fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, control, sendMessage } = await renderPopup();
    act(() => (container.querySelector('button[data-view="settings"]') as HTMLButtonElement).click());
    const initial = switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked");

    control.failing = true;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await act(async () => { switchLabelled(container, "Auto-claim drops").click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "saveSettings" }));
    expect(switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked")).toBe(initial);
  });

  it("restores the stored value when two queued edits of one setting both fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let releaseSaves!: () => void;
    const savesReleased = new Promise<void>((resolve) => { releaseSaves = resolve; });
    const { container } = await renderPopup(async (message) => {
      if (message.type !== "saveSettings") return undefined;
      await savesReleased;
      return REQUEST_FAILED_RESPONSE;
    });
    act(() => (container.querySelector('button[data-view="settings"]') as HTMLButtonElement).click());
    const initial = switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked");

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // The second edit queues behind the first, which is still saving.
      await act(async () => { switchLabelled(container, "Auto-claim drops").click(); });
      await act(async () => { switchLabelled(container, "Auto-claim drops").click(); });
      await act(async () => {
        releaseSaves();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    // Neither edit was stored, so the switch shows what storage still holds.
    expect(switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked")).toBe(initial);
  });

  it("keeps an edit the background stored before its save failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The background persists the settings, then rescheduling its jobs throws.
    let stored: ExtensionSettings | undefined;
    const { container } = await renderPopup(async (message, demo) => {
      if (message.type === "saveSettings") {
        const { settings } = await demo.send<RuntimeSnapshot>({ type: "getSnapshot" });
        stored = applySettingsPatch(stored ?? mergeSettings(settings), message.settingsPatch);
        return REQUEST_FAILED_RESPONSE;
      }
      if (message.type === "getSnapshot" && stored) return { ...await demo.send<RuntimeSnapshot>(message), settings: stored };
      return undefined;
    });
    act(() => (container.querySelector('button[data-view="settings"]') as HTMLButtonElement).click());
    const initial = switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked");

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await act(async () => { switchLabelled(container, "Auto-claim drops").click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(switchLabelled(container, "Auto-claim drops").getAttribute("aria-checked")).toBe(initial === "true" ? "false" : "true");
  });

  it("keeps the last good snapshot when automation, refresh and the poll fail", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, control, sendMessage } = await renderPopup();
    const automation = switchLabelled(container, "Twitch automation");
    const enabled = automation.getAttribute("aria-checked");

    control.failing = true;
    await act(async () => { automation.click(); });
    await act(async () => { (container.querySelector('button[aria-label="Refresh schedule"]') as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    for (const type of ["setAutomation", "tickNow", "getSnapshot"]) {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type }));
    }
    // Still the snapshot from before the failures: the strip renders and the
    // switch kept its committed position.
    expect(switchLabelled(container, "Twitch automation").getAttribute("aria-checked")).toBe(enabled);
    expect(container.textContent).not.toContain("Loading");
  });
});
