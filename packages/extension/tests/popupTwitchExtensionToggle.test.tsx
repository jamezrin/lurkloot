// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage } from "@lurkloot/shared/messages";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function providerSwitch(container: Element): HTMLButtonElement {
  const button = container.querySelector('section[aria-label="NoPixelV"] button[role="switch"]');
  if (!button) throw new Error("Missing NoPixelV switch");
  return button as HTMLButtonElement;
}

describe("popup Twitch extension toggle", () => {
  it("reflects the committed setting without waiting for the follow-up tick", async () => {
    document.body.innerHTML = "<div id=app></div>";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const demo = createDemoPopupAdapter();
    // A real tick can take many seconds; the switch must not wait for it.
    const send = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === "setTwitchExtensionEnabled") return { enabled: message.enabled };
      if (message.type === "tickNow") return new Promise(() => undefined);
      return demo.send(message);
    });
    const adapter: PopupAdapter = {
      ...demo,
      send: send as PopupAdapter["send"],
      requestTwitchExtensionPermission: async () => true,
    };
    const container = document.getElementById("app")!;

    await act(async () => {
      root = createRoot(container);
      root.render(<Popup adapter={adapter} />);
      await Promise.resolve();
    });
    act(() => (container.querySelector('button[data-view="nopixel"]') as HTMLButtonElement).click());

    const initial = providerSwitch(container).getAttribute("aria-checked") === "true";
    await act(async () => { providerSwitch(container).click(); });
    expect(send).toHaveBeenCalledWith({ type: "setTwitchExtensionEnabled", provider: "nopixel", enabled: !initial });
    expect(send).toHaveBeenCalledWith({ type: "tickNow" });
    expect(providerSwitch(container).getAttribute("aria-checked")).toBe(String(!initial));
    expect(providerSwitch(container).disabled).toBe(false);

    await act(async () => { providerSwitch(container).click(); });
    expect(send).toHaveBeenCalledWith({ type: "setTwitchExtensionEnabled", provider: "nopixel", enabled: initial });
    expect(providerSwitch(container).getAttribute("aria-checked")).toBe(String(initial));
    expect(providerSwitch(container).disabled).toBe(false);
  });
});
