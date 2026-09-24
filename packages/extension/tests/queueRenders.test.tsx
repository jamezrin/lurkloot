import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { rankCampaigns } from "@lurkloot/shared/ranking";
import { I18nContext } from "../../popup-ui/src/context";
import type { CampaignView, TFunction } from "../../popup-ui/src/types";
import { campaignViewFromCampaign, reuseUnchangedViews } from "../../popup-ui/src/viewModels";

// Count how often each campaign's card renders. Both entry points are wrapped:
// queued rows render through SortableCampaign, the rest through CampaignCard.
const renders = new Map<string, number>();
vi.mock("../../popup-ui/src/drops", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../popup-ui/src/drops")>();
  const count = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
  return {
    ...original,
    CampaignCard: (props: Parameters<typeof original.CampaignCard>[0]) => { count(props.campaign.id); return original.CampaignCard(props); },
    SortableCampaign: (props: Parameters<typeof original.SortableCampaign>[0]) => { count(props.campaign.id); return original.SortableCampaign(props); },
  };
});
const { QueuePanel } = await import("../../popup-ui/src/queue");

const t: TFunction = (key) => key;
// One value for the life of the test, as the popup memoises its own.
const i18n = { t, dir: "ltr" as const, locale: "en" };
const idle: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  renders.clear();
  vi.unstubAllGlobals();
});

function source(id: string): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    gameName: id,
    rewards: [{ id: `${id}-r`, name: "Reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 5, status: "locked" }],
  } as DropCampaign;
}

const settings = mergeSettings(undefined);
// A fresh set of view objects, as every snapshot poll produces.
function freshViews(): CampaignView[] {
  return rankCampaigns(["a", "b", "c"].map(source), settings).map((campaign, index) => campaignViewFromCampaign(campaign, index, idle, false, {
    skipUnfinishableRewards: settings.skipUnfinishableRewards,
    deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
    settings,
  }));
}

function mount(campaigns: CampaignView[]): { container: HTMLElement; render(next: CampaignView[]): void } {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  const handlers = {
    onStrategyChange: () => undefined,
    onUnpinAll: () => undefined,
    onFarmPinnedOnlyChange: () => undefined,
    onRefreshCampaign: () => undefined,
    onPinChange: () => undefined,
    onToggleExclude: () => undefined,
    onOpenGames: () => undefined,
    onOpenSettings: () => undefined,
  };
  const render = (next: CampaignView[]) => root!.render(
    <I18nContext.Provider value={i18n}>
      {/* A new handlers object on every render, as the popup passes inline arrows. */}
      <QueuePanel campaigns={next} gameMap={{}} refreshing={false} strategy="ending_soonest" pinnedCount={0} farmPinnedOnly={false} {...{ ...handlers }} />
    </I18nContext.Provider>,
  );
  act(() => { root = createRoot(container); render(campaigns); });
  return { container, render: (next) => act(() => render(next)) };
}

describe("queue rendering", () => {
  it("keeps the previous view object for a campaign whose view did not change", () => {
    const previous = freshViews();
    const next = freshViews();
    next[1] = { ...next[1]!, title: "changed" };

    const shared = reuseUnchangedViews(previous, next);

    expect(shared[0]).toBe(previous[0]);
    expect(shared[1]).toBe(next[1]);
    expect(shared[2]).toBe(previous[2]);
    expect(reuseUnchangedViews(previous, freshViews())).toBe(previous);
  });

  it("re-renders no card when a poll brings the same campaigns", () => {
    const first = freshViews();
    const { render } = mount(first);
    renders.clear();

    render(reuseUnchangedViews(first, freshViews()));

    expect(Object.fromEntries(renders)).toEqual({});
  });

  it("re-renders only the card that was opened", () => {
    const { container } = mount(freshViews());
    renders.clear();

    act(() => container.querySelector<HTMLButtonElement>('[data-campaign-id="b"] button[aria-expanded]')!.click());

    expect([...renders.keys()]).toEqual(["b"]);
  });
});
