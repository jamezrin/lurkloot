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
});

describe("RewardFilterFields", () => {
  const cell = (container: HTMLElement, group: string, kind: string) =>
    container.querySelector<HTMLElement>(
      `[role="checkbox"][data-reward-group="${group}"][data-reward-kind="${kind}"]`,
    )!;

  it("cannot uncheck a group's last kind", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["badge"], "include", { pinned: ["item", "badge"] })}
        showSubscriptions
        farmPinnedOnly={false}
        onChange={onChange}
      />,
    );

    const badge = cell(container, "other", "badge");
    expect(badge.hasAttribute("data-disabled")).toBe(true);
    act(() => badge.click());
    expect(onChange).not.toHaveBeenCalled();
    // Another group with two kinds can drop either, and the others stay free to add.
    expect(cell(container, "pinned", "badge").hasAttribute("data-disabled")).toBe(false);
    expect(cell(container, "other", "item").hasAttribute("data-disabled")).toBe(false);
  });

  it("hides the kinds on a platform with one kind", () => {
    const container = mount(
      <RewardFilterFields
        platform="kick"
        filter={defaultRewardFilter("kick")}
        showSubscriptions
        farmPinnedOnly={false}
        onChange={() => undefined}
      />,
    );

    expect(container.querySelector("[data-reward-kinds-grid]")).toBeNull();
    expect(container.querySelector("[data-subscription-mode]")).not.toBeNull();
  });

  it("lays out kinds by Queue group, labelled, and the modes as a radio group", () => {
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["item", "badge", "emote"], "skip")}
        showSubscriptions
        farmPinnedOnly={false}
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
        farmPinnedOnly={false}
        onChange={onChange}
      />,
    );

    act(() => cell(container, "favourite", "item").click());
    expect(onChange).toHaveBeenCalledWith(
      filterOf(["emote"], "include", { favourite: ["item", "emote"] }),
    );
    expect(container.querySelector("[data-subscription-mode]")).toBeNull();
  });

  it("disables the favourite and other columns while only pins are farmed", () => {
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={filterOf(["item", "badge", "emote"])}
        showSubscriptions={false}
        farmPinnedOnly
        onChange={() => undefined}
      />,
    );

    for (const kind of ["item", "badge", "emote"]) {
      expect(cell(container, "pinned", kind).hasAttribute("data-disabled")).toBe(false);
      expect(cell(container, "favourite", kind).hasAttribute("data-disabled")).toBe(true);
      expect(cell(container, "other", kind).hasAttribute("data-disabled")).toBe(true);
    }
    expect(container.querySelector("[data-reward-kinds-pinned-only]")?.textContent).toBe(
      "rewardKindsPinnedOnlyHint",
    );
  });
});

describe("RewardFilterMenu trigger", () => {
  const trigger = (
    filter: RewardFilter,
    farmPinnedOnly: boolean,
    unlinkedCampaigns: UnlinkedCampaignMode = "include",
  ) => {
    const container = mount(
      <RewardFilterMenu
        platform="twitch"
        filter={filter}
        showSubscriptions
        farmPinnedOnly={farmPinnedOnly}
        onChange={() => undefined}
        onFarmPinnedOnlyChange={() => undefined}
        unlinkedCampaigns={unlinkedCampaigns}
        onUnlinkedCampaignsChange={() => undefined}
      />,
    );
    return container.querySelector<HTMLElement>("[data-reward-filter]")!;
  };

  it("says pinned only on the closed button and accents it", () => {
    const button = trigger(defaultRewardFilter("twitch"), true);
    expect(button.textContent).toBe("rewardFilterAll · rewardFilterPinnedOnly");
    expect(button.getAttribute("aria-label")).toBe(
      "rewardFilterTitle: rewardFilterAll · rewardFilterPinnedOnly",
    );
    expect(button.hasAttribute("data-narrowed")).toBe(true);
  });

  it("appends pinned only after the narrowing", () => {
    const button = trigger(filterOf(["badge"], "skip"), true);
    expect(button.textContent).toBe("rewardKindBadge · rewardFilterNoSub · rewardFilterPinnedOnly");
  });

  it("stays plain when pinned only is off and unlinked campaigns are included", () => {
    const button = trigger(defaultRewardFilter("twitch"), false);
    expect(button.textContent).toBe("rewardFilterAll");
    expect(button.hasAttribute("data-narrowed")).toBe(false);
  });

  it("names the unlinked mode between the filter and pinned only, and accents it", () => {
    expect(trigger(defaultRewardFilter("twitch"), false, "skip").textContent).toBe(
      "rewardFilterAll · rewardFilterNoUnlinked",
    );
    const last = trigger(filterOf(["badge"]), true, "last");
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
          farmPinnedOnly={false}
          onChange={() => undefined}
          onFarmPinnedOnlyChange={() => undefined}
          unlinkedCampaigns="include"
          onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
        />
      </div>,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    return container;
  };
  const pinnedRow = () =>
    document.querySelector<HTMLElement>("[data-queue-pinned-only]")?.parentElement ?? null;

  const unlinkedSection = () =>
    document
      .querySelector<HTMLElement>("[data-unlinked-mode]")
      ?.closest<HTMLElement>("[role=dialog] > div") ?? null;

  it("draws no separator when there is nothing above the unlinked choice", () => {
    openMenu("kick", false);
    const section = unlinkedSection()!;
    expect(section.previousElementSibling).toBeNull();
    expect(section.className).not.toContain("border-t");
    // Pinned only always follows the unlinked choice, so it is always separated.
    expect(pinnedRow()!.className).toContain("border-t");
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

  it("keeps the narrow menu on a platform with one kind", () => {
    openMenu("kick", true);
    expect(document.querySelector("[data-reward-kinds-grid]")).toBeNull();
    expect(document.querySelector<HTMLElement>("[role=dialog]")!.className).toContain(
      "w-[15.5rem]",
    );
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

  it("separates pinned only from the filter fields", () => {
    openMenu("twitch", true);
    const row = pinnedRow()!;
    expect(row.previousElementSibling).not.toBeNull();
    expect(row.className).toContain("border-t");
  });

  it("closes when the page scrolls under it", () => {
    const container = openMenu("twitch", true);
    expect(pinnedRow()).not.toBeNull();
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
      pinnedRow()!.closest("[role=dialog]")!.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("[data-reward-filter]")!.hasAttribute("data-popup-open")).toBe(
      true,
    );
  });
});

describe("RewardFilterMenu reset", () => {
  it("clears pinned only and the unlinked mode along with the filter", () => {
    const onChange = vi.fn();
    const onFarmPinnedOnlyChange = vi.fn();
    const onUnlinkedCampaignsChange = vi.fn();
    const container = mount(
      <RewardFilterMenu
        platform="kick"
        filter={defaultRewardFilter("kick")}
        showSubscriptions={false}
        farmPinnedOnly
        onChange={onChange}
        onFarmPinnedOnlyChange={onFarmPinnedOnlyChange}
        unlinkedCampaigns="last"
        onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    act(() => document.querySelector<HTMLElement>("[data-reward-filter-reset]")!.click());
    expect(onChange).toHaveBeenCalledWith(defaultRewardFilter("kick"));
    expect(onFarmPinnedOnlyChange).toHaveBeenCalledWith(false);
    expect(onUnlinkedCampaignsChange).toHaveBeenCalledWith("include");
  });

  it("leaves pinned only and the unlinked mode alone when they are already default", () => {
    const onFarmPinnedOnlyChange = vi.fn();
    const onUnlinkedCampaignsChange = vi.fn();
    const container = mount(
      <RewardFilterMenu
        platform="twitch"
        filter={filterOf(["badge"])}
        showSubscriptions
        farmPinnedOnly={false}
        onChange={() => undefined}
        onFarmPinnedOnlyChange={onFarmPinnedOnlyChange}
        unlinkedCampaigns="include"
        onUnlinkedCampaignsChange={onUnlinkedCampaignsChange}
      />,
    );
    act(() => container.querySelector<HTMLElement>("[data-reward-filter]")!.click());
    act(() => document.querySelector<HTMLElement>("[data-reward-filter-reset]")!.click());
    expect(onFarmPinnedOnlyChange).not.toHaveBeenCalled();
    expect(onUnlinkedCampaignsChange).not.toHaveBeenCalled();
  });
});
