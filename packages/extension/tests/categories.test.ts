import { describe, expect, it } from "vitest";
import type { CategorySelection, DropCampaign } from "@lurkloot/shared/models";
import { NO_CATEGORY_ID, categoryListIndex, isUncategorizedCampaign } from "@lurkloot/shared/categories";

const campaign = (patch: Partial<DropCampaign> = {}): DropCampaign => ({
  id: "c",
  platform: "kick",
  name: "Football Drop: Streamer Jersey",
  status: "active",
  rewards: [],
  ...patch,
});

describe("categoryListIndex", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const noCategory: CategorySelection = { id: NO_CATEGORY_ID, name: "No category" };

  it("matches a categorized campaign by id or name", () => {
    expect(categoryListIndex(campaign({ categoryId: "13", gameName: "Rust" }), [rust])).toBe(0);
    expect(categoryListIndex(campaign({ gameName: "Rust" }), [rust])).toBe(0);
  });

  it("never matches a categorized campaign against the No category sentinel", () => {
    expect(categoryListIndex(campaign({ categoryId: "13", gameName: "Rust" }), [noCategory])).toBe(-1);
  });

  it("matches a category-less campaign only against the No category sentinel", () => {
    const uncategorized = campaign(); // no categoryId, no gameName
    expect(categoryListIndex(uncategorized, [noCategory])).toBe(0);
    expect(categoryListIndex(uncategorized, [rust])).toBe(-1);
    expect(categoryListIndex(uncategorized, [rust, noCategory])).toBe(1);
  });

  it("returns -1 for an empty selection list", () => {
    expect(categoryListIndex(campaign(), [])).toBe(-1);
    expect(categoryListIndex(campaign({ gameName: "Rust" }), [])).toBe(-1);
  });
});

describe("isUncategorizedCampaign", () => {
  it("is true only when both categoryId and gameName are absent", () => {
    expect(isUncategorizedCampaign(campaign())).toBe(true);
    expect(isUncategorizedCampaign(campaign({ gameName: "Rust" }))).toBe(false);
    expect(isUncategorizedCampaign(campaign({ categoryId: "13" }))).toBe(false);
  });
});
