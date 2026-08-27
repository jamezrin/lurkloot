import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, GripVertical, Plus, Search } from "lucide-react";
import type { CategorySelection, ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { GAME_ACCENTS, PLATFORMS } from "./constants";
import { useT } from "./context";
import { initials } from "./format";
import type { GameItem } from "./types";
import {
  CompactRow,
  DragHandle,
  Pill,
  RemoveRowButton,
  Toggle,
  moveById,
  useDndSensors,
  preventNativeDrag,
} from "./primitives";

export function PlatformCategorySettings({ platform, suggestions, settings, onFarmAllCategoriesChange, onCategoriesChange, onSearchCategories }: {
  platform: Platform;
  suggestions: GameItem[];
  settings: ExtensionSettings;
  onFarmAllCategoriesChange(farmAll: boolean): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
}) {
  const t = useT();
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];

  return (
    <>
      <div className="flex items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("farmAllCategoriesTitle")}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("farmAllCategoriesDescription", details.label)}</div>
        </div>
        <Toggle checked={platformSettings.farmAllCategories} onChange={onFarmAllCategoriesChange} label={t("farmAllCategoriesTitle")} />
      </div>
      {platformSettings.farmAllCategories ? null : (
        <div className="py-2">
          <CategoryFilterEditor
            platform={platform}
            categories={platformSettings.categories}
            suggestions={suggestions}
            onChange={onCategoriesChange}
            onSearch={onSearchCategories}
          />
        </div>
      )}
    </>
  );
}

export function PlatformExcludedChannels({ platform, settings, onExcludedChannelsChange }: {
  platform: Platform;
  settings: ExtensionSettings;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  return (
    <div className="py-2">
      <ChannelListEditor
        empty={t("excludedChannelsEmpty")}
        channels={settings.platform[platform].excludedChannels ?? []}
        onChange={onExcludedChannelsChange}
      />
    </div>
  );
}

// Renders bare: the enclosing SettingsGroup supplies the heading, the
// description and the channel count.
function ChannelListEditor({ empty, channels, onChange }: {
  empty: string;
  channels: string[];
  onChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  function addChannel(): void {
    const username = value.trim().replace(/^@+/, "").toLowerCase();
    if (!username || channels.includes(username)) {
      setValue("");
      setAdding(false);
      return;
    }
    void onChange([...channels, username]);
    setValue("");
    setAdding(false);
  }

  function removeChannel(username: string): void {
    void onChange(channels.filter((channel) => channel !== username));
  }

  return (
    <div className="space-y-2">
      {channels.length === 0 ? <div className="text-[11px] text-zinc-400">{empty}</div> : (
        <div className="flex flex-wrap gap-1.5">
          {channels.map((channel) => (
            <span key={channel} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              <span className="truncate">{channel}</span>
              <RemoveRowButton label={t("removeItem", channel)} onClick={() => removeChannel(channel)} />
            </span>
          ))}
        </div>
      )}
      {adding ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("channelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <button type="submit" className="rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)]">{t("add")}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200">
          <Plus size={14} /> {t("addChannel")}
        </button>
      )}
    </div>
  );
}

// The category allowlist editor shown when "Farm all categories" is off. The
// list is reorderable (order = farming priority); categories are added via
// drop-aware quick suggestions (no network) or a debounced live search.
function CategoryFilterEditor({ platform, categories, suggestions, onChange, onSearch }: {
  platform: Platform;
  categories: CategorySelection[];
  suggestions: GameItem[];
  onChange(categories: CategorySelection[]): void | Promise<void>;
  onSearch(query: string): Promise<CategorySelection[]>;
}) {
  const t = useT();
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);

  const selectedIds = useMemo(() => new Set(categories.map((category) => category.id.toLowerCase())), [categories]);
  const active = categories.find((category) => category.id === activeId);
  const activeIndex = categories.findIndex((category) => category.id === activeId);

  function addCategory(category: CategorySelection): void {
    if (selectedIds.has(category.id.toLowerCase())) return;
    void onChange([...categories, category]);
  }

  function endDrag(event: DragEndEvent): void {
    setActiveId(null);
    const from = String(event.active.id);
    const over = event.over?.id == null ? undefined : String(event.over.id);
    if (!over || from === over) return;
    void onChange(moveById(categories, from, over));
  }

  const accentFor = (index: number): string => GAME_ACCENTS[index % GAME_ACCENTS.length];

  return (
    <div className="space-y-2.5">
      {/* The group header carries the label and the count; only the reordering
          hint is left, and it only means anything once there is a list. */}
      {categories.length > 0 ? (
        <div className="flex justify-end"><Pill tone="accent">{t("dragToPrioritize")}</Pill></div>
      ) : null}
      {categories.length === 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{t("noCategoriesSelected", PLATFORMS[platform].label)}</span>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
          <SortableContext items={categories.map((category) => category.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">{categories.map((category, index) => <SortableCategoryRow key={category.id} category={category} index={index} accent={accentFor(index)} onRemove={() => void onChange(categories.filter((entry) => entry.id !== category.id))} />)}</div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>{active ? <CompactRow isOverlay index={activeIndex} avatar={initials(active.name)} avatarImageUrl={active.imageUrl} avatarStyle={{ backgroundColor: accentFor(activeIndex), color: "#fff" }} title={active.name} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<span className="w-4" />} /> : null}</DragOverlay>
        </DndContext>
      )}

      <CategoryPickerCombobox platform={platform} suggestions={suggestions} selectedIds={selectedIds} onSearch={onSearch} onSelect={addCategory} />
    </div>
  );
}

// Combobox-style category picker: a single search input that opens a
// popover listbox on focus, grouped into categories with active drops
// (already loaded, no network) and other categories (from a debounced live
// search). Collapses when not focused so a long active-drops list doesn't
// dominate the settings screen (issue #326).
function CategoryPickerCombobox({ platform, suggestions, selectedIds, onSearch, onSelect }: {
  platform: Platform;
  suggestions: GameItem[];
  selectedIds: Set<string>;
  onSearch(query: string): Promise<CategorySelection[]>;
  onSelect(category: CategorySelection): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CategorySelection[]>([]);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // onSearch is a fresh closure each render; ref it so the debounce effect can
  // depend only on the query and not re-fire on every parent render.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  const trimmedQuery = query.trim();
  const unaddedSuggestions = useMemo(
    () => suggestions.filter((suggestion) => !selectedIds.has(suggestion.id.toLowerCase())),
    [suggestions, selectedIds],
  );
  const activeDropsMatches = trimmedQuery
    ? unaddedSuggestions.filter((suggestion) => suggestion.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : unaddedSuggestions;
  const activeDropIds = useMemo(() => new Set(activeDropsMatches.map((item) => item.id.toLowerCase())), [activeDropsMatches]);
  const otherResults = results.filter((result) => !selectedIds.has(result.id.toLowerCase()) && !activeDropIds.has(result.id.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      // Use composedPath() rather than event.target: the popup can render
      // inside a shadow root (e.g. the site's live demo), and shadow
      // boundaries retarget .target on composed events like mousedown to the
      // shadow host, which breaks a plain .contains() containment check.
      if (containerRef.current && !event.composedPath().includes(containerRef.current)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void searchRef.current(trimmed)
        .then((found) => { if (!cancelled) setResults(found); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  function select(category: CategorySelection): void {
    onSelect(category);
    setQuery("");
    setOpen(false);
  }

  const showActiveDrops = activeDropsMatches.length > 0;
  const showOther = trimmedQuery.length > 0;
  const isEmpty = !showActiveDrops && (!showOther || (!searching && otherResults.length === 0));

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          placeholder={t("searchCategories", PLATFORMS[platform].label)}
          className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-8 pr-3 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>
      {open ? (
        <div className="absolute inset-x-0 top-full z-10 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {showActiveDrops ? (
            <CategoryPickerGroup label={t("hasActiveDrops")} items={activeDropsMatches} onSelect={select} />
          ) : null}
          {showOther ? (
            searching ? (
              <div className="px-2 py-1.5 text-[11px] text-zinc-400">{t("searching")}</div>
            ) : otherResults.length > 0 ? (
              <CategoryPickerGroup label={t("otherCategories")} items={otherResults} onSelect={select} />
            ) : null
          ) : null}
          {isEmpty ? <div className="px-2 py-1.5 text-[11px] text-zinc-400">{t("noCategoriesFound")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryPickerGroup({ label, items, onSelect }: {
  label: string;
  items: (CategorySelection | GameItem)[];
  onSelect(category: CategorySelection): void;
}) {
  return (
    <div className="space-y-0.5 py-1 first:pt-0">
      <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect({ id: item.id, name: item.name, ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}) })}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-4 w-4 shrink-0 rounded object-cover" /> : null}
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <Plus size={12} className="shrink-0 text-zinc-400" />
        </button>
      ))}
    </div>
  );
}

function SortableCategoryRow({ category, index, accent, onRemove }: { category: CategorySelection; index: number; accent: string; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: category.id });
  return (
    <div ref={setNodeRef} onDragStart={preventNativeDrag} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={initials(category.name)} avatarImageUrl={category.imageUrl} avatarStyle={{ backgroundColor: accent, color: "#fff" }} title={category.name} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${category.name}`} />} trailing={<RemoveRowButton label={`Remove ${category.name}`} onClick={onRemove} />} />
    </div>
  );
}
