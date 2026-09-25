import { describe, expect, it } from "vitest";
import type { CategorySelection, DropCampaign, PlatformSettings } from "@lurkloot/shared/models";
import { NO_CATEGORY_ID, campaignPassesCategoryFilter, categoryListIndex, favouriteCategoryIndex, isCampaignCategoryBlocked, isUncategorizedCampaign } from "@lurkloot/shared/categories";

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

describe("campaignPassesCategoryFilter", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const noCategory: CategorySelection = { id: NO_CATEGORY_ID, name: "No category" };
  const rustCampaign = campaign({ categoryId: "13", gameName: "Rust" });
  const other = campaign({ categoryId: "21", gameName: "Other" });
  const uncategorized = campaign();

  it("passes everything in all mode, whatever the list holds", () => {
    for (const c of [rustCampaign, other, uncategorized]) {
      expect(campaignPassesCategoryFilter(c, { categoryMode: "all", categories: [] })).toBe(true);
      expect(campaignPassesCategoryFilter(c, { categoryMode: "all", categories: [rust] })).toBe(true);
    }
  });

  it("passes only listed categories in include mode", () => {
    const include: Pick<PlatformSettings, "categoryMode" | "categories"> = { categoryMode: "include", categories: [rust] };
    expect(campaignPassesCategoryFilter(rustCampaign, include)).toBe(true);
    expect(campaignPassesCategoryFilter(other, include)).toBe(false);
  });

  it("passes everything except blocked categories, in either mode", () => {
    const blocked = { categoryMode: "all" as const, categories: [], blockedCategories: [rust] };
    expect(campaignPassesCategoryFilter(rustCampaign, blocked)).toBe(false);
    expect(campaignPassesCategoryFilter(other, blocked)).toBe(true);
    // Blocking wins over an allowlist that admits the same category.
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "include", categories: [rust], blockedCategories: [rust] })).toBe(false);
  });

  it("farms nothing on an empty include list and everything with an empty block list", () => {
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "include", categories: [] })).toBe(false);
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "all", categories: [], blockedCategories: [] })).toBe(true);
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "all", categories: [], blockedCategories: [] })).toBe(true);
  });

  it("applies both modes to the No category sentinel", () => {
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "include", categories: [noCategory] })).toBe(true);
    expect(campaignPassesCategoryFilter(uncategorized, { categoryMode: "all", categories: [], blockedCategories: [noCategory] })).toBe(false);
    // A categorized campaign never matches the sentinel, so blocking it keeps it.
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "all", categories: [], blockedCategories: [noCategory] })).toBe(true);
    expect(campaignPassesCategoryFilter(rustCampaign, { categoryMode: "include", categories: [noCategory] })).toBe(false);
  });
});

describe("favouriteCategoryIndex", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const otherGame: CategorySelection = { id: "21", name: "Other" };
  const rustCampaign = campaign({ categoryId: "13", gameName: "Rust" });
  const other = campaign({ categoryId: "21", gameName: "Other" });

  it("returns the position a category was starred in", () => {
    expect(favouriteCategoryIndex(rustCampaign, { favouriteCategories: [otherGame, rust] })).toBe(1);
    expect(favouriteCategoryIndex(rustCampaign, { favouriteCategories: [rust, otherGame] })).toBe(0);
  });

  it("returns -1 without favourites, or for an unstarred category", () => {
    expect(favouriteCategoryIndex(rustCampaign, {})).toBe(-1);
    expect(favouriteCategoryIndex(rustCampaign, { favouriteCategories: [otherGame] })).toBe(-1);
  });

  it("never ranks a blocked category, even when it is also starred", () => {
    expect(favouriteCategoryIndex(rustCampaign, { favouriteCategories: [rust], blockedCategories: [rust] })).toBe(-1);
  });
});

describe("isCampaignCategoryBlocked", () => {
  const rust: CategorySelection = { id: "13", name: "Rust" };
  const otherGame: CategorySelection = { id: "21", name: "Other" };
  const rustCampaign = campaign({ categoryId: "13", gameName: "Rust" });
  const other = campaign({ categoryId: "21", gameName: "Other" });

  it("matches by id or name, and ignores an empty list", () => {
    expect(isCampaignCategoryBlocked(rustCampaign, { blockedCategories: [rust] })).toBe(true);
    expect(isCampaignCategoryBlocked(other, { blockedCategories: [rust] })).toBe(false);
    expect(isCampaignCategoryBlocked(rustCampaign, { blockedCategories: [] })).toBe(false);
  });
});
