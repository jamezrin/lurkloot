// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot, TwitchHlsGrantIntent } from "@lurkloot/shared/messages";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { buildSettingsExportPayload } from "@lurkloot/shared/settingsExport";

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
  request?: (intent: TwitchHlsGrantIntent) => Promise<boolean>;
  importSettings?: () => Promise<unknown>;
} = {}) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const demo = createDemoPopupAdapter();
  // What the background has stored for Twitch. Changed by the popup's own
  // messages and by the background applying a granted intent.
  let twitchEnabled = options.twitchEnabled ?? false;
  let heartbeat: string | undefined = options.heartbeat;
  const withStoredTwitch = (snapshot: RuntimeSnapshot): RuntimeSnapshot => ({
    ...snapshot,
    settings: applySettingsPatch(mergeSettings(snapshot.settings), {
      platform: { twitch: { enabled: twitchEnabled } },
      ...(heartbeat ? { compatibility: { twitch: { heartbeatTransport: heartbeat as never } } } : {}),
    }),
  });
  const send = vi.fn(async (message: RuntimeMessage) => {
    const result = await demo.send(message);
    if (message.type === "setAutomation" && message.platform === "twitch") twitchEnabled = message.enabled;
    if (message.type !== "getSnapshot" && message.type !== "setAutomation") return result;
    return withStoredTwitch(result as RuntimeSnapshot);
  });
  // The background applies a granted intent and answers with the snapshot.
  const applied: TwitchHlsGrantIntent[] = [];
  const request = options.request ?? (async () => true);
  const requestTwitchHlsGrant = vi.fn(async (intent: TwitchHlsGrantIntent) => {
    if (!await request(intent)) return undefined;
    applied.push(intent);
    if (intent.type === "setAutomation") twitchEnabled = true;
    else {
      twitchEnabled = intent.settingsPatch.platform?.twitch?.enabled ?? twitchEnabled;
      heartbeat = intent.settingsPatch.compatibility?.twitch?.heartbeatTransport ?? heartbeat;
    }
    return withStoredTwitch(await demo.send({ type: "getSnapshot" }) as RuntimeSnapshot);
  });
  const adapter: PopupAdapter = {
    ...demo,
    send: send as PopupAdapter["send"],
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    resolveCompatibility: (selections) => resolveCompatibility(selections, { host: "extension", twitchIdentity: "web" }),
    requestTwitchHlsGrant,
    ...(options.importSettings ? { importSettings: options.importSettings } : {}),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
  });
  return { container, requestTwitchHlsPermission: requestTwitchHlsGrant, send, applied };
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
    const { container, requestTwitchHlsPermission, send, applied } = await renderPopup({
      request: () => new Promise<boolean>((resolve) => { decide = resolve; }),
    });
    const toggle = await switchLabelled(container, "Twitch automation");

    await act(async () => { toggle.click(); });
    expect(requestTwitchHlsPermission).toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
    expect(send).not.toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });

    await act(async () => { decide(false); });
    expect(send).not.toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
    expect(applied).toEqual([]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("shows Twitch on after the background applies an allowed grant, without enabling it again", async () => {
    let decide: (granted: boolean) => void = () => undefined;
    const { container, send, applied } = await renderPopup({
      request: () => new Promise<boolean>((resolve) => { decide = resolve; }),
    });
    const toggle = await switchLabelled(container, "Twitch automation");
    await act(async () => { toggle.click(); });
    await act(async () => { decide(true); });
    expect(applied).toEqual([{ type: "setAutomation", platform: "twitch", enabled: true }]);
    expect(send).not.toHaveBeenCalledWith({ type: "setAutomation", platform: "twitch", enabled: true });
    expect((await switchLabelled(container, "Twitch automation")).getAttribute("aria-checked")).toBe("true");
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

  it("asks when the heartbeat is switched to HLS while Twitch is already on, and lets the background save it", async () => {
    const { container, requestTwitchHlsPermission, send, applied } = await renderPopup({
      twitchEnabled: true,
      heartbeat: "twitch-heartbeat-spade-v1",
    });
    await chooseHeartbeat(container, "twitch-heartbeat-hls-v1");
    const intent = {
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-hls-v1" } } },
    };
    expect(requestTwitchHlsPermission).toHaveBeenCalledWith(intent);
    expect(applied).toEqual([intent]);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "saveSettings" }));
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

  it("imports settings that turn Twitch on without prompting outside the click", async () => {
    const exported = buildSettingsExportPayload(applySettingsPatch(mergeSettings(DEFAULT_SETTINGS), {
      platform: { twitch: { enabled: true } },
    }));
    const { container, requestTwitchHlsPermission, send } = await renderPopup({
      importSettings: async () => JSON.parse(JSON.stringify(exported)),
    });
    act(() => (container.querySelector('button[data-view="settings"]') as HTMLButtonElement).click());
    await act(async () => { (await buttonWithText(container, "Import settings")).click(); });
    await act(async () => { (await buttonWithText(container, "Choose file and import")).click(); });

    expect(requestTwitchHlsPermission).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveSettings",
      settingsPatch: expect.objectContaining({ platform: expect.objectContaining({ twitch: expect.objectContaining({ enabled: true }) }) }),
      tickAfterSave: true,
    }));
  });
});

async function buttonWithText(container: Element, text: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
    if (button) return button;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error(`Missing button: ${text}`);
}

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
