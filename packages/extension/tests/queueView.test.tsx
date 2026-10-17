// @vitest-environment happy-dom
// The card's Exclude menu is a Base UI menu, which needs real mouse and
// keyboard events; linkedom has none.
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DropCampaign,
  ExtensionSettings,
  RewardFilter,
  WatchSession,
} from "@lurkloot/shared/models";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { mergeSettings } from "@lurkloot/shared/settings";
import { rankCampaigns } from "@lurkloot/shared/ranking";
import { I18nContext } from "../../popup-ui/src/context";
import { QueuePanel } from "../../popup-ui/src/queue";
import { CompletedPanel } from "../../popup-ui/src/completed";
import { campaignViewFromCampaign, showsSubscriptionChoice } from "../../popup-ui/src/viewModels";
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
    rewards: [
      {
        id: `${id}-reward`,
        name: `${id} reward`,
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 0,
        status: "locked",
      },
    ],
    ...patch,
  } as DropCampaign;
}

function views(sources: DropCampaign[], settings: ExtensionSettings): CampaignView[] {
  return rankCampaigns(sources, settings).map((source, index) =>
    campaignViewFromCampaign(
      source,
      index,
      idleSession,
      settings.excludedCampaignIds.includes(source.id),
      {
        skipUnfinishableRewards: settings.skipUnfinishableRewards,
        deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
        settings,
      },
    ),
  );
}

function mount(node: React.ReactElement): {
  container: HTMLElement;
  window: Window & typeof globalThis;
} {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>{node}</I18nContext.Provider>,
    );
  });
  return { container, window: window as unknown as Window & typeof globalThis };
}

function queue(
  campaigns: CampaignView[],
  settings: ExtensionSettings,
  overrides: Partial<React.ComponentProps<typeof QueuePanel>> = {},
) {
  return mount(
    <QueuePanel
      campaigns={campaigns}
      gameMap={{}}
      refreshing={false}
      strategy={settings.priorityMode}
      pinnedCount={settings.campaignPins.length}
      farmPinnedOnly={settings.platform.twitch.farmPinnedOnly}
      platform="twitch"
      rewardFilter={settings.platform.twitch.rewardFilter}
      showSubscriptionChoice
      onRewardFilterChange={() => undefined}
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
  [...container.querySelectorAll("[data-queue-group]")].map(
    (node) => node.getAttribute("data-queue-group") ?? "",
  );

function expand(container: Element, group: string): void {
  const disclosure = container.querySelector<HTMLButtonElement>(
    `[data-queue-disclosure="${group}"]`,
  );
  if (!disclosure) throw new Error(`Missing disclosure: ${group}`);
  if (disclosure.getAttribute("aria-expanded") !== "true") act(() => disclosure.click());
}

function openCard(container: Element, id: string): Element {
  const card = container.querySelector(`[data-campaign-id="${id}"]`);
  const toggle = card?.querySelector<HTMLButtonElement>(
    `button[aria-expanded][aria-label="${id}"]`,
  );
  if (!card || !toggle) throw new Error(`Missing card: ${id}`);
  if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
  return card;
}

const rows = (container: Element, group: string): string[] =>
  [...container.querySelectorAll(`[data-queue-group="${group}"] [data-campaign-id]`)].map(
    (node) => node.getAttribute("data-campaign-id") ?? "",
  );

describe("queue view", () => {
  it("labels one group per ranking tier, and only the populated ones", () => {
    const settings = mergeSettings({
      campaignPins: ["pinned"],
      platform: { twitch: { favouriteCategories: [{ id: "starred", name: "starred" }] } },
    } as never);
    const { container } = queue(
      views([campaign("pinned"), campaign("starred"), campaign("ordinary")], settings),
      settings,
    );

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

    const ranks = [...container.querySelectorAll("[data-campaign-rank]")].map((node) => [
      node.getAttribute("data-campaign-id"),
      node.getAttribute("data-campaign-rank"),
    ]);
    expect(ranks).toEqual([
      ["second", "1"],
      ["first", "2"],
    ]);
  });

  it("groups skipped campaigns under the queue with their reason", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["hidden"] } as never);
    const { container } = queue(
      views([campaign("farmed"), campaign("hidden")], settings),
      settings,
    );

    expect(groups(container)).toContain("skipped");
    expand(container, "skipped");
    expect(rows(container, "skipped")).toEqual(["hidden"]);
    expect(container.querySelector('[data-queue-group="skipped"]')?.textContent).toContain(
      "campaignRejectionExcluded",
    );
  });

  it("offers the one-click fix a skipped campaign needs", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["hidden"] } as never);
    const onToggleExclude = vi.fn();
    const { container } = queue(views([campaign("hidden")], settings), settings, {
      onToggleExclude,
    });

    expand(container, "skipped");
    const fix = container.querySelector<HTMLButtonElement>(
      '[data-campaign-id="hidden"] [data-queue-fix]',
    );
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

  it("skips a campaign with no reward the filter allows, with a fix that farms every reward", () => {
    const settings = mergeSettings({
      platform: { twitch: { rewardFilter: { kinds: ["badge"], subscriptions: "include" } } },
    } as never);
    const badge = campaign("badge", {
      rewards: [
        {
          id: "badge-reward",
          name: "Badge",
          benefits: [{ id: "b", distributionType: "BADGE" }],
          requiredMinutes: 30,
          requirement: "watch",
          isWatchBased: true,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    });
    const onRewardFilterChange = vi.fn();
    const { container } = queue(views([campaign("drop"), badge], settings), settings, {
      onRewardFilterChange,
    });

    expect(rows(container, "strategy")).toEqual(["badge"]);
    expand(container, "skipped");
    expect(rows(container, "skipped")).toEqual(["drop"]);
    const fix = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-campaign-id="drop"] button'),
    ].find((button) => button.textContent === "queueFixFarmAll");
    expect(fix).toBeDefined();
    act(() => fix!.click());
    expect(onRewardFilterChange).toHaveBeenCalledWith(defaultRewardFilter("twitch"));
  });

  // The menu is portalled out of the panel, so its parts are looked up on the
  // document.
  const settle = (action: () => void) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const openFilter = (container: Element) =>
    settle(() => container.querySelector<HTMLButtonElement>("[data-reward-filter]")!.click());

  // Holds the filter the way the popup does: each change is saved and comes
  // back as the new prop.
  function FilterHarness({
    sources,
    initial,
    onRewardFilterChange,
  }: {
    sources: DropCampaign[];
    initial: RewardFilter;
    onRewardFilterChange(filter: RewardFilter): void;
  }): React.ReactElement {
    const [filter, setFilter] = React.useState(initial);
    const settings = mergeSettings({ platform: { twitch: { rewardFilter: filter } } } as never);
    return (
      <QueuePanel
        campaigns={views(sources, settings)}
        gameMap={{}}
        refreshing={false}
        strategy={settings.priorityMode}
        pinnedCount={0}
        farmPinnedOnly={false}
        platform="twitch"
        rewardFilter={filter}
        showSubscriptionChoice={showsSubscriptionChoice(sources, filter)}
        onRewardFilterChange={(next) => {
          onRewardFilterChange(next);
          setFilter(next);
        }}
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

  it("opens the reward filter from the toolbar and saves both questions", async () => {
    const subscription = campaign("sub", {
      rewards: [
        {
          id: "sub-reward",
          name: "Sub reward",
          requiredSubs: 1,
          requiredMinutes: 0,
          requirement: "subscription",
          isWatchBased: false,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    } as Partial<DropCampaign>);
    const onRewardFilterChange = vi.fn();
    const { container } = mount(
      <FilterHarness
        sources={[campaign("drop"), subscription]}
        initial={defaultRewardFilter("twitch")}
        onRewardFilterChange={onRewardFilterChange}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>("[data-reward-filter]")!;
    expect(trigger.textContent).toContain("rewardFilterAll");
    expect(trigger.hasAttribute("data-narrowed")).toBe(false);
    await openFilter(container);

    await settle(() => document.querySelector<HTMLElement>('[data-reward-kind="item"]')!.click());
    expect(onRewardFilterChange).toHaveBeenLastCalledWith({
      kinds: ["badge", "emote"],
      subscriptions: "include",
    });

    await settle(() =>
      document.querySelector<HTMLElement>('[data-subscription-option="skip"]')!.click(),
    );
    expect(onRewardFilterChange).toHaveBeenLastCalledWith({
      kinds: ["badge", "emote"],
      subscriptions: "skip",
    });
    expect(trigger.hasAttribute("data-narrowed")).toBe(true);
    expect(trigger.textContent).toContain("rewardFilterNoSub");

    // Reset appears once narrowed, and restores every reward.
    await settle(() => document.querySelector<HTMLElement>("[data-reward-filter-reset]")!.click());
    expect(onRewardFilterChange).toHaveBeenLastCalledWith(defaultRewardFilter("twitch"));
  });

  it("closes the reward filter on Escape", async () => {
    const { container } = mount(
      <FilterHarness
        sources={[campaign("drop")]}
        initial={defaultRewardFilter("twitch")}
        onRewardFilterChange={() => undefined}
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-reward-filter]")!;
    await openFilter(container);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await settle(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the subscription choice on a platform without subscription rewards only while it is narrowed", async () => {
    const kick = [campaign("k", { platform: "kick" })];
    const kickQueue = (filter: RewardFilter) => {
      const settings = mergeSettings({ platform: { kick: { rewardFilter: filter } } } as never);
      return queue(views(kick, settings), settings, {
        platform: "kick",
        rewardFilter: filter,
        showSubscriptionChoice: showsSubscriptionChoice(kick, filter),
      });
    };

    const plain = kickQueue({ kinds: ["item"], subscriptions: "include" });
    await openFilter(plain.container);
    expect(document.querySelector("[data-reward-kind]")).toBeNull();
    expect(document.querySelector("[data-subscription-mode]")).toBeNull();
    act(() => root?.unmount());
    root = undefined;

    const narrowed = kickQueue({ kinds: ["item"], subscriptions: "only" });
    await openFilter(narrowed.container);
    expect(document.querySelectorAll("[data-subscription-mode]")).toHaveLength(1);
  });

  it("moves farm pinned only into the menu", async () => {
    const settings = mergeSettings(undefined);
    const onFarmPinnedOnlyChange = vi.fn();
    const { container } = queue(views([campaign("drop")], settings), settings, {
      onFarmPinnedOnlyChange,
    });

    expect(container.querySelector("[data-queue-pinned-only]")).toBeNull();
    await openFilter(container);
    const pinnedOnly = document.querySelector<HTMLElement>("[data-queue-pinned-only]");
    expect(pinnedOnly).not.toBeNull();
    expect(container.contains(pinnedOnly)).toBe(false);
    await settle(() => pinnedOnly!.click());
    expect(onFarmPinnedOnlyChange).toHaveBeenCalledWith(true);
  });

  it("opens the platform's reward settings from an unlinked campaign's fix", () => {
    const settings = mergeSettings({
      platform: { twitch: { farmUnlinkedCampaigns: false } },
    } as never);
    const unlinked = campaign("unlinked", { accountLinked: false } as Partial<DropCampaign>);
    const onOpenSettings = vi.fn();
    const { container } = queue(views([campaign("drop"), unlinked], settings), settings, {
      onOpenSettings,
    });

    expand(container, "skipped");
    const fix = container.querySelector<HTMLButtonElement>(
      '[data-campaign-id="unlinked"] [data-queue-fix]',
    );
    expect(fix?.textContent).toBe("queueFixSettings");
    act(() => fix!.click());
    expect(onOpenSettings).toHaveBeenCalledWith("twitch.rewards");
  });

  it("lists a campaign only an outside action can unblock under Action required, apart from Skipped (#677)", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["excluded"] } as never);
    const subscriptionReward = {
      id: "sub",
      name: "Sub badge",
      requiredMinutes: 0,
      requirement: "subscription" as const,
      requiredSubs: 1,
      watchedMinutes: 0,
      status: "locked" as const,
    };
    const { container } = queue(
      views(
        [campaign("excluded"), campaign("needs-sub", { rewards: [subscriptionReward] })],
        settings,
      ),
      settings,
    );

    expand(container, "skipped");
    expand(container, "action-required");
    expect(rows(container, "skipped")).toEqual(["excluded"]);
    expect(rows(container, "action-required")).toEqual(["needs-sub"]);
  });

  it("says what will still block a skipped campaign once its fix is applied (#677)", () => {
    const settings = mergeSettings({ excludedCampaignIds: ["both"] } as never);
    const subscriptionReward = {
      id: "sub",
      name: "Sub badge",
      requiredMinutes: 0,
      requirement: "subscription" as const,
      requiredSubs: 1,
      watchedMinutes: 0,
      status: "locked" as const,
    };
    const { container } = queue(
      views([campaign("both", { rewards: [subscriptionReward] })], settings),
      settings,
    );

    // Excluded by the user's own choice, so it stays in Skipped, and says the
    // subscription is what comes after including it.
    expand(container, "skipped");
    const card = openCard(container, "both");
    expect(card.querySelector("[data-campaign-next-blocker]")?.textContent).toContain(
      "campaignRejectionThen",
    );
  });

  it("clears every pin from one control", () => {
    const settings = mergeSettings({ campaignPins: ["one", "two"] } as never);
    const onUnpinAll = vi.fn();
    const { container } = queue(views([campaign("one"), campaign("two")], settings), settings, {
      onUnpinAll,
    });

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

    const strategy = container.querySelector<HTMLButtonElement>("[data-queue-strategy]");
    expect(strategy?.dataset.value).toBe("lowest_availability");
  });
});

function search(container: Element, value: string): void {
  const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
  input.value = value;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (
        input as unknown as Record<string, { onChange?(event: { target: HTMLInputElement }): void }>
      )[propsKey]
    : undefined;
  act(() => props?.onChange?.({ target: input }));
}

describe("campaign status pill", () => {
  const status = (container: Element, id: string) =>
    container.querySelector(`[data-campaign-id="${id}"] [data-campaign-status]`)?.textContent
    ?? null;

  it("shows the time left only when the campaign has an end", () => {
    const settings = mergeSettings(undefined);
    const inTwoDays = new Date(Date.now() + 50 * 3_600_000).toISOString();
    const { container } = queue(
      views([campaign("dated", { endsAt: inTwoDays }), campaign("undated")], settings),
      settings,
    );

    expect(status(container, "dated")).toMatch(/^endsIn:2d/);
    // No end date is not "later left": the row simply carries no deadline.
    expect(status(container, "undated")).toBeNull();
    expect(container.querySelector('[data-campaign-id="undated"]')?.textContent).not.toContain(
      "later",
    );
  });

  it("says a campaign has ended once its end has passed, before it is marked expired", () => {
    const settings = mergeSettings(undefined);
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const passed = campaignViewFromCampaign(
      campaign("passed", { endsAt: anHourAgo }),
      0,
      idleSession,
      false,
    );
    const { container } = queue([{ ...passed, section: "queue", lifecycle: undefined }], settings);

    expect(status(container, "passed")).toBe("ended");
  });

  it("shows the watching left next to the end, and marks what the end cuts off", () => {
    const settings = mergeSettings(undefined);
    const inAnHour = new Date(Date.now() + 60 * 60_000 + 30_000).toISOString();
    const rewards = [
      {
        id: "short",
        name: "short",
        requiredMinutes: 30,
        requirement: "watch" as const,
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed" as const,
      },
      {
        id: "long",
        name: "long",
        requiredMinutes: 180,
        requirement: "watch" as const,
        isWatchBased: true,
        watchedMinutes: 30,
        status: "in_progress" as const,
      },
    ];
    const tight = campaignViewFromCampaign(
      campaign("tight", { endsAt: inAnHour, rewards }),
      0,
      idleSession,
      false,
    );
    const roomy = campaignViewFromCampaign(
      campaign("roomy", { endsAt: new Date(Date.now() + 50 * 3_600_000).toISOString(), rewards }),
      1,
      idleSession,
      false,
    );
    const { container } = queue(
      [
        { ...tight, section: "queue" },
        { ...roomy, section: "queue" },
      ],
      settings,
    );
    const row = (id: string) => container.querySelector(`[data-campaign-id="${id}"]`)!;

    // 150 of 180 minutes still to watch, whatever the end.
    expect(row("tight").querySelector("[data-campaign-watch-left]")?.textContent).toBe(
      "watchToGo:2h 30m",
    );
    expect(row("roomy").querySelector("[data-campaign-watch-left]")?.textContent).toBe(
      "watchToGo:2h 30m",
    );
    // An hour left reaches minute 90 of 180: the long reward is cut off.
    const cut = row("tight").querySelector<HTMLElement>("[data-campaign-out-of-time]");
    expect(cut?.style.insetInlineStart).toMatch(/^50\./);
    expect(row("tight").querySelector('[data-reward-marker="out-of-time"]')).not.toBeNull();
    expect(row("roomy").querySelector("[data-campaign-out-of-time]")).toBeNull();
  });

  it("labels an expired campaign found by search as expired, with nothing to act on", () => {
    const settings = mergeSettings(undefined);
    const { container } = queue(
      views([campaign("live"), campaign("gone", { status: "expired" })], settings),
      settings,
    );

    search(container, "gone");
    const row = container.querySelector('[data-campaign-id="gone"]')!;
    expect(status(container, "gone")).toBe("expiredPill");
    expect(row.querySelector("[data-queue-pin]")).toBeNull();
    expect(row.querySelector("button[aria-label^='Set rank']")).toBeNull();
  });
});

describe("campaign card actions", () => {
  it("opens and closes a campaign from its chevron, which says what it does", () => {
    const settings = mergeSettings(undefined);
    const { container } = queue(views([campaign("one")], settings), settings);
    const toggle = () =>
      container.querySelector('[data-campaign-id="one"] button[aria-expanded][aria-label="one"]');
    const chevron = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-campaign-id="one"] [data-campaign-chevron]',
      )!;

    expect(chevron().getAttribute("title")).toBe("campaignShowDetails");
    act(() => chevron().click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(chevron().getAttribute("title")).toBe("campaignHideDetails");
    act(() => chevron().click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("lets only the pins be dragged or given a rank", () => {
    const settings = mergeSettings({ campaignPins: ["pinned"] } as never);
    const { container } = queue(
      views([campaign("pinned"), campaign("ordinary")], settings),
      settings,
    );
    const row = (id: string) => container.querySelector(`[data-campaign-id="${id}"]`)!;

    // The pins are one sortable list; everything below orders itself.
    expect(row("pinned").querySelector('[aria-label^="reorderItem"]')).not.toBeNull();
    expect(row("pinned").querySelector('button[aria-label^="Set rank of"]')).not.toBeNull();
    expect(row("ordinary").querySelector('[aria-label^="reorderItem"]')).toBeNull();
    expect(row("ordinary").querySelector('button[aria-label^="Set rank of"]')).toBeNull();
    expect(row("ordinary").getAttribute("data-campaign-rank")).toBe("2");
  });

  it("places a searched pin by its real rank while the reward filter skips other pins", () => {
    const settings = mergeSettings({
      campaignPins: ["badge", "d1", "d2"],
      platform: { twitch: { rewardFilter: { kinds: ["item"], subscriptions: "skip" } } },
    } as never);
    const badge = campaign("badge", {
      rewards: [
        {
          id: "sub",
          name: "Sub badge",
          requiredMinutes: 0,
          requirement: "subscription",
          requiredSubs: 1,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    });
    const onPinChange = vi.fn();
    const { container } = queue(
      views([badge, campaign("d1"), campaign("d2")], settings),
      settings,
      { onPinChange },
    );
    search(container, "d2");

    const rank = container.querySelector<HTMLButtonElement>(
      '[data-campaign-id="d2"] button[aria-label="Set rank of d2"]',
    )!;
    // Its real place among all three pins, not its place among the two shown.
    expect(rank.textContent).toBe("3");
    act(() => rank.click());
    const input = container.querySelector<HTMLInputElement>('[data-campaign-id="d2"] input')!;
    const props = (element: Element) =>
      (
        element as unknown as Record<
          string,
          {
            onChange?(event: { target: HTMLInputElement; currentTarget: HTMLInputElement }): void;
            onBlur?(): void;
          }
        >
      )[Object.keys(element).find((key) => key.startsWith("__reactProps$"))!]!;
    act(() => {
      input.value = "1";
      props(input).onChange?.({ target: input, currentTarget: input });
    });
    act(() => props(input).onBlur?.());

    expect(onPinChange).toHaveBeenCalledWith("d2", 0);
  });

  it("keeps a skipped campaign's fix when search finds it", () => {
    // With "farm pinned only" on, an unpinned campaign is skipped and its fix
    // is pinning it; search used to show it with no way to do that.
    const settings = mergeSettings({
      campaignPins: ["pinned"],
      platform: { twitch: { farmPinnedOnly: true } },
    } as never);
    const { container } = queue(views([campaign("pinned"), campaign("loose")], settings), settings);

    search(container, "loose");

    expect(container.querySelector('[data-campaign-id="loose"] [data-queue-fix]')).not.toBeNull();
  });

  it("pins a queued campaign from its own row", () => {
    const settings = mergeSettings({ campaignPins: ["pinned"] } as never);
    const onPinChange = vi.fn();
    const { container } = queue(
      views([campaign("pinned"), campaign("ordinary")], settings),
      settings,
      { onPinChange },
    );

    const pin = container.querySelector<HTMLButtonElement>(
      '[data-campaign-id="ordinary"] [data-queue-pin]',
    );
    expect(pin?.getAttribute("aria-pressed")).toBe("false");
    act(() => pin!.click());
    // A new pin goes after the existing ones, so pinning never reorders them.
    expect(onPinChange).toHaveBeenCalledWith("ordinary", 1);
  });

  it("says which layer of the ranking placed each row", () => {
    const settings = mergeSettings({
      campaignPins: ["pinned"],
      platform: { twitch: { favouriteCategories: [{ id: "starred", name: "Starred" }] } },
    } as never);
    const { container } = queue(
      views([campaign("pinned"), campaign("starred"), campaign("ordinary")], settings),
      settings,
    );

    expect(openCard(container, "pinned").textContent).toContain("rankReasonPinned:1");
    expect(openCard(container, "starred").textContent).toContain("rankReasonFavourite:starred, 1");
    expect(openCard(container, "ordinary").textContent).toContain("rankReasonEnding");
  });

  it("asks whether Exclude means this campaign or its whole game", async () => {
    const settings = mergeSettings(undefined);
    const onToggleExclude = vi.fn();
    const onToggleBlockedCategory = vi.fn();
    const { container } = queue(
      views([campaign("rust", { categoryId: "263490", gameName: "Rust" })], settings),
      settings,
      { onToggleExclude, onToggleBlockedCategory },
    );
    // The menu is portalled out of the card, so it is looked up on the document.
    const menu = () => document.querySelector("[data-campaign-exclude-menu]");
    const choices = () => [...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
    const settle = (action: () => void) =>
      act(async () => {
        action();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    const card = openCard(container, "rust");
    const exclude = card.querySelector<HTMLButtonElement>("[data-campaign-exclude]")!;
    expect(exclude.getAttribute("aria-haspopup")).toBe("menu");
    expect(menu()).toBeNull();

    await settle(() => exclude.click());
    expect(choices().map((choice) => choice.textContent)).toEqual([
      expect.stringContaining("campaignExcludeThis"),
      expect.stringContaining("campaignExcludeCategory:Rust"),
    ]);

    await settle(() => choices()[0]!.click());
    expect(onToggleExclude).toHaveBeenCalledWith("rust");
    // Choosing closes the menu rather than leaving a stale choice open.
    expect(exclude.getAttribute("aria-expanded")).toBe("false");

    await settle(() => exclude.click());
    await settle(() => choices()[1]!.click());
    expect(onToggleBlockedCategory).toHaveBeenCalledWith({ id: "263490", name: "Rust" });
  });

  it("falls back to a plain Exclude toggle when there is no game to block", () => {
    const settings = mergeSettings(undefined);
    const onToggleExclude = vi.fn();
    const uncategorized = campaign("event", { gameName: undefined, categoryId: undefined });
    const { container } = queue(views([uncategorized], settings), settings, {
      onToggleExclude,
      onToggleBlockedCategory: vi.fn(),
    });

    const exclude = openCard(container, "event").querySelector<HTMLButtonElement>(
      "[data-campaign-exclude]",
    )!;
    expect(exclude.getAttribute("aria-haspopup")).toBeNull();
    act(() => exclude.click());
    expect(onToggleExclude).toHaveBeenCalledWith("event");
  });

  it("stars the campaign's game from the card", () => {
    const settings = mergeSettings(undefined);
    const onToggleFavouriteCategory = vi.fn();
    const { container } = queue(
      views([campaign("rust", { categoryId: "263490", gameName: "Rust" })], settings),
      settings,
      { onToggleFavouriteCategory },
    );

    const favourite = [
      ...openCard(container, "rust").querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("campaignFavourite:Rust"));
    expect(favourite?.getAttribute("aria-pressed")).toBe("false");
    act(() => favourite!.click());
    expect(onToggleFavouriteCategory).toHaveBeenCalledWith({ id: "263490", name: "Rust" });
  });
});

describe("completed view", () => {
  function completed(
    campaigns: CampaignView[],
    overrides: Partial<React.ComponentProps<typeof CompletedPanel>> = {},
  ) {
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
    rewards: [
      {
        id: "done-reward",
        name: "Done reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed",
      },
    ],
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
  it("marks the rewards an expired campaign never earned", () => {
    const settings = mergeSettings(undefined);
    const partlyEarned = campaign("gone", {
      status: "expired",
      rewards: [
        {
          id: "got",
          name: "Got",
          requiredMinutes: 30,
          requirement: "watch",
          isWatchBased: true,
          watchedMinutes: 30,
          status: "claimed",
        },
        {
          id: "lost",
          name: "Lost",
          requiredMinutes: 60,
          requirement: "watch",
          isWatchBased: true,
          watchedMinutes: 10,
          status: "locked",
        },
      ],
    } as never);
    const { container } = completed(views([partlyEarned], settings));
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-completed-tab="expired"]')!.click(),
    );

    const card = openCard(container, "gone");
    const missed = [...card.querySelectorAll("[data-reward-missed]")].map((tile) =>
      tile.querySelector("[title]")?.getAttribute("title"),
    );
    expect(missed).toEqual(["Lost"]);
    // An ended campaign offers nothing to change about its farming.
    expect(card.querySelector("[data-campaign-exclude]")).toBeNull();
  });
});

describe("campaign boundaries", () => {
  const card = (container: Element, id: string) =>
    container.querySelector(`[data-campaign-id="${id}"]`)!;
  // Each column of the expanded card's times group, as its lines of text.
  const times = (element: Element): string[][] =>
    [...element.querySelectorAll("[data-campaign-times] > div")].map((column) =>
      [...column.children].map((line) => line.textContent ?? ""),
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  function at(offsetMinutes: number): string {
    return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
  }

  it("shows an upcoming campaign's start and end, each with its own distance from now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const settings = mergeSettings(undefined);
    const { container } = queue(
      views(
        [
          campaign("now"),
          campaign("later", {
            status: "upcoming",
            eligibility: "upcoming",
            startsAt: at(50 * 60),
            endsAt: at(14 * 24 * 60),
          }),
        ],
        settings,
      ),
      settings,
    );
    expand(container, "upcoming");
    const row = card(container, "later");

    expect(row.querySelector("[data-campaign-status]")?.textContent).toBe("startsIn:2d 2h");
    // The row's tooltip names both boundaries and how long the campaign runs.
    const hint = row.querySelector("[data-campaign-status]")?.getAttribute("data-tooltip") ?? "";
    expect(hint.split("\n")).toEqual([
      expect.stringMatching(/^campaignFactStarts: .+ \(relativeIn:2d 2h\)$/),
      expect.stringMatching(/^campaignFactEnds: .+ \(relativeIn:14d\)$/),
      "campaignLasts:11d 22h",
    ]);

    openCard(container, "later");
    const [starts, ends, watch] = times(row);
    expect(starts?.[0]).toBe("campaignFactStarts");
    expect(starts?.[2]).toBe("relativeIn:2d 2h");
    expect(ends?.[0]).toBe("campaignFactEnds");
    expect(ends?.[2]).toBe("relativeIn:14d");
    // Nothing watched yet: the whole requirement, not "30m of 30m".
    expect(watch).toEqual(["campaignFactWatchTime", "watchTimeNeeded:30m"]);
  });

  it("shows when a running campaign started and how much watching is left of the whole", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const settings = mergeSettings(undefined);
    const running = campaign("running", { startsAt: at(-3 * 60), endsAt: at(2 * 24 * 60) });
    running.rewards[0] = { ...running.rewards[0]!, watchedMinutes: 10, status: "in_progress" };
    const { container } = queue(views([running], settings), settings);
    const row = card(container, "running");

    expect(row.querySelector("[data-campaign-status]")?.textContent).toBe("endsIn:2d");
    expect(row.querySelector("[data-campaign-watch-left]")?.textContent).toBe("watchToGo:20m");

    openCard(container, "running");
    const [started, ends, watch] = times(row);
    expect(started?.[0]).toBe("campaignFactStarted");
    expect(started?.[2]).toBe("relativeAgo:3h");
    expect(ends?.[2]).toBe("relativeIn:2d");
    expect(watch).toEqual([
      "campaignFactWatchTime",
      "watchTimeLeftValue:20m",
      "watchTimeOfTotal:30m",
    ]);
  });

  it("warns in the card when the watching left cannot fit before the end", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const settings = mergeSettings(undefined);
    // Shown in the queue whatever the skip setting would do with it.
    const [tight] = views([campaign("tight", { startsAt: at(-60), endsAt: at(10) })], settings);
    const { container } = queue([{ ...tight!, section: "queue" }], settings);
    const row = openCard(container, "tight");

    expect(times(row)[2]).toEqual([
      "campaignFactWatchTime",
      "watchTimeNeeded:30m",
      "insufficientTimeRemaining",
    ]);
  });
});
