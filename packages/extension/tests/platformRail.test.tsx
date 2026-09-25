// @vitest-environment happy-dom
// The rail's platform switch is Base UI Tabs, which needs real keyboard events.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";
import { automationPresentation } from "../../popup-ui/src/automationStatus";
import { I18nContext } from "../../popup-ui/src/context";
import { WorkspaceRail } from "../../popup-ui/src/shell";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const presentation = (platform: Platform, authHealth: PlatformAuthHealth) =>
  automationPresentation({ platform, enabled: true, pending: false, authHealth });

function mountRail(active: Platform, onPlatformChange = vi.fn(), kick: PlatformAuthHealth = { status: "healthy" }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = "<div id=app></div>";
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t: (key) => key, dir: "ltr", locale: "en" }}>
        <WorkspaceRail
          view="queue"
          platform={active}
          counts={{}}
          sourceOrder={["drops"]}
          presentation={{ twitch: presentation("twitch", { status: "healthy" }), kick: presentation("kick", kick) }}
          version="1.0.0"
          onViewChange={() => undefined}
          onPlatformChange={onPlatformChange}
          onOpenInventory={() => undefined}
        />
      </I18nContext.Provider>,
    );
  });
  const tab = (label: string) => container.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${label}"]`)!;
  return { container, tab, onPlatformChange };
}

describe("rail platform switch", () => {
  it("shows each platform's operational state on its own tab", () => {
    const { container } = mountRail("twitch", vi.fn(), { status: "unavailable", reasonCode: "platform_unavailable" });
    expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("running");
    expect(container.querySelector('[data-platform-status="kick"]')?.getAttribute("data-state")).toBe("unavailable");
  });

  it("marks the selected platform and keeps only it in the tab order", () => {
    const { tab } = mountRail("twitch");
    expect(tab("Twitch").getAttribute("aria-selected")).toBe("true");
    expect(tab("Kick").getAttribute("aria-selected")).toBe("false");
    expect(tab("Twitch").getAttribute("tabindex")).toBe("0");
    expect(tab("Kick").getAttribute("tabindex")).toBe("-1");
  });

  it("switches platform with a click and with the arrow keys", async () => {
    const { tab, onPlatformChange } = mountRail("twitch");

    act(() => tab("Kick").click());
    expect(onPlatformChange).toHaveBeenLastCalledWith("kick");

    onPlatformChange.mockClear();
    await act(async () => {
      tab("Twitch").focus();
      tab("Twitch").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onPlatformChange).toHaveBeenLastCalledWith("kick");
  });
});
