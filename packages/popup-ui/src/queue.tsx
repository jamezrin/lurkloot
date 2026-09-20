import React, { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Clock3, Pin, Search, X } from "lucide-react";
import type { PriorityMode } from "@lurkloot/shared/models";
import { useT } from "./context";
import { filterCampaigns } from "./campaignSearch";
import { CampaignCard, SortableCampaign, campaignRejectionMessageKey, initialExpandedIds } from "./drops";
import { fallbackGame } from "./viewModels";
import type { CampaignRankTier } from "./viewModels";
import type { CampaignView, GameItem } from "./types";
import { EmptyPanel, IconButton, SearchBox, cn, reorderFromDragEnd, type SortableDragEndEvent } from "./primitives";

// Which campaigns a facet admits. The facet reads across the queue AND the
// skipped group on purpose: with subscription campaigns turned off, "Sub badges"
// would otherwise look empty while those campaigns sat one group below.
export type QueueFacet = "all" | "drops" | "badges";

const TIER_LABEL_KEYS: Record<CampaignRankTier, string> = {
  pinned: "queueGroupPinned",
  favourite: "queueGroupFavourite",
  strategy: "queueGroupStrategy",
};

function matchesFacet(campaign: CampaignView, facet: QueueFacet): boolean {
  if (facet === "all") return true;
  return facet === "badges" ? campaign.hasSubscriptionRewards : !campaign.hasSubscriptionRewards;
}

// Where a campaign dropped at `toIndex` of the queue lands among the pins.
// Dragging pins the dragged campaign and nothing else: every campaign it passed
// keeps the tier it had, which is what stops one drag from freezing the list.
function pinPositionFor(queued: CampaignView[], campaignId: string, toIndex: number): number {
  let position = 0;
  for (let index = 0; index < toIndex && index < queued.length; index += 1) {
    const campaign = queued[index]!;
    if (campaign.id !== campaignId && campaign.pinned) position += 1;
  }
  return position;
}

export function QueuePanel({
  campaigns,
  gameMap,
  focus,
  refreshing,
  strategy,
  pinnedCount,
  farmPinnedOnly,
  onStrategyChange,
  onUnpinAll,
  onFarmPinnedOnlyChange,
  onRefreshCampaign,
  onPinChange,
  onToggleExclude,
  onOpenGames,
  onOpenSettings,
}: {
  campaigns: CampaignView[];
  gameMap: Record<string, GameItem>;
  focus?: { id: string; seq: number } | null;
  refreshing: boolean;
  strategy: PriorityMode;
  pinnedCount: number;
  farmPinnedOnly: boolean;
  onStrategyChange(strategy: PriorityMode): void | Promise<void>;
  onUnpinAll(): void | Promise<void>;
  onFarmPinnedOnlyChange(value: boolean): void | Promise<void>;
  onRefreshCampaign(id: string): void | Promise<void>;
  onPinChange(campaignId: string, position: number | null): void | Promise<void>;
  onToggleExclude(id: string): void | Promise<void>;
  onOpenGames(): void;
  onOpenSettings(): void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [facet, setFacet] = useState<QueueFacet>("all");
  const [showSkipped, setShowSkipped] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(() => initialExpandedIds(campaigns));
  const listRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  const inFacet = useMemo(() => campaigns.filter((campaign) => matchesFacet(campaign, facet)), [campaigns, facet]);
  const queued = useMemo(() => inFacet.filter((campaign) => campaign.section === "queue"), [inFacet]);
  const skipped = useMemo(() => inFacet.filter((campaign) => campaign.section === "skipped"), [inFacet]);
  const upcoming = useMemo(() => inFacet.filter((campaign) => campaign.section === "upcoming"), [inFacet]);
  const searchResults = useMemo(() => filterCampaigns(campaigns, gameMap, query), [campaigns, gameMap, query]);
  const farmingIndex = queued.findIndex((campaign) => Boolean(campaign.farmingChannel));
  const anyFarming = farmingIndex !== -1;

  // Campaigns arrive after mount, and the farmed one changes while the popup is
  // open. Expand the new one when that happens, but never collapse anything: a
  // card the user toggled by hand stays the way they left it.
  const farmingId = queued.find((campaign) => Boolean(campaign.farmingChannel))?.id;
  const autoExpandedId = useRef<string | undefined>(farmingId);
  useEffect(() => {
    if (!farmingId || farmingId === autoExpandedId.current) return;
    autoExpandedId.current = farmingId;
    setExpandedIds((current) => ({ ...current, [farmingId]: true }));
  }, [farmingId]);

  // Jump to a campaign requested from elsewhere (the "Farming {campaign}" link
  // in the status strip): clear anything that could hide the card first.
  useEffect(() => {
    if (!focus) return;
    setQuery("");
    setSearchOpen(false);
    const target = campaigns.find((campaign) => campaign.id === focus.id);
    if (target?.section === "skipped") setShowSkipped(true);
    if (target?.section === "upcoming") setShowUpcoming(true);
    setExpandedIds((current) => ({ ...current, [focus.id]: true }));
  }, [focus?.id, focus?.seq]);

  useEffect(() => {
    if (!focus || searching) return;
    const frame = requestAnimationFrame(() => {
      const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-campaign-id]");
      const card = cards && [...cards].find((node) => node.dataset.campaignId === focus.id);
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus?.id, focus?.seq, searching, showSkipped, showUpcoming]);

  const toggleExpanded = (id: string) => setExpandedIds((current) => ({ ...current, [id]: !current[id] }));
  const gameFor = (campaign: CampaignView, index: number) => gameMap[campaign.gameId] ?? fallbackGame(campaign, index, t);

  function endDrag(event: SortableDragEndEvent): void {
    const next = reorderFromDragEnd(queued, event);
    if (next === queued) return;
    const movedIndex = next.findIndex((campaign, index) => campaign.id !== queued[index]?.id);
    if (movedIndex === -1) return;
    const moved = next[movedIndex]!;
    void onPinChange(moved.id, pinPositionFor(queued, moved.id, movedIndex));
  }

  function moveCampaign(fromIndex: number, toIndex: number): void {
    const moved = queued[fromIndex];
    if (!moved) return;
    void onPinChange(moved.id, pinPositionFor(queued, moved.id, toIndex));
  }

  const tiers: CampaignRankTier[] = ["pinned", "favourite", "strategy"];

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        {searchOpen ? (
          <>
            <div className="min-w-0 flex-1">
              <SearchBox compact autoFocus value={query} onChange={setQuery} placeholder={t("campaignSearchPlaceholder")} />
            </div>
            <IconButton label={t("closeSearch")} onClick={() => { setQuery(""); setSearchOpen(false); }}>
              <X size={15} />
            </IconButton>
          </>
        ) : (
          <>
            <FacetTabs facet={facet} onChange={setFacet} />
            <div className="ms-auto flex items-center gap-1">
              <IconButton label={t("search")} onClick={() => setSearchOpen(true)}>
                <Search size={15} />
              </IconButton>
            </div>
          </>
        )}
      </div>

      {searchOpen ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {/* The strategy lives where it acts. It ranks everything no pin or
              favourite game already placed, which is what the label says. */}
          <label className="flex min-w-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            <span className="shrink-0">{t("queueStrategyLabel")}</span>
            <select
              data-queue-strategy
              aria-label={t("queueStrategyLabel")}
              value={strategy}
              onChange={(event) => void onStrategyChange(event.target.value as PriorityMode)}
              className="min-w-0 bg-transparent font-semibold text-zinc-800 outline-none dark:text-zinc-100"
            >
              <option value="ending_soonest">{t("endingSoonest")}</option>
              <option value="lowest_availability">{t("lowAvailabilityFirst")}</option>
            </select>
          </label>
          <button
            type="button"
            data-queue-pinned-only
            aria-pressed={farmPinnedOnly}
            onClick={() => void onFarmPinnedOnlyChange(!farmPinnedOnly)}
            className={cn(
              "rounded-full border px-2 py-1 text-[11px] font-medium transition-colors",
              farmPinnedOnly
                ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "border-zinc-200 text-zinc-500 hover:border-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-400",
            )}
          >
            {t("queueFarmPinnedOnly")}
          </button>
          {pinnedCount > 0 ? (
            <button
              type="button"
              data-queue-unpin-all
              onClick={() => void onUnpinAll()}
              className="ms-auto rounded-full px-2 py-1 text-[11px] font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-softer)]"
            >
              {t("queueUnpinAll", String(pinnedCount))}
            </button>
          ) : null}
        </div>
      )}

      {campaigns.length === 0 ? <EmptyPanel>{t("noCampaigns")}</EmptyPanel> : searching ? (
        searchResults.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("campaignSearchNoResults", query.trim())}</p>
        ) : (
          <div data-queue-group="search" className="space-y-1">
            {searchResults.map((campaign, index) => {
              const queueIndex = queued.findIndex((entry) => entry.id === campaign.id);
              return (
                <div key={campaign.id} data-campaign-id={campaign.id} {...(queueIndex === -1 ? {} : { "data-campaign-rank": String(queueIndex + 1) })}>
                  <CampaignCard
                    campaign={campaign}
                    index={queueIndex === -1 ? index : queueIndex}
                    farmingIndex={farmingIndex}
                    anyFarming={anyFarming}
                    game={gameFor(campaign, index)}
                    expanded={Boolean(expandedIds[campaign.id])}
                    refreshing={refreshing}
                    onToggle={() => toggleExpanded(campaign.id)}
                    onRefreshCampaign={onRefreshCampaign}
                    onToggleExclude={onToggleExclude}
                    // #564: a rank only means something among pins, so a search
                    // result can be pinned and placed without leaving the query.
                    rankCount={queued.length}
                    onRankMove={queueIndex === -1 ? undefined : (toIndex) => moveCampaign(queueIndex, toIndex)}
                    onPin={campaign.section === "queue" ? () => void onPinChange(campaign.id, campaign.pinned ? null : pinnedCount) : undefined}
                    pinned={campaign.pinned}
                  />
                </div>
              );
            })}
          </div>
        )
      ) : (
        <DragDropProvider onDragEnd={endDrag}>
          <div ref={listRef} className="space-y-1">
            {tiers.map((tier) => {
              const rows = queued.filter((campaign) => campaign.rankTier === tier);
              if (rows.length === 0) return null;
              return (
                <div key={tier} data-queue-group={tier} className="space-y-1">
                  <GroupDivider
                    label={t(TIER_LABEL_KEYS[tier])}
                    hint={tier === "strategy"
                      ? t(strategy === "lowest_availability" ? "lowAvailabilityFirst" : "endingSoonest")
                      : tier === "pinned" ? t("queueGroupPinnedHint") : undefined}
                  />
                  {rows.map((campaign) => {
                    const index = queued.indexOf(campaign);
                    return (
                      <SortableCampaign
                        key={campaign.id}
                        campaign={campaign}
                        index={index}
                        rank={index + 1}
                        farmingIndex={farmingIndex}
                        anyFarming={anyFarming}
                        game={gameFor(campaign, index)}
                        expanded={Boolean(expandedIds[campaign.id])}
                        refreshing={refreshing}
                        onToggle={() => toggleExpanded(campaign.id)}
                        onRefreshCampaign={onRefreshCampaign}
                        onToggleExclude={onToggleExclude}
                        rankCount={queued.length}
                        onRankMove={(toIndex) => moveCampaign(index, toIndex)}
                      />
                    );
                  })}
                </div>
              );
            })}

            {queued.length === 0 ? <EmptyPanel>{t(facet === "badges" ? "queueEmptyBadges" : "queueEmpty")}</EmptyPanel> : null}

            {skipped.length > 0 || upcoming.length > 0 ? <GroupDivider label={t("queueNotInQueue")} /> : null}

            {skipped.length > 0 ? (
              <Disclosure
                group="skipped"
                label={t("queueSkipped")}
                count={skipped.length}
                hint={[...new Set(skipped.map((campaign) => campaign.farmingRejection && t(campaignRejectionMessageKey(campaign.farmingRejection.code))))]
                  .filter(Boolean).slice(0, 2).join(" · ")}
                expanded={showSkipped}
                onToggle={() => setShowSkipped((current) => !current)}
              >
                {skipped.map((campaign, index) => (
                  <div key={campaign.id} data-campaign-id={campaign.id}>
                    <CampaignCard
                      campaign={campaign}
                      index={index}
                      farmingIndex={-1}
                      anyFarming={anyFarming}
                      game={gameFor(campaign, index)}
                      expanded={Boolean(expandedIds[campaign.id])}
                      refreshing={refreshing}
                      onToggle={() => toggleExpanded(campaign.id)}
                      onRefreshCampaign={onRefreshCampaign}
                      onToggleExclude={onToggleExclude}
                      fix={skippedFix(campaign, {
                        onToggleExclude,
                        onOpenGames,
                        onOpenSettings,
                        onPin: () => void onPinChange(campaign.id, pinnedCount),
                      }, t)}
                    />
                  </div>
                ))}
              </Disclosure>
            ) : null}

            {upcoming.length > 0 ? (
              <Disclosure
                group="upcoming"
                label={t("queueUpcoming")}
                count={upcoming.length}
                expanded={showUpcoming}
                onToggle={() => setShowUpcoming((current) => !current)}
              >
                {upcoming.map((campaign, index) => (
                  <div key={campaign.id} data-campaign-id={campaign.id}>
                    <CampaignCard
                      campaign={campaign}
                      index={index}
                      farmingIndex={-1}
                      anyFarming={anyFarming}
                      game={gameFor(campaign, index)}
                      expanded={Boolean(expandedIds[campaign.id])}
                      refreshing={refreshing}
                      onToggle={() => toggleExpanded(campaign.id)}
                      onRefreshCampaign={onRefreshCampaign}
                      onToggleExclude={onToggleExclude}
                    />
                  </div>
                ))}
              </Disclosure>
            ) : null}
          </div>
        </DragDropProvider>
      )}
    </section>
  );
}

// The action that puts a skipped campaign back in the queue. Every reason the
// evaluation can give either has one, or is a state the user fixes on the
// platform itself (an unlinked account), where the row explains and stops.
function skippedFix(
  campaign: CampaignView,
  handlers: { onToggleExclude(id: string): void | Promise<void>; onOpenGames(): void; onOpenSettings(): void; onPin(): void },
  t: (key: string, substitutions?: string | string[]) => string,
): { label: string; onClick(): void } | undefined {
  const code = campaign.farmingRejection?.code;
  if (!code) return undefined;
  if (code === "excluded") return { label: t("queueFixInclude"), onClick: () => void handlers.onToggleExclude(campaign.id) };
  if (code === "not_pinned") return { label: t("queueFixPin"), onClick: handlers.onPin };
  if (code === "category_blocked" || code === "category_filtered") return { label: t("queueFixGames"), onClick: handlers.onOpenGames };
  if (code === "unlinked_campaigns_disabled" || code === "subscription_campaigns_disabled" || code === "insufficient_time") {
    return { label: t("queueFixSettings"), onClick: handlers.onOpenSettings };
  }
  return undefined;
}

function FacetTabs({ facet, onChange }: { facet: QueueFacet; onChange(facet: QueueFacet): void }): React.ReactElement {
  const t = useT();
  const options: Array<[QueueFacet, string]> = [["all", "queueFacetAll"], ["drops", "queueFacetDrops"], ["badges", "queueFacetBadges"]];
  return (
    <div role="group" aria-label={t("queueFacetLabel")} className="inline-flex w-fit items-center gap-0.5 rounded-full border border-zinc-200 p-0.5 dark:border-zinc-700">
      {options.map(([value, labelKey]) => (
        <button
          key={value}
          type="button"
          data-queue-facet={value}
          aria-pressed={facet === value}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold transition",
            facet === value ? "bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200",
          )}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

// A group's label. Each divider names the layer that placed the rows under it,
// so the order is explainable without help text.
function GroupDivider({ label, hint }: { label: string; hint?: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-zinc-400 dark:text-zinc-500">{label}</span>
      {hint ? <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function Disclosure({ group, label, count, hint, expanded, onToggle, children }: {
  group: string;
  label: string;
  count: number;
  hint?: string;
  expanded: boolean;
  onToggle(): void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div data-queue-group={group} className="space-y-1">
      <button
        type="button"
        data-queue-disclosure={group}
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-200 px-2.5 py-1.5 text-start text-[11px] text-zinc-500 hover:border-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-400"
      >
        {group === "upcoming" ? <Clock3 size={12} className="shrink-0" /> : <Pin size={12} className="shrink-0" />}
        <span className="font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
        {hint ? <span className="truncate">{hint}</span> : null}
        <span className="ms-auto font-mono text-[10px] tabular">{count}</span>
        <ChevronRight size={12} className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key={`${group}-rows`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="space-y-1 overflow-hidden"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
