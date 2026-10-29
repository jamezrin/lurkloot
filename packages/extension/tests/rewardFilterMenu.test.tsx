// @vitest-environment happy-dom
// The filter's checkboxes, radios and popover are Base UI parts, which need
// real mouse and keyboard events; linkedom has none.
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RewardFilter, RewardKind, UnlinkedCampaignMode } from "@lurkloot/shared/models";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { I18nContext } from "../../popup-ui/src/context";
import { RewardFilterFields, RewardFilterMenu } from "../../popup-ui/src/rewardFilterMenu";
import type { TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key) => key;

// A filter whose groups farm `kinds` unless given their own (#932).
function filterOf(
  kinds: RewardKind[],
  subscriptions: RewardFilter["subscriptions"] = "include",
  groups: { pinned?: RewardKind[]; favourite?: RewardKind[] } = {},
): RewardFilter {
  return {
    kinds,
    subscriptions,
    pinnedKinds: groups.pinned ?? kinds,
    favouriteKinds: groups.favourite ?? kinds,
  };
}

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(node: React.ReactElement): HTMLElement {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>{node}</I18nContext.Provider>,
    );
  });
  return container;
}

describe("RewardFilterFields", () => {
  const cell = (container: HTMLElement, group: string, kind: string) =>
    container.querySelector<HTMLElement>(
      `[role="checkbox"][data-reward-group="${group}"][data-reward-kind="${kind}"]`,
    )!;

  it("empties a group, but cannot uncheck the grid's last kind", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["badge"], "include", { pinned: [], favourite: [] })}
        showSubscriptions
        onChange={onChange}
      />,
    );

    const badge = cell(container, "other", "badge");
    expect(badge.hasAttribute("data-disabled")).toBe(true);
    act(() => badge.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(cell(container, "pinned", "item").hasAttribute("data-disabled")).toBe(false);
  });

  it("lets a column be emptied while another keeps a kind", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["badge"])}
        showSubscriptions={false}
        onChange={onChange}
      />,
    );

    expect(cell(container, "other", "badge").hasAttribute("data-disabled")).toBe(false);
    act(() => cell(container, "other", "badge").click());
    expect(onChange).toHaveBeenCalledWith(
      filterOf([], "include", { pinned: ["badge"], favourite: ["badge"] }),
    );
  });

  it("shows a one-row grid on a platform with one kind", () => {
    const container = mount(
      <RewardFilterFields
        platform="kick"
        filter={defaultRewardFilter("kick")}
        showSubscriptions
        onChange={() => undefined}
      />,
    );

    const grid = container.querySelector<HTMLElement>("[data-reward-kinds-grid]")!;
    expect(grid.querySelectorAll('tbody th[scope="row"]')).toHaveLength(1);
    expect(grid.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
    expect(container.querySelector("[data-subscription-mode]")).not.toBeNull();
  });

  it("lays out kinds by Queue group, labelled, and the modes as a radio group", () => {
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["item", "badge", "emote"], "skip")}
        showSubscriptions
        onChange={() => undefined}
      />,
    );

    const grid = container.querySelector<HTMLElement>("[data-reward-kinds-grid]")!;
    expect(document.getElementById(grid.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "rewardKindsTitle",
    );
    // Columns in Queue order, rows in the platform's order.
    expect(
      [...grid.querySelectorAll<HTMLElement>("thead th[data-reward-group]")].map(
        (heading) => heading.dataset.rewardGroup,
      ),
    ).toEqual(["pinned", "favourite", "other"]);
    expect(
      [...grid.querySelectorAll<HTMLElement>('tbody th[scope="row"]')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["rewardKindItem", "rewardKindBadge", "rewardKindEmote"]);
    expect(grid.querySelectorAll('[role="checkbox"]')).toHaveLength(9);
    expect(cell(container, "favourite", "emote").getAttribute("aria-label")).toBe(
      "rewardKindForGroup",
    );

    const radios = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(document.getElementById(radios.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "subscriptionRewardsTitle",
    );
    expect(radios.getAttribute("data-subscription-mode")).toBe("skip");
    expect(container.textContent).toContain("subscriptionModeSkipHint");
  });

  it("adds a kind to one group only, in the platform's order", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["emote"])}
        showSubscriptions={false}
        onChange={onChange}
      />,
    );

    act(() => cell(container, "favourite", "item").click());
    expect(onChange).toHaveBeenCalledWith(
      filterOf(["emote"], "include", { favourite: ["item", "emote"] }),
    );
    expect(container.querySelector("[data-subscription-mode]")).toBeNull();
  });
});

describe("RewardFilterFields heading toggles (#934)", () => {
  const columnToggle = (group: string) =>
    document.querySelector<HTMLButtonElement>(`[data-reward-group-toggle="${group}"]`)!;
  const rowToggle = (kind: string) =>
    document.querySelector<HTMLButtonElement>(`[data-reward-kind-toggle="${kind}"]`)!;
  const mountGrid = (filter: RewardFilter, onChange = vi.fn()) => {
    mount(
      <RewardFilterFields
        platform="twitch"
        filter={filter}
        showSubscriptions={false}
        onChange={onChange}
      />,
    );
    return onChange;
  };
  const ALL: RewardKind[] = ["item", "badge", "emote"];

  it("unticks a full column, and says so", () => {
    const onChange = mountGrid(filterOf(ALL));
    expect(columnToggle("favourite").getAttribute("aria-label")).toBe("rewardGridUntickAll");
    act(() => columnToggle("favourite").click());
    expect(onChange).toHaveBeenCalledWith(filterOf(ALL, "include", { favourite: [] }));
  });

  it("ticks a column that is not full", () => {
    const onChange = mountGrid(filterOf(["badge"]));
    expect(columnToggle("other").getAttribute("aria-label")).toBe("rewardGridTickAll");
    act(() => columnToggle("other").click());
    expect(onChange).toHaveBeenCalledWith(
      filterOf(ALL, "include", { pinned: ["badge"], favourite: ["badge"] }),
    );
  });

  it("ticks or unticks a kind across every column", () => {
    const onChange = mountGrid(filterOf(ALL));
    act(() => rowToggle("item").click());
    expect(onChange).toHaveBeenLastCalledWith(filterOf(["badge", "emote"]));

    const partial = mountGrid(filterOf(["badge"], "include", { pinned: ["item", "badge"] }));
    act(() => rowToggle("item").click());
    expect(partial).toHaveBeenLastCalledWith(filterOf(["item", "badge"]));
  });

  it("disables a heading that would empty the grid", () => {
    const onChange = mountGrid(filterOf([], "include", { pinned: ALL, favourite: [] }));
    // Unticking the only farming column would farm nothing.
    expect(columnToggle("pinned").disabled).toBe(true);
    act(() => columnToggle("pinned").click());
    expect(onChange).not.toHaveBeenCalled();
    // Ticking another column, or a kind across them, stays possible.
    expect(columnToggle("other").disabled).toBe(false);
    expect(rowToggle("badge").disabled).toBe(false);
  });

  it("disables a kind's heading when that kind is all the grid farms", () => {
    mountGrid(filterOf(["emote"]));
    expect(rowToggle("emote").disabled).toBe(true);
    expect(rowToggle("item").disabled).toBe(false);
  });

  it("highlights the cells a heading acts on while it is hovered or focused", () => {
    mountGrid(filterOf(ALL));
    const lit = () =>
      [...document.querySelectorAll<HTMLElement>("[data-reward-cell-lit]")].map(
        (cell) => cell.querySelector<HTMLElement>("[role=checkbox]")!.dataset,
      );
    act(() => columnToggle("pinned").focus());
    expect(lit().map((cell) => cell.rewardGroup)).toEqual(["pinned", "pinned", "pinned"]);
    act(() => columnToggle("pinned").blur());
    expect(lit()).toEqual([]);
    act(() => {
      rowToggle("badge").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(lit().map((cell) => cell.rewardKind)).toEqual(["badge", "badge", "badge"]);
  });

  it("toggles Kick's one row and each of its columns", () => {
    const onChange = vi.fn();
    mount(
      <RewardFilterFields
        platform="kick"
        filter={defaultRewardFilter("kick")}
        showSubscriptions={false}
        onChange={onChange}
      />,
    );
    act(() => columnToggle("other").click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultRewardFilter("kick"),
      kinds: [],
    });
    // The row is all the grid has, so it cannot be unticked.
    expect(rowToggle("item").disabled).toBe(true);
  });
});

describe("RewardFilterMenu trigger", () => {
  const trigger = (filter: RewardFilter, unlinkedCampaigns: UnlinkedCampaignMode = "include") => {
    const container = mount(
      <RewardFilterMenu
        platform="twitch"
        filter={filter}
        showSubscriptions
        onChange={() => undefined}
        unlinkedCampaigns={unlinkedCampaigns}
        onUnlinkedCampaignsChange={() => undefined}
      />,
    );
    return container.querySelector<HTMLElement>("[data-reward-filter]")!;
  };

  it("always reads Rewards to farm, plain while everything is default", () => {
    const button = trigger(defaultRewardFilter("twitch"));
    expect(button.textContent).toBe("rewardFilterTitle");
    expect(button.getAttribute("aria-label")).toBe("rewardFilterTitle");
    expect(button.hasAttribute("data-narrowed")).toBe(false);
    expect(button.querySelector("[data-reward-filter-dot]")).toBeNull();
  });

  it.each([
    [
      "only pins farming",
      filterOf([], "include", { pinned: ["item", "badge", "emote"], favourite: [] }),
      "include",
    ],
    [
      "only favourites farming",
      filterOf([], "include", { pinned: [], favourite: ["item"] }),
      "include",
    ],
    ["a narrowed kind", filterOf(["badge"]), "include"],
    ["a subscription mode", { ...defaultRewardFilter("twitch"), subscriptions: "skip" }, "include"],
    ["the unlinked mode", defaultRewardFilter("twitch"), "last"],
  ] as const)("marks the button customised for %s, with the same label", (_, filter, unlinked) => {
    const button = trigger(filter as RewardFilter, unlinked as UnlinkedCampaignMode);
    expect(button.textContent).toBe("rewardFilterTitle");
    expect(button.getAttribute("aria-label")).toBe("rewardFilterTitleCustomized");
    expect(button.hasAttribute("data-narrowed")).toBe(true);
    expect(button.querySelector("[data-reward-filter-dot]")).not.toBeNull();
  });
});

describe("RewardFilterMenu menu", () => {
  const openMenu = (
    platform: "twitch" | "kick",
    showSubscriptions: boolean,
    onUnlinkedCampaignsChange: (value: UnlinkedCampaignMode) => void = () => undefined,
  ) => {
    const container = mount(
      <div data-scroller="" style={{ overflowY: "auto" }}>
        <RewardFilterMenu
          platform={platform}
          filter={defaultRewardFilter(platform)}
          showSubscriptions={showSubscriptions}
          onChange={() => undefined}
          unlinkedCampaigns="include"
          onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
        />
      </div>,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    return container;
  };
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!;

  it("has no farm-pinned-only switch: the grid's columns decide it", () => {
    openMenu("twitch", true);
    expect(document.querySelector("[data-queue-pinned-only]")).toBeNull();
    expect(dialog().textContent).not.toContain("farmPinnedOnlyTitle");
  });

  it("puts the kinds beside the other questions, and separates those two", () => {
    openMenu("twitch", true);
    const grid = document.querySelector<HTMLElement>("[data-reward-kinds-grid]")!;
    const unlinked = document.querySelector<HTMLElement>("[data-unlinked-mode]")!;
    const subscriptions = document.querySelector<HTMLElement>("[data-subscription-mode]")!;
    const column = (element: HTMLElement) => element.closest<HTMLElement>(".border-s");
    expect(column(grid)).toBeNull();
    expect(column(unlinked)).not.toBeNull();
    expect(column(unlinked)).toBe(column(subscriptions));
    expect(unlinked.closest<HTMLElement>(".border-t")).not.toBeNull();
  });

  it("draws no separator above the unlinked choice when nothing is above it", () => {
    openMenu("kick", false);
    const unlinked = document.querySelector<HTMLElement>("[data-unlinked-mode]")!;
    expect(unlinked.closest<HTMLElement>(".border-t")).toBeNull();
    // Kick's one kind still gets its grid.
    expect(document.querySelector("[data-reward-kinds-grid]")).not.toBeNull();
  });

  it("offers include, skip and farm last for unlinked campaigns", () => {
    const onUnlinkedCampaignsChange = vi.fn();
    openMenu("kick", false, onUnlinkedCampaignsChange);
    const options = [...document.querySelectorAll<HTMLElement>("[data-unlinked-option]")];
    expect(options.map((option) => option.dataset.unlinkedOption)).toEqual([
      "include",
      "skip",
      "last",
    ]);
    const group = document.querySelector<HTMLElement>("[data-unlinked-mode]")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "unlinkedCampaignsTitle",
    );
    expect(document.body.textContent).toContain("unlinkedModeIncludeHint");
    act(() => options[2]!.click());
    expect(onUnlinkedCampaignsChange).toHaveBeenCalledWith("last");
  });

  it("closes when the page scrolls under it", () => {
    const container = openMenu("twitch", true);
    expect(dialog()).not.toBeNull();
    act(() => {
      container.querySelector("[data-scroller]")!.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("[data-reward-filter]")!.hasAttribute("data-popup-open")).toBe(
      false,
    );
  });

  it("stays open while its own content scrolls", () => {
    const container = openMenu("twitch", true);
    act(() => {
      dialog().dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("[data-reward-filter]")!.hasAttribute("data-popup-open")).toBe(
      true,
    );
  });
});

describe("RewardFilterMenu reset", () => {
  it("clears the unlinked mode along with the filter, ending pinned only", () => {
    const onChange = vi.fn();
    const onUnlinkedCampaignsChange = vi.fn();
    const container = mount(
      <RewardFilterMenu
        platform="kick"
        filter={filterOf([], "include", { pinned: ["item"], favourite: [] })}
        showSubscriptions={false}
        onChange={onChange}
        unlinkedCampaigns="last"
        onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    act(() => document.querySelector<HTMLElement>("[data-reward-filter-reset]")!.click());
    expect(onChange).toHaveBeenCalledWith(defaultRewardFilter("kick"));
    expect(onUnlinkedCampaignsChange).toHaveBeenCalledWith("include");
  });

  it("leaves the unlinked mode alone when it is already default", () => {
    const onUnlinkedCampaignsChange = vi.fn();
    const container = mount(
      <RewardFilterMenu
        platform="twitch"
        filter={filterOf(["badge"])}
        showSubscriptions
        onChange={() => undefined}
        unlinkedCampaigns="include"
        onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    act(() => document.querySelector<HTMLElement>("[data-reward-filter-reset]")!.click());
    expect(onUnlinkedCampaignsChange).not.toHaveBeenCalled();
  });

  it("offers no reset while nothing is narrowed", () => {
    const container = mount(
      <RewardFilterMenu
        platform="twitch"
        filter={defaultRewardFilter("twitch")}
        showSubscriptions
        onChange={() => undefined}
        unlinkedCampaigns="include"
        onUnlinkedCampaignsChange={() => undefined}
      />,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    expect(document.querySelector("[data-reward-filter-reset]")).toBeNull();
  });
});
