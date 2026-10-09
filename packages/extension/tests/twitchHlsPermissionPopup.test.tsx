// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import { applySettingsPatch, mergeSettings } from "@lurkloot/shared/settings";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function renderPopup(options: {
  twitchEnabled?: boolean;
  heartbeat?: "twitch-heartbeat-spade-v1" | "twitch-heartbeat-hls-v1";
  request?: () => Promise<boolean>;
} = {}) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const demo = createDemoPopupAdapter();
  const requestTwitchHlsPermission = vi.fn(options.request ?? (async () => true));
  const send = vi.fn(async (message: RuntimeMessage) => {
    const result = await demo.send(message);
    if (message.type !== "getSnapshot" && message.type !== "setAutomation") return result;
    const snapshot = result as RuntimeSnapshot;
    const enabled = message.type === "setAutomation" && message.platform === "twitch"
      ? message.enabled
      : options.twitchEnabled ?? false;
    return {
      ...snapshot,
      settings: applySettingsPatch(mergeSettings(snapshot.settings), {
        platform: { twitch: { enabled } },
        ...(options.heartbeat ? { compatibility: { twitch: { heartbeatTransport: options.heartbeat } } } : {}),
      }),
    };
  });
  const adapter: PopupAdapter = {
    ...demo,
    send: send as PopupAdapter["send"],
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    resolveCompatibility: (selections) => resolveCompatibility(selections, { host: "extension", twitchIdentity: "web" }),
    requestTwitchHlsPermission,
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  return { container, requestTwitchHlsPermission, send };
}

async function switchLabelled(container: Element, label: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = container.querySelector(`button[role="switch"][aria-label="${label}"]`);
    if (button) return button as HTMLButtonElement;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error(`Missing switch: ${label}`);
}

describe("popup Twitch enable permission", () => {
  it("leaves Twitch off when the HLS video CDN grant is declined", async () => {
    let decide: (granted: boolean) => void = () => undefined;
    const { container, requestTwitchHlsPermission, send } = await renderPopup({
      request: () => new Promise<boolean>((resolve) => { decide = resolve; }),
    });
    const toggle = await switchLabelled(container, "Twitch automation");

    await act(async () => { toggle.click(); });
    expect(requestTwitchHlsPermission).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });

    await act(async () => { decide(false); });
    expect(send).not.toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("turns Twitch on after the HLS video CDN grant is allowed", async () => {
    let decide: (granted: boolean) => void = () => undefined;
    const { container, send } = await renderPopup({
      request: () => new Promise<boolean>((resolve) => { decide = resolve; }),
    });
    const toggle = await switchLabelled(container, "Twitch automation");
    await act(async () => { toggle.click(); });
    await act(async () => { decide(true); });
    expect(send).toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
  });

  it("does not ask when Twitch is turned on with Spade selected", async () => {
    const { container, requestTwitchHlsPermission, send } = await renderPopup({ heartbeat: "twitch-heartbeat-spade-v1" });
    await act(async () => { (await switchLabelled(container, "Twitch automation")).click(); });
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
  });

  it("does not ask when Twitch is turned off", async () => {
    const { container, requestTwitchHlsPermission, send } = await renderPopup({ twitchEnabled: true });
    await act(async () => { (await switchLabelled(container, "Twitch automation")).click(); });
    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: false });
  });

  it("asks when the heartbeat is switched to HLS while Twitch is already on", async () => {
    const { container, requestTwitchHlsPermission, send } = await renderPopup({
      twitchEnabled: true,
      heartbeat: "twitch-heartbeat-spade-v1",
    });
    await chooseHeartbeat(container, "twitch-heartbeat-hls-v1");
    expect(requestTwitchHlsPermission).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-hls-v1" } } },
    }));
  });

  it("keeps the previous heartbeat when switching to HLS is declined", async () => {
    const { container, requestTwitchHlsPermission, send } = await renderPopup({
      twitchEnabled: true,
      heartbeat: "twitch-heartbeat-spade-v1",
      request: async () => false,
    });
    await chooseHeartbeat(container, "twitch-heartbeat-hls-v1");
    expect(requestTwitchHlsPermission).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-hls-v1" } } },
    }));
    expect((await switchLabelled(container, "Twitch automation")).getAttribute("aria-checked")).toBe("true");
  });
});

async function chooseHeartbeat(container: Element, value: string): Promise<void> {
  act(() => (container.querySelector('button[data-view="settings"]') as HTMLButtonElement).click());
  let trigger: HTMLButtonElement | undefined;
  for (let attempt = 0; attempt < 20 && !trigger; attempt += 1) {
    trigger = container.querySelector('button[aria-haspopup="listbox"][aria-label="Twitch heartbeat transport"]') as HTMLButtonElement | null ?? undefined;
    if (!trigger) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  if (!trigger) throw new Error("Missing Twitch heartbeat select");
  await act(async () => {
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.dataset.value === value);
  if (!option) throw new Error(`Missing heartbeat option: ${value}`);
  await act(async () => {
    option.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
