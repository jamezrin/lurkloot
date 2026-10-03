import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, DropReward, ExtensionSettings, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext, SubscriptionMarkContext } from "../../popup-ui/src/context";
import { QueuePanel } from "../../popup-ui/src/queue";
import { CompletedPanel } from "../../popup-ui/src/completed";
import type { CampaignView, PopupAdapter } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";

const idleSession: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };

function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: "campaign", platform: "twitch", name: "Sub campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

function settingsWithMarks(marks: string[]): ExtensionSettings {
  const settings = mergeSettings(undefined);
  settings.platform.twitch.subscribedRewardMarks = marks;
  return settings;
}

function view(campaign: DropCampaign, marks: string[] = []): CampaignView {
  const settings = settingsWithMarks(marks);
  return campaignViewFromCampaign(campaign, 0, idleSession, false, {
    skipUnfinishableRewards: settings.skipUnfinishableRewards,
    deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
    settings,
  });
}

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(element: (body: React.ReactElement) => React.ReactElement, body: React.ReactElement) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t: (key) => key, dir: "ltr", locale: "en" }}>
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          {element(body)}
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });
  return container;
}

function queue(campaigns: CampaignView[]): React.ReactElement {
  return (
    <QueuePanel
      campaigns={campaigns}
      gameMap={{}}
      refreshing={false}
      strategy="ending_soonest"
      pinnedCount={0}
      farmPinnedOnly={false}
      onStrategyChange={() => undefined}
      onUnpinAll={() => undefined}
      onFarmPinnedOnlyChange={() => undefined}
      onRefreshCampaign={() => undefined}
      onPinChange={() => undefined}
      onToggleExclude={() => undefined}
      onOpenGames={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
}

function expandFirstCard(container: HTMLElement): void {
  act(() => container.querySelector<HTMLButtonElement>("article button[aria-expanded]")?.click());
}

describe("subscription mark view model", () => {
  it("applies the settings' marks before building the view", () => {
    const [reward] = view(twitchCampaign([subscriptionReward()]), ["campaign:sub"]).rewards;

    expect(reward).toMatchObject({ subscriptionMarked: true, canMarkSubscription: true, obtained: true, requirement: "subscription" });
  });

  it("shows a marked subscription plus watch reward as a watch reward that keeps its mark", () => {
    const [reward] = view(twitchCampaign([subscriptionReward({ id: "combined", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" })]), ["campaign:combined"]).rewards;

    expect(reward).toMatchObject({ requirement: "watch", subscriptionMarked: true, obtained: false, progress: 50 });
  });
});

describe("subscription mark control", () => {
  it("offers Mark as subscribed and reports the reward it marks", () => {
    const toggle = vi.fn();
    const container = mount(
      (body) => <SubscriptionMarkContext.Provider value={toggle}>{body}</SubscriptionMarkContext.Provider>,
      queue([view(twitchCampaign([subscriptionReward()]))]),
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-queue-disclosure="action-required"]')?.click());
    expandFirstCard(container);

    act(() => container.querySelector<HTMLButtonElement>("[data-subscription-mark]")?.click());

    expect(toggle).toHaveBeenCalledWith("campaign", "sub");
  });

  it("shows no control without a mark handler", () => {
    const container = mount((body) => body, queue([view(twitchCampaign([subscriptionReward()]))]));
    act(() => container.querySelector<HTMLButtonElement>('[data-queue-disclosure="action-required"]')?.click());
    expandFirstCard(container);

    expect(container.querySelector("[data-subscription-mark]")).toBeNull();
  });

  it("keeps Undo reachable for a fully marked campaign in Completed", () => {
    const toggle = vi.fn();
    const container = mount(
      (body) => <SubscriptionMarkContext.Provider value={toggle}>{body}</SubscriptionMarkContext.Provider>,
      <CompletedPanel campaigns={[view(twitchCampaign([subscriptionReward()]), ["campaign:sub"])]} gameMap={{}} refreshing={false} onRefreshCampaign={() => undefined} />,
    );
    expandFirstCard(container);

    expect(container.querySelector("[data-subscription-marked]")?.textContent).toContain("subscriptionMarkedSubscribed");
    act(() => container.querySelector<HTMLButtonElement>("[data-subscription-mark-undo]")?.click());
    expect(toggle).toHaveBeenCalledWith("campaign", "sub");
  });
});
