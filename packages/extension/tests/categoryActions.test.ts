import { describe, expect, it } from "vitest";
import { mergeSettings } from "@lurkloot/shared/settings";
import { blockTogglePatch, favouriteTogglePatch } from "../../popup-ui/src/categoryActions";

const rust = { id: "263490", name: "Rust" };

function lists(patch: Record<string, unknown> = {}) {
  return { ...mergeSettings(undefined).platform.twitch, ...patch };
}

describe("category actions", () => {
  it("keeps a game's star when it is blocked, so unblocking restores it", () => {
    const starred = lists({ favouriteCategories: [rust] });

    expect(blockTogglePatch(starred, rust)).toEqual({ blockedCategories: [rust] });
    expect(blockTogglePatch({ ...starred, blockedCategories: [rust] }, { id: "263490", name: "rust" })).toEqual({ blockedCategories: [] });
  });

  it("selects a starred game in allowlist mode, and only there", () => {
    expect(favouriteTogglePatch(lists({ categoryMode: "include" }), rust)).toEqual({ favouriteCategories: [rust], categories: [rust] });
    expect(favouriteTogglePatch(lists({ categoryMode: "all" }), rust)).toEqual({ favouriteCategories: [rust] });
  });

  it("unstars without touching the selection", () => {
    const starred = lists({ categoryMode: "include", categories: [rust], favouriteCategories: [rust] });
    expect(favouriteTogglePatch(starred, rust)).toEqual({ favouriteCategories: [] });
  });
});
