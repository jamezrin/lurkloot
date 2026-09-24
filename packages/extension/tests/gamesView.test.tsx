// @vitest-environment happy-dom
// Its switches, checkboxes and number fields are Base UI parts, which need
// real mouse and keyboard events; linkedom has none.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategorySelection, ExtensionSettings } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { GamesPanel } from "../../popup-ui/src/games";
import type { GameItem, TFunction } from "../../popup-ui/src/types";

const t: TFunction = (key, substitutions) => {
  const value = Array.isArray(substitutions) ? substitutions.join(", ") : substitutions;
  return value === undefined ? key : `${key}:${value}`;
};

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const rust: CategorySelection = { id: "rust", name: "Rust" };
const other: CategorySelection = { id: "other", name: "Other Game" };

const suggestions: GameItem[] = [
  { id: "rust", name: "Rust", short: "RU", accent: "#fff" },
  { id: "other", name: "Other Game", short: "OG", accent: "#fff" },
];

function mount(settings: ExtensionSettings, handlers: Partial<React.ComponentProps<typeof GamesPanel>> = {}) {
  document.body.innerHTML = "<div id=app></div>";
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.getElementById("app")!;
  const props = {
    platform: "twitch" as const,
    settings,
    suggestions,
    campaignCounts: { rust: 2 },
    onCategoryModeChange: vi.fn(),
    onCategoriesChange: vi.fn(),
    onFavouritesChange: vi.fn(),
    onBlockedChange: vi.fn(),
    onSearchCategories: async () => [],
    ...handlers,
  };
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nContext.Provider value={{ t, dir: "ltr", locale: "en" }}>
        <GamesPanel {...props} />
      </I18nContext.Provider>,
    );
  });
  return { container, props };
}

function settingsWith(patch: Record<string, unknown>): ExtensionSettings {
  return mergeSettings({ platform: { twitch: patch } } as never);
}

const row = (container: Element, id: string) => container.querySelector(`[data-game="${id}"]`);

describe("games view", () => {
  it("lists every game with a live campaign while farming all games", () => {
    const { container } = mount(settingsWith({ categoryMode: "all" }));

    expect(row(container, "rust")).not.toBeNull();
    expect(row(container, "rust")?.textContent).toContain("2");
  });

  it("lists favourites first, in the order their stars rank, and numbers them", () => {
    const { container } = mount(settingsWith({ categoryMode: "all", favouriteCategories: [other, rust] }));

    const order = [...container.querySelectorAll<HTMLElement>("[data-game]")].map((node) => node.dataset.game);
    expect(order).toEqual(["other", "rust"]);
    expect(row(container, "other")?.querySelector("[data-game-favourite-rank]")?.textContent).toBe("1");
    expect(row(container, "rust")?.querySelector("[data-game-favourite-rank]")?.textContent).toBe("2");
  });

  it("puts starred games above the rest", () => {
    const { container } = mount(settingsWith({ categoryMode: "all", favouriteCategories: [other] }));

    const order = [...container.querySelectorAll<HTMLElement>("[data-game]")].map((node) => node.dataset.game);
    expect(order).toEqual(["other", "rust"]);
    expect(row(container, "rust")?.querySelector("[data-game-favourite-rank]")?.textContent).toBe("");
  });

  it("stars a game so its campaigns rank above the strategy", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "all" }));

    act(() => container.querySelector<HTMLButtonElement>('[data-game="rust"] [data-game-favourite]')?.click());

    expect(props.onFavouritesChange).toHaveBeenCalledWith([rust]);
  });

  it("removes a star without touching the rest of the list", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "all", favouriteCategories: [rust, other] }));

    act(() => container.querySelector<HTMLButtonElement>('[data-game="rust"] [data-game-favourite]')?.click());

    expect(props.onFavouritesChange).toHaveBeenCalledWith([other]);
  });

  it("selects a game when it is starred while only selected games are farmed", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "include", categories: [other] }));

    act(() => container.querySelector<HTMLButtonElement>('[data-game="rust"] [data-game-favourite]')?.click());

    expect(props.onFavouritesChange).toHaveBeenCalledWith([rust]);
    expect(props.onCategoriesChange).toHaveBeenCalledWith([other, rust]);
  });

  it("moves a blocked game to its own list", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "all" }));

    act(() => container.querySelector<HTMLButtonElement>('[data-game="rust"] [data-game-block]')?.click());

    expect(props.onBlockedChange).toHaveBeenCalledWith([rust]);
  });

  it("keeps a blocked game's star and selection so unblocking restores them", () => {
    const blocked = settingsWith({ categoryMode: "include", categories: [rust], favouriteCategories: [rust], blockedCategories: [rust] });
    const { container, props } = mount(blocked);

    const blockedRow = container.querySelector('[data-blocked-game="rust"]');
    expect(blockedRow).not.toBeNull();
    expect(container.querySelector('[data-game="rust"]')).toBeNull();

    act(() => blockedRow!.querySelector<HTMLButtonElement>("[data-game-unblock]")?.click());

    expect(props.onBlockedChange).toHaveBeenCalledWith([]);
    expect(props.onFavouritesChange).not.toHaveBeenCalled();
    expect(props.onCategoriesChange).not.toHaveBeenCalled();
  });

  it("ticks a game into the allowlist only while the mode uses one", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "include", categories: [] }));

    act(() => container.querySelector<HTMLButtonElement>('[data-game="rust"] [data-game-select]')?.click());
    expect(props.onCategoriesChange).toHaveBeenCalledWith([rust]);
  });

  it("switches between farming every game and only the selected ones", () => {
    const { container, props } = mount(settingsWith({ categoryMode: "all" }));

    act(() => container.querySelector<HTMLButtonElement>('[data-games-mode="include"]')?.click());

    expect(props.onCategoryModeChange).toHaveBeenCalledWith("include");
  });
});
