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
import {
  RewardFilterFields,
  RewardFilterMenu,
  farmsPinnedOnly,
  rewardFilterLabel,
} from "../../popup-ui/src/rewardFilterMenu";
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

describe("rewardFilterLabel", () => {
  it("names nothing while every reward is farmed", () => {
    expect(rewardFilterLabel(defaultRewardFilter("twitch"), "twitch", t)).toBe("rewardFilterAll");
    expect(rewardFilterLabel(defaultRewardFilter("kick"), "kick", t)).toBe("rewardFilterAll");
  });

  it("names the kinds kept", () => {
    const label = rewardFilterLabel(filterOf(["badge"]), "twitch", t);
    expect(label).toContain("rewardKindBadge");
    expect(label).not.toContain("rewardFilterNoSub");
  });

  it("names the kinds and then the subscription mode", () => {
    const label = rewardFilterLabel(filterOf(["badge", "emote"], "skip"), "twitch", t);
    expect(label).toContain("rewardKindBadge");
    expect(label).toContain("rewardKindEmote");
    expect(label).toContain("rewardFilterNoSub");
    expect(label.indexOf("rewardKindEmote")).toBeLessThan(label.indexOf("rewardFilterNoSub"));
  });

  it("says All for the kinds when only the subscription mode narrows", () => {
    const label = rewardFilterLabel(filterOf(["item", "badge", "emote"], "only"), "twitch", t);
    expect(label).toContain("rewardFilterAllKinds");
    expect(label).toContain("rewardFilterSubOnly");
  });

  it("says mixed types while the Queue groups farm different kinds", () => {
    const label = rewardFilterLabel(
      filterOf(["badge"], "skip", { favourite: ["item", "badge", "emote"] }),
      "twitch",
      t,
    );
    expect(label).toBe("rewardFilterMixedTypes · rewardFilterNoSub");
  });

  it("names the pinned kinds when only pins farm, and All rewards for all of them", () => {
    const ALL: RewardKind[] = ["item", "badge", "emote"];
    expect(
      rewardFilterLabel(filterOf([], "include", { pinned: ALL, favourite: [] }), "twitch", t),
    ).toBe("rewardFilterAll");
    expect(
      rewardFilterLabel(filterOf([], "skip", { pinned: ["badge"], favourite: [] }), "twitch", t),
    ).toBe("rewardKindBadge · rewardFilterNoSub");
    expect(farmsPinnedOnly(filterOf([], "include", { pinned: ALL, favourite: [] }), "twitch")).toBe(
      true,
    );
    expect(farmsPinnedOnly(filterOf([], "include", { favourite: ["item"] }), "twitch")).toBe(false);
  });
});

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
  const pinsOnly = (pinned: RewardKind[] = ["item", "badge", "emote"]) =>
    filterOf([], "include", { pinned, favourite: [] });

  it("says pinned only on the closed button and accents it", () => {
    const button = trigger(pinsOnly());
    expect(button.textContent).toBe("rewardFilterAll · rewardFilterPinnedOnly");
    expect(button.getAttribute("aria-label")).toBe(
      "rewardFilterTitle: rewardFilterAll · rewardFilterPinnedOnly",
    );
    expect(button.hasAttribute("data-narrowed")).toBe(true);
  });

  it("appends pinned only after the pinned kinds and the subscription mode", () => {
    const button = trigger({ ...pinsOnly(["badge"]), subscriptions: "skip" });
    expect(button.textContent).toBe("rewardKindBadge · rewardFilterNoSub · rewardFilterPinnedOnly");
  });

  it("stays plain when every reward is farmed and unlinked campaigns are included", () => {
    const button = trigger(defaultRewardFilter("twitch"));
    expect(button.textContent).toBe("rewardFilterAll");
    expect(button.hasAttribute("data-narrowed")).toBe(false);
  });

  it("names the unlinked mode between the filter and pinned only, and accents it", () => {
    expect(trigger(defaultRewardFilter("twitch"), "skip").textContent).toBe(
      "rewardFilterAll · rewardFilterNoUnlinked",
    );
    const last = trigger(pinsOnly(["badge"]), "last");
    expect(last.textContent).toBe(
      "rewardKindBadge · rewardFilterUnlinkedLast · rewardFilterPinnedOnly",
    );
    expect(last.hasAttribute("data-narrowed")).toBe(true);
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
