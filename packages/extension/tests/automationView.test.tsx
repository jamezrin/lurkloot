import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";
import { AutomationStatusLine } from "../../popup-ui/src/automation";
import type { AutomationPresentation } from "../../popup-ui/src/automationStatus";
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
  waitingEligibleStream: "No eligible live stream is currently available for this campaign",
  automationPausedTabClosed: "Paused — tab closed",
  watchTabClosedPauseDetail: "You closed the farming tab, so Lurkloot stopped farming here.",
  resumeFarming: "Resume farming",
  automationPausedManualWatch: "Manual watching",
  manualWatchPauseDetail: "Farming is paused while you're watching a stream yourself. Pause it, close it, or switch away from that tab to resume automatically on the next check.",
  manualWatchPauseDetailNamedSuffix: "— pause it, close it, or switch away to resume.",
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

// The status line as the popup's status strip shows it. The platform switch
// lives in the rail now; platformRail.test.tsx covers it.
function mountHeader(options: {
  platform: Platform;
  presentation: AutomationPresentation;
  farmingTitle?: string;
  farmingChannel?: { name: string };
  onResume?(): void;
}) {
  return mount(
    <AutomationStatusLine
      platform={options.platform}
      presentation={options.presentation}
      farmingTitle={options.farmingTitle}
      farmingChannel={options.farmingChannel}
      onResume={options.onResume}
    />,
  );
}

describe("automation authentication status UI", () => {
  it("shows an explicit Twitch sign-in action", () => {
    const { container, openLink } = mountHeader({
      platform: "twitch",
      presentation: presentation("twitch", { status: "missing_credentials" }),
    });

    expect(container.textContent).toContain("Needs sign-in");
    expect(container.textContent).toContain("Sign in to Twitch");
    const action = container.querySelector<HTMLButtonElement>('[data-auth-action="twitch"]');
    expect(action).not.toBeNull();
    act(() => action?.click());
    expect(openLink).toHaveBeenCalledWith("https://www.twitch.tv/login");
  });

  it("offers a one-click resume after the user closed the farming tab", () => {
    const onResume = vi.fn();
    const { container } = mountHeader({
      platform: "kick",
      presentation: automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: { status: "healthy" },
        manualClosePaused: true,
      }),
      onResume,
    });

    expect(container.querySelector('[data-automation-state="paused_tab_closed"]')).not.toBeNull();
    expect(container.textContent).toContain("Paused — tab closed");
    expect(container.textContent).toContain("You closed the farming tab");
    const resume = container.querySelector<HTMLButtonElement>('[data-resume-action="kick"]');
    expect(resume).not.toBeNull();
    expect(resume?.textContent).toContain("Resume farming");
    act(() => resume?.click());
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("explains a Kick browser-profile block without offering sign-in", () => {
    const { container } = mountHeader({
      platform: "kick",
      presentation: presentation("kick", { status: "blocked", reasonCode: "security_policy_blocked" }),
    });

    expect(container.querySelector('[data-automation-state="blocked"]')).not.toBeNull();
    expect(container.textContent).toContain("Kick rejected this browser profile");
    expect(container.querySelector("[data-auth-action]")).toBeNull();
  });

  it("shows localized eligibility status instead of internal scheduler detail", () => {
    const internalMessage = "Keeping already committed snapshot selection";
    const { container } = mountHeader({
      platform: "twitch",
      presentation: automationPresentation({
        platform: "twitch",
        enabled: true,
        pending: false,
        authHealth: { status: "healthy" },
        session: {
          platform: "twitch",
          status: "idle",
          offlineChecks: 0,
          reasonCode: "keeping_current_watch",
          message: internalMessage,
        },
      }),
    });

    const status = container.querySelector('[data-automation-state="running"]');
    expect(status?.textContent).toContain("No eligible live stream is currently available for this campaign");
    expect(status?.textContent).not.toContain(internalMessage);
  });

  it("hides stale farming detail while authentication is degraded", () => {
    const { container } = mountHeader({
      platform: "kick",
      presentation: presentation("kick", { status: "unavailable" }),
      farmingTitle: "Stale campaign",
      farmingChannel: { name: "stale-channel" },
    });

    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("Stale campaign");
    expect(container.textContent).not.toContain("stale-channel");
  });

});

describe("manual watch status line", () => {
  const paused = {
    platform: "twitch" as const,
    enabled: true,
    pending: false,
    authHealth: { status: "healthy" } as PlatformAuthHealth,
    session: { platform: "twitch" as const, status: "paused" as const, offlineChecks: 0, reasonCode: "manual_watch" as const },
  };

  it("links the stream that paused farming", () => {
    const { container } = mount(
      <AutomationStatusLine
        platform="twitch"
        presentation={automationPresentation({
          ...paused,
          manualWatch: {
            platform: "twitch",
            tabId: 3,
            checkedAt: "2026-09-20T00:00:00.000Z",
            active: true,
            channel: { platform: "twitch", username: "summit1g", displayName: "Summit1G", url: "https://www.twitch.tv/summit1g" },
          },
        })}
      />,
    );

    const link = container.querySelector<HTMLAnchorElement>("[data-manual-watch-channel]");
    expect(link?.textContent).toBe("Summit1G");
    expect(link?.getAttribute("href")).toBe("https://www.twitch.tv/summit1g");
    expect(container.textContent).toContain("Manual watching");
  });

  it("keeps the unnamed explanation when no channel was recorded", () => {
    const { container } = mount(
      <AutomationStatusLine platform="twitch" presentation={automationPresentation(paused)} />,
    );

    expect(container.querySelector("[data-manual-watch-channel]")).toBeNull();
    expect(container.textContent).toContain("Farming is paused while you're watching a stream yourself.");
  });
});
