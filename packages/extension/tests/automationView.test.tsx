import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";
import { AutomationHero, PlatformSwitcher } from "../../popup-ui/src/automation";
import { automationPresentation } from "../../popup-ui/src/automationStatus";
import { I18nContext, PopupRuntimeContext } from "../../popup-ui/src/context";
import type { PopupAdapter } from "../../popup-ui/src/types";

const messages: Record<string, string> = {
  automationTitle: "$1 automation",
  automationRunning: "Running",
  automationChecking: "Checking",
  automationNeedsSignIn: "Needs sign-in",
  automationBlocked: "Blocked",
  automationUnavailable: "Unavailable",
  authSignInMissing: "Sign in to continue farming drops.",
  authSignInRejected: "Your session is no longer valid. Sign in again to continue.",
  authBrowserProfileBlocked: "Kick rejected this browser profile. Signing in alone may not resolve it.",
  authPlatformTemporarilyUnavailable: "The platform is temporarily unavailable. Lurkloot will retry automatically.",
  signInToTwitch: "Sign in to Twitch",
  signInToKick: "Sign in to Kick",
  watchingLabel: "Watching",
  farmingLabel: "Farming",
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function presentation(platform: Platform, authHealth: PlatformAuthHealth) {
  return automationPresentation({ platform, enabled: true, pending: false, authHealth });
}

function mount(element: React.ReactElement) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const openLink = vi.fn();
  const adapter = { openLink } as unknown as PopupAdapter;
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{
        t: (key, substitutions) => (messages[key] ?? key).replace("$1", typeof substitutions === "string" ? substitutions : ""),
        dir: "ltr",
        locale: "en",
      }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          {element}
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });
  return { container, openLink };
}

describe("automation authentication status UI", () => {
  it("shows an explicit Twitch sign-in action and keeps the toggle enabled", () => {
    const { container, openLink } = mount(
      <AutomationHero
        platform="twitch"
        platformLabel="Twitch"
        enabled
        pending={false}
        presentation={presentation("twitch", { status: "missing_credentials" })}
        onChange={async () => undefined}
      />,
    );

    expect(container.textContent).toContain("Needs sign-in");
    expect(container.textContent).toContain("Sign in to Twitch");
    const action = container.querySelector<HTMLButtonElement>('[data-auth-action="twitch"]');
    expect(action).not.toBeNull();
    act(() => action?.click());
    expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/login");
    expect(container.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("explains a Kick browser-profile block without offering sign-in", () => {
    const { container } = mount(
      <AutomationHero
        platform="kick"
        platformLabel="Kick"
        enabled
        pending={false}
        presentation={presentation("kick", { status: "blocked", reasonCode: "security_policy_blocked" })}
        onChange={async () => undefined}
      />,
    );

    expect(container.querySelector('[data-automation-state="blocked"]')).not.toBeNull();
    expect(container.textContent).toContain("Kick rejected this browser profile");
    expect(container.querySelector("[data-auth-action]")).toBeNull();
    expect(container.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("shows operational state independently for each platform", () => {
    const { container } = mount(
      <PlatformSwitcher
        active="twitch"
        presentation={{
          twitch: presentation("twitch", { status: "healthy" }),
          kick: presentation("kick", { status: "unavailable", reasonCode: "platform_unavailable" }),
        }}
        onChange={() => undefined}
      />,
    );

    expect(container.querySelector('[data-platform-status="twitch"]')?.getAttribute("data-state")).toBe("running");
    expect(container.querySelector('[data-platform-status="kick"]')?.getAttribute("data-state")).toBe("unavailable");
  });

  it("hides stale farming detail while authentication is degraded", () => {
    const { container } = mount(
      <AutomationHero
        platform="kick"
        platformLabel="Kick"
        enabled
        pending={false}
        presentation={presentation("kick", { status: "unavailable" })}
        farmingTitle="Stale campaign"
        farmingChannel={{ name: "stale-channel" }}
        onChange={async () => undefined}
      />,
    );

    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("Stale campaign");
    expect(container.textContent).not.toContain("stale-channel");
  });
});
