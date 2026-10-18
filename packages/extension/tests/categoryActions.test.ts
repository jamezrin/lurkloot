import { describe, expect, it } from "vitest";
import { mergeSettings } from "@lurkloot/shared/settings";
import {
  blockTogglePatch,
  favouriteTogglePatch,
  moveFavourite,
} from "../../popup-ui/src/categoryActions";

const rust = { id: "263490", name: "Rust" };

function lists(patch: Record<string, unknown> = {}) {
  return { ...mergeSettings(undefined).platform.twitch, ...patch };
}

describe("category actions", () => {
  it("keeps a game's star when it is blocked, so unblocking restores it", () => {
    const starred = lists({ favouriteCategories: [rust] });

    expect(blockTogglePatch(starred, rust)).toEqual({ blockedCategories: [rust] });
    expect(
      blockTogglePatch({ ...starred, blockedCategories: [rust] }, { id: "263490", name: "rust" }),
    ).toEqual({ blockedCategories: [] });
  });

  it("selects a starred game in allowlist mode, and only there", () => {
    expect(favouriteTogglePatch(lists({ categoryMode: "include" }), rust)).toEqual({
      favouriteCategories: [rust],
      categories: [rust],
    });
    expect(favouriteTogglePatch(lists({ categoryMode: "all" }), rust)).toEqual({
      favouriteCategories: [rust],
    });
  });

  it("unstars without touching the selection", () => {
    const starred = lists({
      categoryMode: "include",
      categories: [rust],
      favouriteCategories: [rust],
    });
    expect(favouriteTogglePatch(starred, rust)).toEqual({ favouriteCategories: [] });
  });
});

describe("moveFavourite", () => {
  const a = { id: "a", name: "A" };
  const b = { id: "b", name: "B" };
  const c = { id: "c", name: "C" };
  const d = { id: "d", name: "D" };

  it("moves a favourite earlier or later in the list", () => {
    expect(moveFavourite([a, b, c], [a, b, c], c, 0)).toEqual([c, a, b]);
    expect(moveFavourite([a, b, c], [a, b, c], a, 2)).toEqual([b, c, a]);
  });

  it("returns the same list when the favourite stays put", () => {
    const favourites = [a, b, c];
    expect(moveFavourite(favourites, favourites, b, 1)).toBe(favourites);
    expect(moveFavourite(favourites, favourites, d, 0)).toBe(favourites);
  });

  it("takes the shown neighbour's slot, so a hidden favourite keeps its place", () => {
    // b is hidden (blocked, or filtered out by the search).
    expect(moveFavourite([a, b, c, d], [a, c, d], d, 0)).toEqual([d, a, b, c]);
    expect(moveFavourite([a, b, c, d], [a, c, d], a, 1)).toEqual([b, c, a, d]);
  });

  it("clamps a position past the end onto the last shown favourite", () => {
    expect(moveFavourite([a, b, c], [a, b], a, 9)).toEqual([b, a, c]);
  });
});
