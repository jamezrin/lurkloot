import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { AlertTriangle, Ban, GripVertical, Plus, Search } from "lucide-react";
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
  cn,
  moveById,
  useDndSensors,
} from "./primitives";

export function PlatformSettingsGroup({ platform, suggestions, settings, onFarmAllCategoriesChange, onCategoriesChange, onSearchCategories, onExcludedChannelsChange }: {
  platform: Platform;
  suggestions: GameItem[];
  settings: ExtensionSettings;
  onFarmAllCategoriesChange(farmAll: boolean): void | Promise<void>;
  onCategoriesChange(categories: CategorySelection[]): void | Promise<void>;
  onSearchCategories(query: string): Promise<CategorySelection[]>;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
}) {
  const t = useT();
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];
  const queueCount = platformSettings.watchQueueChannels.length;
  const excludedChannels = platformSettings.excludedChannels ?? [];

  return (
    <>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
        <div className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("automationSectionTitle")}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("farmOnPlatform", details.label)}</div>
          </div>
          <Pill tone={platformSettings.enabled ? "live" : "muted"}>{platformSettings.enabled ? t("enabled") : t("pausedStatus")}</Pill>
        </div>
        <div className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("watchQueueTab")}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("watchQueueEditHint", details.label)}</div>
          </div>
          <Pill tone="outline">{queueCount}/20</Pill>
        </div>
      </div>
      <ChannelListEditor
        title={t("excludedChannelsTitle")}
        description={t("excludedChannelsDescription")}
        empty={t("excludedChannelsEmpty")}
        channels={excludedChannels}
        onChange={onExcludedChannelsChange}
      />
      <div className="flex items-center gap-3 py-1">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("farmAllCategoriesTitle")}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("farmAllCategoriesDescription", details.label)}</div>
        </div>
        <Toggle checked={platformSettings.farmAllCategories} onChange={onFarmAllCategoriesChange} label={`Farm all ${details.label} categories`} />
      </div>
      {platformSettings.farmAllCategories ? null : (
        <CategoryFilterEditor
          platform={platform}
          categories={platformSettings.categories}
          suggestions={suggestions}
          onChange={onCategoriesChange}
          onSearch={onSearchCategories}
        />
      )}
    </>
  );
}

export function SettingsPlatformSwitch({ active, onChange }: { active: Platform; onChange(platform: Platform): void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {Object.entries(PLATFORMS).map(([id, platform]) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id as Platform)}
            className={cn("relative flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}
          >
            {selected && <motion.span layoutId="settings-platform-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
            <span className="relative z-10 flex h-4 w-4 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color }}>
              {platform.mark}
            </span>
            <span className="relative z-10">{platform.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChannelListEditor({ title, description, empty, channels, onChange }: {
  title: string;
  description: string;
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
    <div className="space-y-2 rounded-xl border border-zinc-200/70 p-2.5 dark:border-zinc-800">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400"><Ban size={12} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
        <Pill tone="outline">{channels.length}</Pill>
      </div>
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CategorySelection[]>([]);
  const [searching, setSearching] = useState(false);
  // onSearch is a fresh closure each render; ref it so the debounce effect can
  // depend only on the query and not re-fire on every parent render.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  const selectedIds = useMemo(() => new Set(categories.map((category) => category.id.toLowerCase())), [categories]);
  const active = categories.find((category) => category.id === activeId);
  const activeIndex = categories.findIndex((category) => category.id === activeId);
  const unaddedSuggestions = suggestions.filter((suggestion) => !selectedIds.has(suggestion.id.toLowerCase()));
  const unaddedResults = results.filter((result) => !selectedIds.has(result.id.toLowerCase()));

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
    <div className="space-y-2.5 rounded-xl border border-zinc-200/70 p-2.5 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t("categoriesToFarm")}</div>
        {categories.length > 0 ? <Pill tone="accent">{t("dragToPrioritize")}</Pill> : <Pill tone="outline">0</Pill>}
      </div>
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
          <DragOverlay dropAnimation={null}>{active ? <CompactRow isOverlay index={activeIndex} avatar={initials(active.name)} avatarStyle={{ backgroundColor: accentFor(activeIndex), color: "#fff" }} title={active.name} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<span className="w-4" />} /> : null}</DragOverlay>
        </DndContext>
      )}

      {unaddedSuggestions.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{t("hasActiveDrops")}</div>
          <div className="flex flex-wrap gap-1.5">
            {unaddedSuggestions.map((suggestion) => (
              <CategoryAddChip key={suggestion.id} name={suggestion.name} onClick={() => addCategory({ id: suggestion.id, name: suggestion.name })} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchCategories", PLATFORMS[platform].label)}
            className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-8 pr-3 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>
        {query.trim() ? (
          searching ? (
            <div className="text-[11px] text-zinc-400">{t("searching")}</div>
          ) : unaddedResults.length === 0 ? (
            <div className="text-[11px] text-zinc-400">{results.length === 0 ? t("noCategoriesFound") : t("alreadyAdded")}</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {unaddedResults.map((result) => (
                <CategoryAddChip key={result.id} name={result.name} imageUrl={result.imageUrl} onClick={() => addCategory(result)} />
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function CategoryAddChip({ name, imageUrl, onClick }: { name: string; imageUrl?: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:border-[var(--accent-ring)] hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:text-white">
      {imageUrl ? <img src={imageUrl} alt="" className="h-4 w-4 shrink-0 rounded object-cover" /> : null}
      <span className="truncate">{name}</span>
      <Plus size={12} className="shrink-0 text-zinc-400" />
    </button>
  );
}

function SortableCategoryRow({ category, index, accent, onRemove }: { category: CategorySelection; index: number; accent: string; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: category.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={initials(category.name)} avatarStyle={{ backgroundColor: accent, color: "#fff" }} title={category.name} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${category.name}`} />} trailing={<RemoveRowButton label={`Remove ${category.name}`} onClick={onRemove} />} />
    </div>
  );
}
