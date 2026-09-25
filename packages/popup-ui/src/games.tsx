import React, { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Plus, Search, Star } from "lucide-react";
import type { CategoryMode, CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { useT } from "./context";
import { ViewToolbar } from "./viewToolbar";
import { GAME_ACCENTS, PLATFORMS } from "./constants";
import { initials } from "./format";
import type { GameItem } from "./types";
import { EmptyPanel, ImageWithFallback, cn } from "./primitives";

import { containsCategory as contains, favouriteTogglePatch, sameCategory, withoutCategory as without } from "./categoryActions";
import { Checkbox, Segmented } from "./controls";
import { Tip } from "./tooltip";

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

  // Favourites first, in the order they rank, then everything else as listed:
  // the order on screen is the order the stars apply in.
  const ordered = useMemo(() => {
    const favourites = favouriteCategories
      .map((favourite) => listed.find((entry) => sameCategory(entry, favourite)))
      .filter((entry): entry is CategorySelection => Boolean(entry));
    const others = listed.filter((entry) => !contains(favouriteCategories, entry));
    return [
      ...favourites.map((category, index) => ({ category, index, first: index === 0 ? "favourites" as const : undefined })),
      ...others.map((category, index) => ({ category, index: favourites.length + index, first: index === 0 ? "others" as const : undefined })),
    ];
  }, [listed, favouriteCategories]);

  const [query, setQuery] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const needle = query.trim().toLowerCase();
  const matches = React.useCallback((category: CategorySelection) => !needle || category.name.toLowerCase().includes(needle), [needle]);
  // Dividers come from what is on screen, so a group the search empties loses
  // its heading too.
  const visible = useMemo(() => {
    const shown = ordered.filter(({ category }) => matches(category));
    const favourite = (category: CategorySelection) => contains(favouriteCategories, category);
    return shown.map((entry, position) => ({
      ...entry,
      first: position === 0 || favourite(shown[position - 1]!.category) !== favourite(entry.category)
        ? favourite(entry.category) ? "favourites" as const : "others" as const
        : undefined,
    }));
  }, [ordered, matches, favouriteCategories]);
  const blockedMatches = blockedCategories.filter(matches);
  const remote = useCategorySearch(needle ? query.trim() : "", onSearchCategories);
  // Games from the platform's own search that are not on screen already.
  const addable = remote.results.filter((result) => !contains(listed, result) && !contains(blockedCategories, result));

  function addGame(category: CategorySelection): void {
    if (categoryMode === "include") toggleSelected(category);
    else toggleFavourite(category);
    setQuery("");
  }

  function toggleFavourite(category: CategorySelection): void {
    const patch = favouriteTogglePatch(platformSettings, category);
    if (patch.favouriteCategories) void onFavouritesChange(patch.favouriteCategories);
    if (patch.categories) void onCategoriesChange(patch.categories);
  }

  function toggleSelected(category: CategorySelection): void {
    void onCategoriesChange(contains(categories, category)
      ? without(categories, category)
      : [...categories, category]);
  }

  const blockedList = (entries: CategorySelection[]) => entries.map((category) => (
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
        className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-[10px] font-semibold text-zinc-800 hover:bg-[var(--ink-soft)] dark:border-zinc-700 dark:text-zinc-100"
      >
        {t("gamesUnblock")}
      </button>
    </div>
  ));

  return (
    <section className="space-y-2">
      <ViewToolbar>
        <Segmented
          label={t("categoryModeTitle")}
          value={categoryMode}
          itemAttribute="data-games-mode"
          options={(["all", "include"] as const).map((mode) => ({ value: mode, label: t(mode === "all" ? "categoryModeAll" : "categoryModeInclude") }))}
          onChange={(mode) => void onCategoryModeChange(mode)}
        />
      </ViewToolbar>

      {/* What the mode does and what the row buttons mean, said once, up top. */}
      <p data-games-mode-description className="px-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {t(categoryMode === "all" ? "gamesModeAllDescription" : "gamesModeIncludeDescription")}{" "}
        <span className="whitespace-nowrap"><Star size={10} className="inline -translate-y-px" aria-hidden /> {t("gamesStarLegend")}</span>{" · "}
        <span className="whitespace-nowrap"><Ban size={10} className="inline -translate-y-px" aria-hidden /> {t("gamesBlockLegend")}</span>
      </p>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="search"
            data-games-search
            value={query}
            onChange={(event) => { setQuery(event.target.value); setShowBlocked(false); }}
            aria-label={t("gamesSearchPlaceholder", label)}
            placeholder={t("gamesSearchPlaceholder", label)}
            className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pe-2 ps-8 text-xs font-medium text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>
        {/* A view of the list, not a setting, so it looks like a chip rather
            than a second copy of the mode switch above. */}
        <button
          type="button"
          data-games-show-blocked
          aria-pressed={showBlocked}
          onClick={() => { setShowBlocked(!showBlocked); setQuery(""); }}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            showBlocked
              ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--ink-contrast)]"
              : "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100",
          )}
        >
          <Ban size={11} aria-hidden />
          {t("gamesBlocked")}
          <span className="font-mono text-[10px] tabular opacity-70">{blockedCategories.length}</span>
        </button>
      </div>

      {showBlocked ? (
        <div className="space-y-1">
          {blockedCategories.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 px-2.5 py-2 text-[11px] leading-snug text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
              {t("gamesBlockedEmpty")}
            </p>
          ) : blockedList(blockedCategories)}
        </div>
      ) : (
        <>
          {listed.length === 0 && !needle ? (
            <EmptyPanel>{t(categoryMode === "include" ? "noCategoriesSelected" : "gamesEmpty", label)}</EmptyPanel>
          ) : (
            <div className="space-y-1">
              {visible.map(({ category, index, first }) => {
                const favourite = contains(favouriteCategories, category);
                const favouriteRank = favouriteCategories.findIndex((entry) => sameCategory(entry, category));
                const selected = categoryMode === "all" || contains(categories, category);
                const count = campaignCounts[category.id.toLowerCase()] ?? 0;
                return (
                  <React.Fragment key={category.id}>
                  {first ? <GamesDivider label={t(first === "favourites" ? "gamesFavouritesGroup" : "gamesOtherGroup")} hint={t(first === "favourites" ? "gamesFavouritesGroupHint" : categoryMode === "all" ? "gamesOtherGroupAllHint" : "gamesOtherGroupIncludeHint")} /> : null}
                  <div
                    data-game={category.id}
                    className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    {categoryMode === "include" ? (
                      <Checkbox
                        checked={selected}
                        onChange={() => toggleSelected(category)}
                        label={t("gamesFarmGame", category.name)}
                        attributes={{ "data-game-select": "" }}
                      />
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
                    <Tip label={t(favourite ? "gamesUnfavourite" : "gamesFavourite", category.name)}>
                      <button
                        type="button"
                        data-game-favourite
                        aria-pressed={favourite}
                        aria-label={t(favourite ? "gamesUnfavourite" : "gamesFavourite", category.name)}
                        onClick={() => toggleFavourite(category)}
                        className={cn(
                          "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
                          favourite ? "text-amber-500 dark:text-amber-400" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
                        )}
                      >
                        <Star size={14} fill={favourite ? "currentColor" : "none"} />
                      </button>
                    </Tip>
                    <span data-game-favourite-rank className="-ms-1.5 w-2 shrink-0 font-mono text-[10px] font-semibold text-zinc-500 tabular dark:text-zinc-400">
                      {favourite && favouriteRank !== -1 ? favouriteRank + 1 : ""}
                    </span>
                    <Tip label={t("gamesBlock", category.name)}>
                      <button
                        type="button"
                        data-game-block
                        aria-label={t("gamesBlock", category.name)}
                        onClick={() => void onBlockedChange([...blockedCategories, category])}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      >
                        <Ban size={14} />
                      </button>
                    </Tip>
                  </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          {needle && blockedMatches.length > 0 ? (
            <div className="space-y-1">
              <GamesDivider label={t("gamesBlocked")} hint={t("gamesBlockedHint")} />
              {blockedList(blockedMatches)}
            </div>
          ) : null}

          {/* Games with no campaign on screen come from the platform's own
              search, each with the one thing adding it does in this mode. */}
          {needle ? (
            <div data-games-add-results className="space-y-1">
              <GamesDivider label={t("gamesAddGroup", label)} hint={t(categoryMode === "include" ? "gamesAddIncludeHint" : "gamesAddAllHint")} />
              {remote.searching ? (
                <p className="px-1 py-1 text-[11px] text-zinc-400">{t("searching")}</p>
              ) : addable.length === 0 ? (
                <p className="px-1 py-1 text-[11px] text-zinc-400">{t(visible.length === 0 && blockedMatches.length === 0 ? "noCategoriesFound" : "gamesNoMoreResults")}</p>
              ) : addable.map((category) => (
                <div key={category.id} data-game-result={category.id} className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
                  <div className="h-6 w-6 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
                    {category.imageUrl ? <img src={category.imageUrl} alt="" className="h-full w-full object-cover" /> : null}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-[12px] font-semibold text-zinc-700 dark:text-zinc-200">{category.name}</div>
                  <button
                    type="button"
                    data-game-add
                    onClick={() => addGame(category)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-[10px] font-semibold text-zinc-800 hover:bg-[var(--ink-soft)] dark:border-zinc-700 dark:text-zinc-100"
                  >
                    {categoryMode === "include" ? <Plus size={11} aria-hidden /> : <Star size={11} aria-hidden />}
                    {t(categoryMode === "include" ? "gamesAddActionFarm" : "gamesAddActionFavourite")}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The platform's category search for `query`, debounced, dropping answers to
 * queries the user has already typed past. */
function useCategorySearch(query: string, onSearch: (query: string) => Promise<CategorySelection[]>): { results: CategorySelection[]; searching: boolean } {
  const [results, setResults] = useState<CategorySelection[]>([]);
  const [searching, setSearching] = useState(false);
  // onSearch is a fresh closure each render; ref it so the debounce depends on
  // the query alone.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  useEffect(() => {
    if (!query) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void searchRef.current(query)
        .then((found) => { if (!cancelled) setResults(found); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);
  return { results, searching };
}

function GamesDivider({ label, hint }: { label: string; hint: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span>
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
