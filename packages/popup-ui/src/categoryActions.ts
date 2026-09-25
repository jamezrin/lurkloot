import type { CategorySelection, PlatformSettings } from "@lurkloot/shared/models";

// Starring and blocking a game, written once so the Games view and a campaign
// row cannot drift apart on what those actions change.

export function sameCategory(left: CategorySelection, right: CategorySelection): boolean {
  return left.id.toLowerCase() === right.id.toLowerCase();
}

export function containsCategory(list: CategorySelection[], category: CategorySelection): boolean {
  return list.some((entry) => sameCategory(entry, category));
}

export function withoutCategory(list: CategorySelection[], category: CategorySelection): CategorySelection[] {
  return list.filter((entry) => !sameCategory(entry, category));
}

type CategoryLists = Pick<PlatformSettings, "categoryMode" | "categories" | "favouriteCategories" | "blockedCategories">;

/** Star or unstar a game. A star is also a statement that the game should be
 * farmed, so in the allowlist mode starring selects the game rather than
 * ranking something the filter would then drop. Unstarring leaves the
 * selection alone. */
export function favouriteTogglePatch(lists: CategoryLists, category: CategorySelection): Partial<CategoryLists> {
  if (containsCategory(lists.favouriteCategories, category)) {
    return { favouriteCategories: withoutCategory(lists.favouriteCategories, category) };
  }
  const patch: Partial<CategoryLists> = { favouriteCategories: [...lists.favouriteCategories, category] };
  if (lists.categoryMode === "include" && !containsCategory(lists.categories, category)) {
    patch.categories = [...lists.categories, category];
  }
  return patch;
}

/** Block or unblock a game. Blocking touches only the denylist: the game keeps
 * its star and its place on the allowlist, so unblocking restores exactly what
 * was there. */
export function blockTogglePatch(lists: CategoryLists, category: CategorySelection): Partial<CategoryLists> {
  return {
    blockedCategories: containsCategory(lists.blockedCategories, category)
      ? withoutCategory(lists.blockedCategories, category)
      : [...lists.blockedCategories, category],
  };
}
