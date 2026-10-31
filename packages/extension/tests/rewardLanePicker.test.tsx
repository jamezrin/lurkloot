import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext, PopupRuntimeContext, RewardLaneContext } from "../../popup-ui/src/context";
import { QueuePanel } from "../../popup-ui/src/queue";
import type { PopupAdapter } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";

// The popup's side of Twitch reward campaigns (#904): the lane picker, and the
// day count on a reward earned once per window.

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const idleSession: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };

function laneReward(id: string, lane: string, patch: Partial<DropReward> = {}): DropReward {
  return {
    id,
    name: id,
    requiredMinutes: 20,
    watchedMinutes: 5,
    requirement: "watch",
    isWatchBased: true,
    status: "in_progress",
    repeat: { grantCount: 1, times: 3 },
    lane: { track: "pokemon#t", lane },
    preconditionsMet: true,
    ...patch,
  };
}

const campaign: DropCampaign = {
  id: "evolutions",
  platform: "twitch",
  name: "Pokemon Evolutions",
  brand: "Pokemon",
  categories: [{ id: "490655", name: "Pokémon GO" }],
  sitewide: true,
  status: "active",
  eligibility: "eligible",
  accountLinked: true,
  endsAt: "2027-01-30T22:59:59.999Z",
  rewards: [
    laneReward("Haunter", "gastly"),
    laneReward("Ivysaur", "bulbasaur", { requirement: "action", isWatchBased: false }),
  ],
  laneChoices: [
    {
      track: "pokemon#t",
      lanes: [
        { lane: "gastly", name: "Haunter", equipped: true },
        { lane: "bulbasaur", name: "Ivysaur", equipped: false },
      ],
    },
  ],
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(selectLane: ((campaignId: string, track: string, lane: string) => void) | null) {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const settings = mergeSettings(undefined);
  const view = campaignViewFromCampaign(campaign, 0, idleSession, false, {
    skipUnfinishableRewards: settings.skipUnfinishableRewards,
    deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
    settings,
    now: NOW,
  });
  const container = document.getElementById("app")!;
  const adapter = { openLink: vi.fn() } as unknown as PopupAdapter;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider
        value={{
          t: (key, substitutions) =>
            [
              key,
              ...(Array.isArray(substitutions)
                ? substitutions
                : substitutions
                  ? [substitutions]
                  : []),
            ].join(":"),
          dir: "ltr",
          locale: "en",
        }}
      >
        <PopupRuntimeContext.Provider value={{ adapter, preview: false }}>
          <RewardLaneContext.Provider value={selectLane}>
            <QueuePanel
              campaigns={[view]}
              gameMap={{}}
              refreshing={false}
              strategy="ending_soonest"
              pinnedCount={0}
              unlinkedCampaigns="include"
              platform="twitch"
              rewardFilter={defaultRewardFilter("twitch")}
              showSubscriptionChoice={false}
              onRewardFilterChange={() => undefined}
              onStrategyChange={() => undefined}
              onUnpinAll={() => undefined}
              onUnlinkedCampaignsChange={() => undefined}
              onRefreshCampaign={() => undefined}
              onPinChange={() => undefined}
              onToggleExclude={() => undefined}
              onOpenGames={() => undefined}
              onOpenSettings={() => undefined}
            />
          </RewardLaneContext.Provider>
        </PopupRuntimeContext.Provider>
      </I18nContext.Provider>,
    );
  });
  act(() => container.querySelector<HTMLButtonElement>("article button[aria-expanded]")?.click());
  return container;
}

describe("reward lane picker (#904)", () => {
  it("equips the lane the user picks and marks the equipped one", () => {
    const selectLane = vi.fn();
    const container = mount(selectLane);

    const equipped = container.querySelector<HTMLButtonElement>('[data-lane="gastly"]');
    expect(equipped?.getAttribute("aria-pressed")).toBe("true");
    expect(equipped?.disabled).toBe(true);

    act(() => container.querySelector<HTMLButtonElement>('[data-lane="bulbasaur"]')?.click());
    expect(selectLane).toHaveBeenCalledWith("evolutions", "pokemon#t", "bulbasaur");
  });

  it("names the day of a reward earned once per window and the lane left unequipped", () => {
    const container = mount(vi.fn());
    expect(container.querySelector("[data-reward-window]")?.textContent).toContain(
      "rewardRepeatProgress:2:3",
    );
    expect(container.textContent).toContain("rewardLaneNotEquipped");
  });

  it("shows no picker without a lane handler", () => {
    const container = mount(null);
    expect(container.querySelector("[data-lane-picker]")).toBeNull();
  });
});
