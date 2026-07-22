import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import { createDemoPopupAdapter, Popup, type PopupAdapter } from "@lurkloot/popup-ui";

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountWithSnapshots(authStatuses: Array<RuntimeSnapshot["state"]["authHealth"]["twitch"]>) {
  vi.useFakeTimers();
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
  let index = 0;
  const snapshots = authStatuses.map((authHealth) => ({
    ...base,
    settings: {
      ...base.settings,
      running: true,
      platform: {
        ...base.settings.platform,
        twitch: { ...base.settings.platform.twitch, enabled: true },
      },
    },
    state: {
      ...base.state,
      authHealth: { ...base.state.authHealth, twitch: authHealth },
      sessions: {
        ...base.state.sessions,
        twitch: {
          ...base.state.sessions.twitch,
          message: "secret-cookie=must-not-render",
          status: "watching" as const,
        },
      },
    },
  }));
  const sent: RuntimeMessage[] = [];
  const send = async <T,>(message: RuntimeMessage): Promise<T> => {
    sent.push(message);
    if (message.type === "getSnapshot") {
      const result = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return result as T;
    }
    return demo.send<T>(message);
  };
  const adapter: PopupAdapter = {
    ...demo,
    send,
    getStorage: async () => ({ "popup:selectedPlatform": "twitch" }),
  };
  const container = document.getElementById("app")!;
  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, sent };
}

describe("popup authentication health", () => {
  it("keeps the header, switcher, and hero consistent in a degraded state", async () => {
    const { container } = await mountWithSnapshots([{
      status: "missing_credentials",
      reasonCode: "credentials_missing",
    }]);

    expect(container.querySelector('[data-automation-state="needs_sign_in"]')).not.toBeNull();
    expect(container.textContent).toContain("Needs sign-in · Twitch");
    expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("needs_sign_in");
    expect(container.textContent).not.toContain("secret-cookie=must-not-render");
  });

  it("recovers from sign-in on the existing snapshot refresh without changing automation", async () => {
    const { container, sent } = await mountWithSnapshots([
      { status: "missing_credentials", reasonCode: "credentials_missing" },
      { status: "healthy", checkedAt: "2026-07-22T20:00:00.000Z" },
    ]);

    expect(container.querySelector('[data-automation-state="needs_sign_in"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(container.querySelector('[data-automation-state="running"]')).not.toBeNull();
    expect(container.textContent).toContain("Running · Twitch");
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "setAutomation" }));
  });
});
