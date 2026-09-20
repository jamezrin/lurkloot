import React, { useMemo } from "react";
import { Ban, Check, Star } from "lucide-react";
import type { CategoryMode, CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { useT } from "./context";
import { GAME_ACCENTS, PLATFORMS } from "./constants";
import { initials } from "./format";
import { CategoryPickerCombobox } from "./settingsPlatform";
import type { GameItem } from "./types";
import { EmptyPanel, ImageWithFallback, cn } from "./primitives";

function sameCategory(left: CategorySelection, right: CategorySelection): boolean {
  return left.id.toLowerCase() === right.id.toLowerCase();
}

function contains(list: CategorySelection[], category: CategorySelection): boolean {
  return list.some((entry) => sameCategory(entry, category));
}

function without(list: CategorySelection[], category: CategorySelection): CategorySelection[] {
  return list.filter((entry) => !sameCategory(entry, category));
}

/** Which games are farmed, which rank above the strategy, and which are never
 * farmed — one screen, three states.
 *
 * The allowlist decides *whether* a game is farmed and has no order (#352);
 * favourites are the only way a category affects ranking; and blocking is the
 * single denylist, applied in both modes. Blocking suppresses a game without
 * erasing its star or its place on the allowlist, so unblocking restores
 * exactly what was there. */
export function GamesPanel({
  platform,
  settings,
  suggestions,
  campaignCounts,
  onCategoryModeChange,
  onCategoriesChange,
  onFavouritesChange,
  onBlockedChange,
  onSearchCategories,
}: {
  platform: Platform;
  settings: ExtensionSettings;
  suggestions: GameItem[];
  campaignCounts: Record<string, number>;
  onCategoryModeChange(mode: CategoryMode): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onFavouritesChange(categories: CategorySelection[]): void | Promise<void>;
  onBlockedChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
}): React.ReactElement {
  const t = useT();
  const platformSettings = settings.platform[platform];
  const { categoryMode, categories, favouriteCategories, blockedCategories } = platformSettings;
  const label = PLATFORMS[platform].label;

  // One list in both modes: the games the user picked, the games with a live
  // campaign right now, and anything starred. An allowlist mode that showed only
  // what is already selected would leave the games worth adding invisible, and
  // the picker below is for games with no campaign running at all.
  const listed = useMemo<CategorySelection[]>(() => {
    const fromSuggestions = suggestions.map((game) => ({ id: game.id, name: game.name, imageUrl: game.imageUrl }));
    const merged: CategorySelection[] = [...categories];
    for (const entry of [...fromSuggestions, ...favouriteCategories]) {
      if (!contains(merged, entry)) merged.push(entry);
    }
    return merged.filter((entry) => !contains(blockedCategories, entry));
  }, [categories, favouriteCategories, blockedCategories, suggestions]);

  const selectedIds = useMemo(
    () => new Set([...categories, ...blockedCategories].map((category) => category.id.toLowerCase())),
    [categories, blockedCategories],
  );

  function toggleFavourite(category: CategorySelection): void {
    if (contains(favouriteCategories, category)) {
      void onFavouritesChange(without(favouriteCategories, category));
      return;
    }
    void onFavouritesChange([...favouriteCategories, category]);
    // A star is also a statement that the game should be farmed, so in the
    // allowlist mode it selects the game rather than ranking something the
    // filter would then drop.
    if (categoryMode === "include" && !contains(categories, category)) {
      void onCategoriesChange([...categories, category]);
    }
  }

  function toggleSelected(category: CategorySelection): void {
    void onCategoriesChange(contains(categories, category)
      ? without(categories, category)
      : [...categories, category]);
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5">
        <div role="group" aria-label={t("categoryModeTitle")} className="inline-flex w-fit items-center gap-0.5 rounded-full border border-zinc-200 p-0.5 dark:border-zinc-700">
          {(["all", "include"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-games-mode={mode}
              aria-pressed={categoryMode === mode}
              onClick={() => void onCategoryModeChange(mode)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition",
                categoryMode === mode ? "bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200",
              )}
            >
              {t(mode === "all" ? "categoryModeAll" : "categoryModeInclude")}
            </button>
          ))}
        </div>
        <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{t("gamesStarHint")}</span>
      </div>

      {listed.length === 0 ? (
        <EmptyPanel>{t(categoryMode === "include" ? "noCategoriesSelected" : "gamesEmpty", label)}</EmptyPanel>
      ) : (
        <div className="space-y-1">
          {listed.map((category, index) => {
            const favourite = contains(favouriteCategories, category);
            const selected = categoryMode === "all" || contains(categories, category);
            const count = campaignCounts[category.id.toLowerCase()] ?? 0;
            return (
              <div
                key={category.id}
                data-game={category.id}
                className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900"
              >
                {categoryMode === "include" ? (
                  <button
                    type="button"
                    data-game-select
                    role="switch"
                    aria-checked={selected}
                    aria-label={t("gamesFarmGame", category.name)}
                    onClick={() => toggleSelected(category)}
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border",
                      selected ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]" : "border-zinc-300 text-transparent dark:border-zinc-600",
                    )}
                  >
                    <Check size={10} />
                  </button>
                ) : null}
                <div className="h-6 w-6 shrink-0 overflow-hidden rounded-md">
                  <ImageWithFallback src={category.imageUrl} alt={category.name} fit="cover" fallback={
                    <div className="flex h-full w-full items-center justify-center text-[9px] font-black text-white" style={{ backgroundColor: GAME_ACCENTS[index % GAME_ACCENTS.length] }}>
                      {initials(category.name)}
                    </div>
                  } />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">{category.name}</div>
                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                    {count === 0
                      ? t("gamesNoCampaigns")
                      : count === 1 ? t("gamesCampaignCountOne") : t("gamesCampaignCount", String(count))}
                  </div>
                </div>
                <button
                  type="button"
                  data-game-favourite
                  aria-pressed={favourite}
                  aria-label={t(favourite ? "gamesUnfavourite" : "gamesFavourite", category.name)}
                  title={t(favourite ? "gamesUnfavourite" : "gamesFavourite", category.name)}
                  onClick={() => toggleFavourite(category)}
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
                    favourite ? "text-[var(--accent-text)]" : "text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400",
                  )}
                >
                  <Star size={14} fill={favourite ? "currentColor" : "none"} />
                </button>
                <button
                  type="button"
                  data-game-block
                  aria-label={t("gamesBlock", category.name)}
                  title={t("gamesBlock", category.name)}
                  onClick={() => void onBlockedChange([...blockedCategories, category])}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-zinc-300 transition-colors hover:text-red-500 dark:text-zinc-600"
                >
                  <Ban size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <CategoryPickerCombobox
        platform={platform}
        suggestions={suggestions}
        selectedIds={selectedIds}
        onSearch={onSearchCategories}
        onSelect={(category) => {
          if (categoryMode === "include") toggleSelected(category);
          else toggleFavourite(category);
        }}
      />

      <div className="space-y-1 pt-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-zinc-400 dark:text-zinc-500">{t("gamesBlocked")}</span>
          <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{t("gamesBlockedHint")}</span>
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
        {blockedCategories.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-200 px-2.5 py-2 text-[11px] leading-snug text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            {t("gamesBlockedEmpty")}
          </p>
        ) : null}
          {blockedCategories.map((category) => (
            <div
              key={category.id}
              data-blocked-game={category.id}
              className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-200 px-2 py-1.5 dark:border-zinc-700"
            >
              <Ban size={13} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">{category.name}</div>
                <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                  {contains(favouriteCategories, category) ? t("gamesBlockedKeepsStar") : t("gamesBlockedHint")}
                </div>
              </div>
              <button
                type="button"
                data-game-unblock
                onClick={() => void onBlockedChange(without(blockedCategories, category))}
                className="shrink-0 rounded-full border border-[var(--accent-ring)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-softer)]"
              >
                {t("gamesUnblock")}
              </button>
            </div>
          ))}
      </div>
    </section>
  );
}
