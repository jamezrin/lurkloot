import type { CategorySelection, DropCampaign } from "./models";

// Sentinel id for the synthetic "No category" selection. Some drop campaigns
// carry no game/category at all (e.g. Kick's org-wide event drops, where the
// reward category_id is 0). They are real and farmable, so we let users pick
// this pseudo-category to farm exactly those. The value is namespaced so it can
// never collide with a real platform category id or name.
export const NO_CATEGORY_ID = "__none__";

// A campaign has no category when it carries neither a category id nor a game
// name. Such a campaign only ever matches the "No category" selection.
export function isUncategorizedCampaign(campaign: Pick<DropCampaign, "categoryId" | "gameName">): boolean {
  return !campaign.categoryId && !campaign.gameName;
}

// Position of a campaign's category in a selection list, by id or name
// (case-insensitive); -1 when absent. Campaigns sometimes carry only a gameName.
// An uncategorized campaign matches only the synthetic NO_CATEGORY_ID entry.
export function categoryListIndex(campaign: DropCampaign, list: CategorySelection[]): number {
  if (list.length === 0) return -1;
  const candidates = [campaign.categoryId, campaign.gameName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (candidates.length === 0) return list.findIndex((category) => category.id === NO_CATEGORY_ID);
  return list.findIndex((category) =>
    candidates.includes(category.id.toLowerCase()) || candidates.includes(category.name.toLowerCase()));
}
