import React, { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Clock3, Pin } from "lucide-react";
import type { CategorySelection, PriorityMode } from "@lurkloot/shared/models";
import { useT } from "./context";
import { filterCampaigns } from "./campaignSearch";
import { CampaignCard, SortableCampaign, campaignRejectionMessageKey, initialExpandedIds } from "./drops";
import { fallbackGame } from "./viewModels";
import type { CampaignRankTier } from "./viewModels";
import type { CampaignView, GameItem } from "./types";
import { ViewToolbar } from "./viewToolbar";
import { EmptyPanel, SearchBox, Toggle, cn, reorderFromDragEnd, scrollIntoPanel, type SortableDragEndEvent } from "./primitives";

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
  onToggleFavouriteCategory,
  onToggleBlockedCategory,
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
  onToggleFavouriteCategory?(category: CategorySelection): void | Promise<void>;
  onToggleBlockedCategory?(category: CategorySelection): void | Promise<void>;
  onOpenGames(): void;
  onOpenSettings(): void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState("");
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
      scrollIntoPanel(card, "smooth");
    });
    return () => cancelAnimationFrame(frame);
  }, [focus?.id, focus?.seq, searching, showSkipped, showUpcoming]);

  // Every row gets the same actions object for the life of the panel, and each
  // action reads the latest props through a ref. Rows are memoised, so a row
  // re-renders only when something it shows changed — not because the parent
  // re-rendered and minted a fresh arrow for every card.
  const latest = useRef({ queued, pinnedCount, onPinChange, onToggleExclude, onRefreshCampaign, onToggleFavouriteCategory, onToggleBlockedCategory, onOpenGames, onOpenSettings });
  latest.current = { queued, pinnedCount, onPinChange, onToggleExclude, onRefreshCampaign, onToggleFavouriteCategory, onToggleBlockedCategory, onOpenGames, onOpenSettings };
  const actions = useMemo<RowActions>(() => ({
    toggle: (id) => setExpandedIds((current) => ({ ...current, [id]: !current[id] })),
    refresh: (id) => void latest.current.onRefreshCampaign(id),
    toggleExclude: (id) => void latest.current.onToggleExclude(id),
    togglePin: (campaign) => void latest.current.onPinChange(campaign.id, campaign.pinned ? null : latest.current.pinnedCount),
    pinLast: (id) => void latest.current.onPinChange(id, latest.current.pinnedCount),
    rankMove: (id, toIndex) => {
      const current = latest.current.queued;
      if (current.some((campaign) => campaign.id === id)) void latest.current.onPinChange(id, pinPositionFor(current, id, toIndex));
    },
    favourite: (category) => void latest.current.onToggleFavouriteCategory?.(category),
    block: (category) => void latest.current.onToggleBlockedCategory?.(category),
    openGames: () => latest.current.onOpenGames(),
    openSettings: () => latest.current.onOpenSettings(),
  }), []);
  const categoryActions = { canFavourite: Boolean(onToggleFavouriteCategory), canBlock: Boolean(onToggleBlockedCategory) };

  // Stable for the same reason as the row actions: the drag provider hands its
  // handler to every sortable card, so a fresh one per render re-rendered them all.
  const endDrag = React.useCallback((event: SortableDragEndEvent): void => {
    const current = latest.current.queued;
    const next = reorderFromDragEnd(current, event);
    if (next === current) return;
    const movedIndex = next.findIndex((campaign, index) => campaign.id !== current[index]?.id);
    if (movedIndex === -1) return;
    const moved = next[movedIndex]!;
    void latest.current.onPinChange(moved.id, pinPositionFor(current, moved.id, movedIndex));
  }, []);

  const tiers: CampaignRankTier[] = ["pinned", "favourite", "strategy"];
  const facetCounts: Record<QueueFacet, number> = {
    all: campaigns.filter((campaign) => campaign.section === "queue").length,
    drops: campaigns.filter((campaign) => campaign.section === "queue" && matchesFacet(campaign, "drops")).length,
    badges: campaigns.filter((campaign) => campaign.section === "queue" && matchesFacet(campaign, "badges")).length,
  };

  // The layer of the ranking that placed a queued campaign, in words: the
  // card shows it among its facts so the order never has to be guessed.
  function rankReason(campaign: CampaignView): string {
    if (campaign.rankTier === "pinned" && campaign.pinIndex != null) return t("rankReasonPinned", String(campaign.pinIndex + 1));
    if (campaign.rankTier === "favourite" && campaign.favouriteIndex != null) {
      return t("rankReasonFavourite", [campaign.category?.name ?? gameMap[campaign.gameId]?.name ?? campaign.title, String(campaign.favouriteIndex + 1)]);
    }
    return t(strategy === "lowest_availability" ? "rankReasonAvailability" : "rankReasonEnding");
  }


  return (
    <section className="space-y-1.5">
      <ViewToolbar>
        <FacetTabs facet={facet} counts={facetCounts} onChange={setFacet} />
        {/* The strategy lives where it acts. It ranks everything no pin or
            favourite game already placed, which is what the label says. */}
        <label className="ms-auto flex min-w-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
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
      </ViewToolbar>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SearchBox compact value={query} onChange={setQuery} placeholder={t("campaignSearchPlaceholder")} />
        </div>
        <label data-queue-pinned-only className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          <Toggle size="sm" checked={farmPinnedOnly} onChange={(value) => void onFarmPinnedOnlyChange(value)} label={t("queueFarmPinnedOnly")} />
          <span aria-hidden>{t("queueFarmPinnedOnly")}</span>
        </label>
      </div>

      {campaigns.length === 0 ? <EmptyPanel>{t("noCampaigns")}</EmptyPanel> : searching ? (
        searchResults.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">{t("campaignSearchNoResults", query.trim())}</p>
        ) : (
          <div data-queue-group="search" className="space-y-1">
            {searchResults.map((campaign, index) => {
              const queueIndex = queued.findIndex((entry) => entry.id === campaign.id);
              return (
                <div key={campaign.id} data-campaign-id={campaign.id} {...(queueIndex === -1 ? {} : { "data-campaign-rank": String(queueIndex + 1) })}>
                  <QueueRow
                    kind="search"
                    campaign={campaign}
                    index={queueIndex === -1 ? index : queueIndex}
                    farmingIndex={farmingIndex}
                    anyFarming={anyFarming}
                    game={gameMap[campaign.gameId]}
                    expanded={Boolean(expandedIds[campaign.id])}
                    refreshing={refreshing}
                    // #564: a rank only means something among pins, so a search
                    // result can be pinned and placed without leaving the query.
                    rankCount={queued.length}
                    rankReason={campaign.section === "queue" ? rankReason(campaign) : undefined}
                    actions={actions}
                    {...categoryActions}
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
                    action={tier === "pinned" && pinnedCount > 0
                      ? { label: t("queueUnpinAll", String(pinnedCount)), onClick: () => void onUnpinAll(), attribute: "data-queue-unpin-all" }
                      : tier === "favourite" ? { label: t("queueEditFavourites"), onClick: onOpenGames } : undefined}
                  />
                  {rows.map((campaign) => {
                    const index = queued.indexOf(campaign);
                    return (
                      <QueueRow
                        key={campaign.id}
                        kind="sortable"
                        campaign={campaign}
                        index={index}
                        farmingIndex={farmingIndex}
                        anyFarming={anyFarming}
                        game={gameMap[campaign.gameId]}
                        expanded={Boolean(expandedIds[campaign.id])}
                        refreshing={refreshing}
                        rankCount={queued.length}
                        rankReason={rankReason(campaign)}
                        actions={actions}
                        {...categoryActions}
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
                    <QueueRow
                      kind="skipped"
                      campaign={campaign}
                      index={index}
                      farmingIndex={-1}
                      anyFarming={anyFarming}
                      game={gameMap[campaign.gameId]}
                      expanded={Boolean(expandedIds[campaign.id])}
                      refreshing={refreshing}
                      actions={actions}
                      {...categoryActions}
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
                    <QueueRow
                      kind="upcoming"
                      campaign={campaign}
                      index={index}
                      farmingIndex={-1}
                      anyFarming={anyFarming}
                      game={gameMap[campaign.gameId]}
                      expanded={Boolean(expandedIds[campaign.id])}
                      refreshing={refreshing}
                      actions={actions}
                      {...categoryActions}
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

type RowActions = {
  toggle(id: string): void;
  refresh(id: string): void;
  toggleExclude(id: string): void;
  togglePin(campaign: CampaignView): void;
  pinLast(id: string): void;
  rankMove(id: string, toIndex: number): void;
  favourite(category: CategorySelection): void;
  block(category: CategorySelection): void;
  openGames(): void;
  openSettings(): void;
};

/** One campaign row in the queue, in whichever group it sits. Memoised: its
 * props are the campaign view (kept across polls when unchanged), plain
 * values and the panel's stable actions, so opening one card or a poll with
 * nothing new re-renders no other row. */
const QueueRow = React.memo(function QueueRow({ kind, campaign, index, farmingIndex, anyFarming, game, expanded, refreshing, rankCount, rankReason, actions, canFavourite, canBlock }: {
  kind: "search" | "sortable" | "skipped" | "upcoming";
  campaign: CampaignView;
  index: number;
  farmingIndex: number;
  anyFarming: boolean;
  game?: GameItem;
  expanded: boolean;
  refreshing: boolean;
  rankCount?: number;
  rankReason?: string;
  actions: RowActions;
  canFavourite: boolean;
  canBlock: boolean;
}): React.ReactElement {
  const t = useT();
  const queued = campaign.section === "queue";
  const props = {
    campaign,
    index,
    farmingIndex,
    anyFarming,
    game: game ?? fallbackGame(campaign, index, t),
    expanded,
    refreshing,
    onToggle: () => actions.toggle(campaign.id),
    onRefreshCampaign: actions.refresh,
    onToggleExclude: actions.toggleExclude,
    onToggleFavouriteCategory: canFavourite ? actions.favourite : undefined,
    onToggleBlockedCategory: canBlock ? actions.block : undefined,
  };
  if (kind === "sortable") {
    return (
      <SortableCampaign
        {...props}
        rank={index + 1}
        rankCount={rankCount}
        onRankMove={(toIndex) => actions.rankMove(campaign.id, toIndex)}
        pinned={campaign.pinned}
        onPin={() => actions.togglePin(campaign)}
        rankReason={rankReason}
      />
    );
  }
  if (kind === "search") {
    return (
      <CampaignCard
        {...props}
        rankCount={rankCount}
        onRankMove={queued ? (toIndex) => actions.rankMove(campaign.id, toIndex) : undefined}
        onPin={queued ? () => actions.togglePin(campaign) : undefined}
        pinned={campaign.pinned}
        rankReason={rankReason}
      />
    );
  }
  if (kind === "skipped") {
    return (
      <CampaignCard
        {...props}
        fix={skippedFix(campaign, {
          onToggleExclude: actions.toggleExclude,
          onOpenGames: actions.openGames,
          onOpenSettings: actions.openSettings,
          onPin: () => actions.pinLast(campaign.id),
        }, t)}
      />
    );
  }
  return <CampaignCard {...props} />;
});

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

function FacetTabs({ facet, counts, onChange }: { facet: QueueFacet; counts: Record<QueueFacet, number>; onChange(facet: QueueFacet): void }): React.ReactElement {
  const t = useT();
  const options: Array<[QueueFacet, string]> = [["all", "queueFacetAll"], ["drops", "queueFacetDrops"], ["badges", "queueFacetBadges"]];
  return (
    <div role="group" aria-label={t("queueFacetLabel")} className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-zinc-800 dark:bg-black/30">
      {options.map(([value, labelKey]) => (
        <button
          key={value}
          type="button"
          data-queue-facet={value}
          aria-pressed={facet === value}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[10px] font-semibold transition",
            facet === value ? "bg-[var(--ink)] text-[var(--ink-contrast)]" : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200",
          )}
        >
          {t(labelKey)}
          <span className={cn("ms-1 font-mono text-[9.5px] tabular", facet === value ? "opacity-70" : "text-zinc-400 dark:text-zinc-500")}>{counts[value]}</span>
        </button>
      ))}
    </div>
  );
}

// A group's label. Each divider names the layer that placed the rows under it,
// so the order is explainable without help text.
function GroupDivider({ label, hint, action }: { label: string; hint?: string; action?: { label: string; onClick(): void; attribute?: string } }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{label}</span>
      {hint ? <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      {/* The group's own action sits on its divider: Unpin all only exists
          while there are pins, which is exactly when this divider does. */}
      {action ? (
        <button
          type="button"
          {...(action.attribute ? { [action.attribute]: "" } : {})}
          onClick={action.onClick}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:bg-[var(--ink-soft)] hover:decoration-current dark:text-zinc-200 dark:decoration-zinc-600"
        >
          {action.label}
        </button>
      ) : null}
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
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-200 px-2.5 py-1.5 text-start text-[11px] text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
      >
        {group === "upcoming" ? <Clock3 size={12} className="shrink-0" /> : <Pin size={12} className="shrink-0" />}
        <span className="font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
        {hint ? <span className="truncate">{hint}</span> : null}
        <span className="ms-auto font-mono text-[10px] tabular">{count}</span>
        <ChevronRight size={12} className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <div key={`${group}-rows`} className="lurk-reveal space-y-1">
            {children}
          </div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
