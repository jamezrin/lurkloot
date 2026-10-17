// @vitest-environment happy-dom
// The filter's checkboxes, radios and popover are Base UI parts, which need
// real mouse and keyboard events; linkedom has none.
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RewardFilter } from "@lurkloot/shared/models";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { I18nContext } from "../../popup-ui/src/context";
import { RewardFilterFields, rewardFilterLabel } from "../../popup-ui/src/rewardFilterMenu";
import type { TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key) => key;

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
    const filter: RewardFilter = { kinds: ["badge"], subscriptions: "include" };
    const label = rewardFilterLabel(filter, "twitch", t);
    expect(label).toContain("rewardKindBadge");
    expect(label).not.toContain("rewardFilterNoSub");
  });

  it("names the kinds and then the subscription mode", () => {
    const label = rewardFilterLabel(
      { kinds: ["badge", "emote"], subscriptions: "skip" },
      "twitch",
      t,
    );
    expect(label).toContain("rewardKindBadge");
    expect(label).toContain("rewardKindEmote");
    expect(label).toContain("rewardFilterNoSub");
    expect(label.indexOf("rewardKindEmote")).toBeLessThan(label.indexOf("rewardFilterNoSub"));
  });

  it("says All for the kinds when only the subscription mode narrows", () => {
    const label = rewardFilterLabel(
      { kinds: ["item", "badge", "emote"], subscriptions: "only" },
      "twitch",
      t,
    );
    expect(label).toContain("rewardFilterAllKinds");
    expect(label).toContain("rewardFilterSubOnly");
  });
});

describe("RewardFilterFields", () => {
  it("cannot uncheck the last kind", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={{ kinds: ["badge"], subscriptions: "include" }}
        showSubscriptions
        onChange={onChange}
      />,
    );

    const badge = container.querySelector<HTMLElement>('[data-reward-kind="badge"]')!;
    expect(badge).not.toBeNull();
    expect(badge.hasAttribute("data-disabled")).toBe(true);
    act(() => badge.click());
    expect(onChange).not.toHaveBeenCalled();
    // The others stay free to add.
    expect(
      container.querySelector('[data-reward-kind="item"]')!.hasAttribute("data-disabled"),
    ).toBe(false);
  });

  it("hides the kinds on a platform with one kind", () => {
    const container = mount(
      <RewardFilterFields
        platform="kick"
        filter={defaultRewardFilter("kick")}
        showSubscriptions
        onChange={() => undefined}
      />,
    );

    expect(container.querySelector("[data-reward-kind]")).toBeNull();
    expect(container.querySelector("[data-subscription-mode]")).not.toBeNull();
  });

  it("labels the kinds as a checkbox group and the modes as a radio group", () => {
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={{ kinds: ["item", "badge", "emote"], subscriptions: "skip" }}
        showSubscriptions
        counts={{ item: 9, badge: 3, emote: 1 }}
        onChange={() => undefined}
      />,
    );

    const group = container.querySelector<HTMLElement>('[role="group"][aria-labelledby]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "rewardKindsTitle",
    );
    expect(group.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
    expect(container.querySelector('[data-reward-kind="item"]')?.textContent).toContain("9");

    const radios = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(document.getElementById(radios.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "subscriptionRewardsTitle",
    );
    expect(radios.getAttribute("data-subscription-mode")).toBe("skip");
    expect(container.textContent).toContain("subscriptionModeSkipHint");
  });

  it("adds a kind in the platform's order", () => {
    const onChange = vi.fn();
    const container = mount(
      <RewardFilterFields
        platform="twitch"
        filter={{ kinds: ["emote"], subscriptions: "include" }}
        showSubscriptions={false}
        onChange={onChange}
      />,
    );

    act(() => container.querySelector<HTMLElement>('[data-reward-kind="item"]')!.click());
    expect(onChange).toHaveBeenCalledWith({ kinds: ["item", "emote"], subscriptions: "include" });
    expect(container.querySelector("[data-subscription-mode]")).toBeNull();
  });
});
