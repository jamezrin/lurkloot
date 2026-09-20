import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, ExtensionSettings, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { rankCampaigns } from "@lurkloot/shared/ranking";
import { I18nContext } from "../../popup-ui/src/context";
import { QueuePanel } from "../../popup-ui/src/queue";
import { CompletedPanel } from "../../popup-ui/src/completed";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";
import type { CampaignView, TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key, substitutions) => {
  const value = Array.isArray(substitutions) ? substitutions.join(", ") : substitutions;
  return value === undefined ? key : `${key}:${value}`;
};

const idleSession: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function campaign(id: string, patch: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    gameName: id,
    rewards: [{
      id: `${id}-reward`,
      name: `${id} reward`,
      requiredMinutes: 30,
      requirement: "watch",
      isWatchBased: true,
      watchedMinutes: 0,
      status: "locked",
    }],
    ...patch,
  } as DropCampaign;
}

function views(sources: DropCampaign[], settings: ExtensionSettings): CampaignView[] {
  return rankCampaigns(sources, settings).map((source, index) => campaignViewFromCampaign(
    source,
    index,
    idleSession,
    settings.excludedCampaignIds.includes(source.id),
    {
      skipUnfinishableRewards: settings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
      settings,
    },
  ));
}

function mount(node: React.ReactElement): { container: HTMLElement; window: Window & typeof globalThis } {
  const { document, window } = parseHTML("<div id=app></div>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", () => ({ direction: "ltr", columnGap: "0" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(<I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>{node}</I18nContext.Provider>);
  });
  return { container, window: window as unknown as Window & typeof globalThis };
}

function queue(campaigns: CampaignView[], settings: ExtensionSettings, overrides: Partial<React.ComponentProps<typeof QueuePanel>> = {}) {
  return mount(
    <QueuePanel
      campaigns={campaigns}
      gameMap={{}}
      refreshing={false}
      strategy={settings.priorityMode}
      pinnedCount={settings.campaignPins.length}
      farmPinnedOnly={settings.farmPinnedOnly}
      onStrategyChange={() => undefined}
      onUnpinAll={() => undefined}
      onFarmPinnedOnlyChange={() => undefined}
      onRefreshCampaign={() => undefined}
      onPinChange={() => undefined}
      onToggleExclude={() => undefined}
      onOpenGames={() => undefined}
      onOpenSettings={() => undefined}
      {...overrides}
    />,
  );
}

const groups = (container: Element): string[] =>
  [...container.querySelectorAll("[data-queue-group]")].map((node) => node.getAttribute("data-queue-group") ?? "");

function expand(container: Element, group: string): void {
  const disclosure = container.querySelector<HTMLButtonElement>(`[data-queue-disclosure="${group}"]`);
  if (!disclosure) throw new Error(`Missing disclosure: ${group}`);
  if (disclosure.getAttribute("aria-expanded") !== "true") act(() => disclosure.click());
}

const rows = (container: Element, group: string): string[] =>
  [...container.querySelectorAll(`[data-queue-group="${group}"] [data-campaign-id]`)]
    .map((node) => node.getAttribute("data-campaign-id") ?? "");

describe("queue view", () => {
  it("labels one group per ranking tier, and only the populated ones", () => {
    const settings = mergeSettings({
      campaignPins: ["pinned"],
      platform: { twitch: { favouriteCategories: [{ id: "starred", name: "starred" }] } },
    } as never);
    const { container } = queue(views([campaign("pinned"), campaign("starred"), campaign("ordinary")], settings), settings);

    expect(groups(container)).toEqual(["pinned", "favourite", "strategy"]);
    expect(rows(container, "pinned")).toEqual(["pinned"]);
    expect(rows(container, "favourite")).toEqual(["starred"]);
    expect(rows(container, "strategy")).toEqual(["ordinary"]);
  });

  it("drops a tier's divider when nothing is in it", () => {
    const settings = mergeSettings(undefined);
    const { container } = queue(views([campaign("one"), campaign("two")], settings), settings);

    expect(groups(container)).toEqual(["strategy"]);
  });

  it("numbers the rows with the rank the scheduler uses", () => {
    const settings = mergeSettings({ campaignPins: ["second"] } as never);
    const { container } = queue(views([campaign("first"), campaign("second")], settings), settings);

    const ranks = [...container.querySelectorAll("[data-campaign-rank]")]
      .map((node) => [node.getAttribute("data-campaign-id"), node.getAttribute("data-campaign-rank")]);
    expect(ranks).toEqual([["second", "1"], ["first", "2"]]);
  });

  it("groups skipped campaigns under the queue with their reason", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["hidden"] } as never);
    const { container } = queue(views([campaign("farmed"), campaign("hidden")], settings), settings);

    expect(groups(container)).toContain("skipped");
    expand(container, "skipped");
    expect(rows(container, "skipped")).toEqual(["hidden"]);
    expect(container.querySelector('[data-queue-group="skipped"]')?.textContent).toContain("campaignRejectionExcluded");
  });

  it("offers the one-click fix a skipped campaign needs", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["hidden"] } as never);
    const onToggleExclude = vi.fn();
    const { container } = queue(views([campaign("hidden")], settings), settings, { onToggleExclude });

    expand(container, "skipped");
    const fix = container.querySelector<HTMLButtonElement>('[data-campaign-id="hidden"] [data-queue-fix]');
    expect(fix).not.toBeNull();
    act(() => fix!.click());
    expect(onToggleExclude).toHaveBeenCalledWith("hidden");
  });

  it("keeps upcoming campaigns in their own group", () => {
    const settings = mergeSettings(undefined);
    const upcoming = campaign("later", { status: "upcoming" });
    const { container } = queue(views([campaign("now"), upcoming], settings), settings);

    expand(container, "upcoming");
    expect(rows(container, "upcoming")).toEqual(["later"]);
    expect(rows(container, "strategy")).toEqual(["now"]);
  });

  it("filters queue and skipped rows by campaign type", () => {
    const settings = mergeSettings({ farmingEligibility: { farmSubscriptionCampaigns: false } } as never);
    const badge = campaign("badge", {
      rewards: [{ id: "sub", name: "Sub badge", requiredMinutes: 0, requirement: "subscription", requiredSubs: 1, watchedMinutes: 0, status: "locked" }],
    });
    const { container } = queue(views([campaign("drop"), badge], settings), settings);

    const facet = container.querySelector<HTMLButtonElement>('[data-queue-facet="badges"]');
    expect(facet).not.toBeNull();
    act(() => facet!.click());

    // The badge campaign is skipped while that class is not farmed, and the
    // facet still finds it there rather than showing an empty list.
    expand(container, "skipped");
    expect(rows(container, "skipped")).toEqual(["badge"]);
    expect(rows(container, "strategy")).toEqual([]);
  });

  it("clears every pin from one control", () => {
    const settings = mergeSettings({ campaignPins: ["one", "two"] } as never);
    const onUnpinAll = vi.fn();
    const { container } = queue(views([campaign("one"), campaign("two")], settings), settings, { onUnpinAll });

    const unpin = container.querySelector<HTMLButtonElement>("[data-queue-unpin-all]");
    expect(unpin?.textContent).toContain("2");
    act(() => unpin!.click());
    expect(onUnpinAll).toHaveBeenCalledOnce();
  });

  it("hides the unpin control when nothing is pinned", () => {
    const settings = mergeSettings(undefined);
    const { container } = queue(views([campaign("one")], settings), settings);

    expect(container.querySelector("[data-queue-unpin-all]")).toBeNull();
  });

  it("names the live strategy the unpinned rows follow", () => {
    const settings = mergeSettings({ priorityMode: "lowest_availability" } as never);
    const onStrategyChange = vi.fn();
    const { container } = queue(views([campaign("one")], settings), settings, { onStrategyChange });

    const strategy = container.querySelector<HTMLSelectElement>("[data-queue-strategy]");
    expect(strategy?.value).toBe("lowest_availability");
  });
});

describe("completed view", () => {
  function completed(campaigns: CampaignView[], overrides: Partial<React.ComponentProps<typeof CompletedPanel>> = {}) {
    return mount(
      <CompletedPanel
        campaigns={campaigns}
        gameMap={{}}
        refreshing={false}
        onRefreshCampaign={() => undefined}
        {...overrides}
      />,
    );
  }

  const finishedCampaign = campaign("done", {
    rewards: [{ id: "done-reward", name: "Done reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 30, status: "claimed" }],
  });
  const expiredCampaign = campaign("gone", { status: "expired" });

  it("separates finished campaigns from expired ones", () => {
    const settings = mergeSettings(undefined);
    const { container } = completed(views([finishedCampaign, expiredCampaign], settings));

    expect(rows(container, "finished")).toEqual(["done"]);
    expect(container.querySelector('[data-queue-group="expired"]')).toBeNull();

    const expiredTab = container.querySelector<HTMLButtonElement>('[data-completed-tab="expired"]');
    act(() => expiredTab!.click());
    expect(rows(container, "expired")).toEqual(["gone"]);
  });

  it("shows one terminal state per row, with no rank, drag handle or progress", () => {
    const settings = mergeSettings(undefined);
    const { container } = completed(views([finishedCampaign], settings));

    const row = container.querySelector('[data-campaign-id="done"]')!;
    expect(row.textContent).toContain("finished");
    expect(row.textContent).not.toContain("later");
    expect(row.querySelector("[data-campaign-rank]")).toBeNull();
    expect(row.querySelector("button[aria-label^='reorderItem']")).toBeNull();
    expect(row.querySelector("[data-farming-rejection-indicator]")).toBeNull();
  });
});
