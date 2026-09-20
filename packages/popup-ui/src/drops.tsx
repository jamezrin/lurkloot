import React, { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Gift,
  GripVertical,
  Link2,
  Radio,
  RotateCcw,
  Search,
  Trophy,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { PopupRuntimeContext, useT } from "./context";
import { filterCampaigns } from "./campaignSearch";
import { formatCountdown, formatHours, formatMinutes } from "./format";
import { campaignStats, fallbackGame } from "./viewModels";
import type { CampaignLifecycleState, CampaignView, GameItem, RewardView, TFunction } from "./types";
import {
  DragHandle,
  EmptyPanel,
  IconButton,
  ImageWithFallback,
  MetaStat,
  Pill,
  ProgressBar,
  RankInput,
  SearchBox,
  SectionHeader,
  cn,
  reorderFromDragEnd,
  preventNativeDrag,
  type SortableDragEndEvent,
} from "./primitives";

/** Cards start collapsed; only a campaign that is actively being farmed is worth
 * opening on mount. Anything else (completed, upcoming, merely first) would bury
 * the list under a reward grid the user did not ask for. */
export function initialExpandedIds(campaigns: CampaignView[]): Record<string, boolean> {
  const farmingId = farmingCampaignId(campaigns);
  const farmingIndex = campaigns.findIndex((campaign) => campaign.id === farmingId);
  return farmingId ? { [farmingId]: true } : {};
}

function farmingCampaignId(campaigns: CampaignView[]): string | undefined {
  return campaigns.find((campaign) => campaign.lifecycle !== "finished" && Boolean(campaign.farmingChannel))?.id;
}

// Where a campaign dropped at `toIndex` of the visible active list lands among
// the pins. Dragging pins the dragged campaign and nothing else: every campaign
// it passed keeps whatever tier it had, which is what stops one drag from
// freezing the whole list into a manual order.
function pinPositionFor(activeCampaigns: CampaignView[], campaignId: string, toIndex: number): number {
  let position = 0;
  for (let index = 0; index < toIndex && index < activeCampaigns.length; index += 1) {
    const campaign = activeCampaigns[index]!;
    if (campaign.id !== campaignId && campaign.pinned) position += 1;
  }
  return position;
}

export function SortableCampaign(props: { campaign: CampaignView; index: number; rank?: number; farmingIndex: number; anyFarming: boolean; game: GameItem; expanded: boolean; refreshing: boolean; onToggle(): void; onRefreshCampaign(id: string): void | Promise<void>; onToggleExclude(id: string): void | Promise<void>; rankCount?: number; onRankMove?: (toIndex: number) => void }) {
  // The new dnd-kit animates the real element, so there is no DragOverlay copy
  // and no transform/transition to apply by hand.
  const t = useT();
  const { ref, handleRef, isDragging } = useSortable({ id: props.campaign.id, index: props.index });
  return (
    <div ref={ref} data-campaign-id={props.campaign.id} data-campaign-rank={String(props.rank ?? props.index + 1)} onDragStart={preventNativeDrag}>
      <CampaignCard {...props} dimmed={isDragging} dragHandle={<DragHandle handleRef={handleRef} label={t("reorderItem", props.campaign.title)} />} />
    </div>
  );
}

export function CampaignCard({ campaign, index, farmingIndex, anyFarming, game, expanded, refreshing, onToggle, onRefreshCampaign, onToggleExclude, dragHandle, isOverlay = false, dimmed = false, rankCount, onRankMove, fix, terminal = false, pinned, onPin }: { campaign: CampaignView; index: number; farmingIndex: number; anyFarming: boolean; game: GameItem; expanded: boolean; refreshing: boolean; onToggle(): void; onRefreshCampaign(id: string): void | Promise<void>; onToggleExclude?(id: string): void | Promise<void>; dragHandle?: React.ReactNode; isOverlay?: boolean; dimmed?: boolean; rankCount?: number; onRankMove?: (toIndex: number) => void; fix?: { label: string; onClick(): void }; terminal?: boolean; pinned?: boolean; onPin?: () => void }) {
  const t = useT();
  const runtime = React.useContext(PopupRuntimeContext);
  // Where the pointer went down on the meta row, so drag-scrolling an
  // overflowing pill row does not read as a click on the card.
  const metaPointerX = useRef(0);
  const stats = campaignStats(campaign);
  // `terminal` is "this campaign is over": the Completed view renders expired
  // rows exactly like finished ones — one state, no rank, no rail, no warning.
  const finished = terminal || campaign.lifecycle === "finished";
  const isFarming = !terminal && Boolean(campaign.farmingChannel);
  const farmingRejection = isFarming || finished ? undefined : campaign.farmingRejection;
  const farmingRejectionMessage = farmingRejection
    ? t(campaignRejectionMessageKey(farmingRejection.code), farmingRejection.rewardName)
    : undefined;
  const emphasized = !finished && (isFarming || (!anyFarming && index === 0));
  const channelLabel = campaign.channels.length === 0 ? t("allChannels") : t("channelCount", String(campaign.channels.length));
  const timingLabel = campaign.status === "upcoming"
    ? t("startsIn", formatCountdown(campaign.starts, t))
    : t("endsIn", formatCountdown(campaign.ends, t));
  const lifecyclePill = finished ? undefined : campaignLifecyclePill(campaign.lifecycle, t);
  const showsWatchProgress = stats.kind === "watch" || stats.kind === "mixed";
  const headlineStatus = finished
    // One terminal state, and the right one: a campaign that ended unfinished
    // says so rather than borrowing the finished headline.
    ? campaign.lifecycle === "expired" ? t("expiredPill") : t("finished")
    : stats.kind === "subscription"
    ? `${stats.completed}/${stats.totalRewards}`
    : stats.kind === "action"
      ? t("actionRequired")
      : `${(stats.progress ?? 0).toFixed(0)}%`;
  const claimGuidance = campaign.rewards.find((reward) => reward.claimGuidance)?.claimGuidance;
  const waitingForStream = !finished && !isFarming && farmingIndex > index && campaign.hasWatchRewards && stats.remaining > 0 && !farmingRejection;
  const waitingReason = t("waitingEligibleStream");
  const waitingHint = `${waitingReason.charAt(0).toLocaleUpperCase()}${waitingReason.slice(1)}${/[.!?]$/.test(waitingReason) ? "" : "."}`;
  const waitingLabel = `${t("later").charAt(0).toLocaleUpperCase()}${t("later").slice(1)}`;

  return (
    <article className={cn("overflow-hidden rounded-2xl border bg-white transition-shadow dark:bg-zinc-900", emphasized ? "border-[var(--accent-ring)]" : "border-zinc-200 dark:border-zinc-800", finished && "bg-zinc-50/60 dark:bg-zinc-900/60", isOverlay ? "shadow-2xl shadow-black/25" : "shadow-sm", dimmed && "opacity-40")} style={emphasized && !isOverlay ? { boxShadow: "0 10px 30px -18px var(--accent-glow)" } : undefined}>
      <div className="relative flex items-stretch">
        {/* Drag rail doubles as the priority column: grip and rank share a
            16px column centered in the rail so the number is a caption of the
            handle, not full-rail text. */}
        {!finished ? (
          <div className="flex w-7 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">
            <div className="flex w-4 flex-col items-center gap-0.5">
              {dragHandle ?? <GripVertical size={14} className="text-zinc-300 dark:text-zinc-600" />}
              <RankInput index={index} count={rankCount ?? 0} label={campaign.title} onMove={onRankMove} size="rail" />
            </div>
          </div>
        ) : null}
        {/* Full-area toggle behind the content so the page-link anchor can live next
            to the title without nesting an <a> inside a <button>. */}
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={campaign.title} className={cn("absolute inset-y-0 right-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-ring)]", finished ? "left-0" : "left-7")} />
        {/* Extra bottom padding is the progress bar's breathing room: the bar
            overlays the last 2px of it, leaving a clear gap under the pill row. */}
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2 px-1.5 pb-2 pt-1.5">
          <div className="relative flex h-8 w-8 shrink-0 items-end overflow-hidden rounded-lg shadow-inner">
            <ImageWithFallback src={campaign.imageUrl} alt={campaign.title} fit="cover" fallback={
              <div className={cn("flex h-full w-full items-end bg-gradient-to-br p-1.5", campaign.tint)}>
                <span className="text-[11px] font-black leading-none tracking-normal text-white drop-shadow">{campaign.thumbnail}</span>
              </div>
            } />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1">
                <span className="line-clamp-1 text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{campaign.title}</span>
                {campaign.pageUrl && (
                  <a
                    href={campaign.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={t("viewDropPage")}
                    title={t("viewDropPage")}
                    className="pointer-events-auto shrink-0 rounded p-0.5 text-zinc-400 outline-none transition-colors hover:text-[var(--accent-text)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500"
                  >
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className={cn("flex items-center gap-1 text-[13px] font-bold tabular leading-none", finished && "text-zinc-500 dark:text-zinc-400")} style={finished ? undefined : { color: "var(--accent-text)" }}>
                  {finished ? <Check size={12} aria-hidden="true" /> : null}{headlineStatus}
                </span>
                <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-zinc-400 dark:text-zinc-500"><ChevronDown size={16} /></motion.div>
              </div>
            </div>
            {/* Category and every state pill on one non-wrapping line. The
                category name yields first (Pill cannot shrink below its text),
                and past that the row scrolls rather than growing the card by a
                line — which needs pointer events back, so the row re-implements
                the expand toggle the content layer otherwise passes through. */}
            <div
              className="no-scrollbar pointer-events-auto mt-0.5 flex items-center gap-1.5 overflow-x-auto text-[11px] text-zinc-500 dark:text-zinc-400"
              onPointerDown={(event) => { metaPointerX.current = event.clientX; }}
              onClick={(event) => {
                // Suppress only what is positively a pointer click that moved:
                // that is a drag-scroll of this row, not a click on the card.
                // `detail` is 0 for keyboard and programmatic clicks, which
                // report clientX 0 and would otherwise look like a long drag.
                if (event.detail > 0 && Math.abs(event.clientX - metaPointerX.current) >= 4) return;
                onToggle();
              }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: game.accent }} />
              <span className="truncate">{game.name}</span>
              {!finished && campaign.hasSubscriptionRewards ? <Pill tone="outline"><Users size={9} /> {t("subscriptionRequired")}</Pill> : null}
              {!finished && stats.kind === "action" ? <Pill tone="outline"><AlertTriangle size={9} /> {t("actionRequired")}</Pill> : null}
              {!finished && isFarming && campaign.hasWatchRewards ? <Pill tone="accent"><Radio size={9} /> {t("farmingLabel")}</Pill> : null}
              {waitingForStream ? (
                <span title={waitingHint}>
                  <Pill tone="muted"><Clock3 size={9} /> {waitingLabel}</Pill>
                </span>
              ) : null}
              {lifecyclePill && (
                <Pill tone={lifecyclePill.tone}>
                  <lifecyclePill.icon size={9} /> {lifecyclePill.label}
                </Pill>
              )}
              {!finished && !campaign.linked && <Pill tone="danger"><Link2 size={9} /> {t("notLinked")}</Pill>}
              {!finished && campaign.excluded && campaign.hasWatchRewards ? <Pill tone="outline"><Ban size={9} /> {t("excluded")}</Pill> : null}
              {fix ? (
                <button
                  type="button"
                  data-queue-fix
                  onClick={(event) => { event.stopPropagation(); fix.onClick(); }}
                  className="shrink-0 rounded-full border border-[var(--accent-ring)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-softer)]"
                >
                  {fix.label}
                </button>
              ) : null}
              {onPin ? (
                <button
                  type="button"
                  data-queue-pin
                  aria-pressed={Boolean(pinned)}
                  onClick={(event) => { event.stopPropagation(); onPin(); }}
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                    pinned
                      ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent-text)]"
                      : "border-zinc-200 text-zinc-500 hover:border-[var(--accent-ring)] dark:border-zinc-700 dark:text-zinc-400",
                  )}
                >
                  {t(pinned ? "queueUnpin" : "queueFixPin")}
                </button>
              ) : null}
              {farmingRejectionMessage ? (
                <span
                  data-farming-rejection-indicator
                  role="img"
                  aria-label={farmingRejectionMessage}
                  title={farmingRejectionMessage}
                  className="inline-flex shrink-0 text-amber-500 dark:text-amber-400"
                >
                  <AlertTriangle size={11} />
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {/* Watch progress rides the card's bottom edge rather than taking a row
            of its own inside the collapsed layout. */}
        {!finished && showsWatchProgress ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <ProgressBar value={stats.progress ?? 0} size="edge" glow={emphasized} />
          </div>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-2.5 p-2.5">
              {farmingRejectionMessage ? (
                <div className="flex items-start gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>{farmingRejectionMessage}</span>
                </div>
              ) : null}
              {stats.kind === "subscription" ? (
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> {timingLabel}</div>
                      <div className="mt-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{t("subscriptionRequired")}</div>
                      <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">{t("notEarnableByWatching")}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-semibold tabular" style={{ color: "var(--accent-text)" }}>{stats.completed}/{stats.totalRewards}</div>
                      <div className="mt-0.5 text-[9px] font-medium uppercase text-zinc-400 dark:text-zinc-500">{t("subscriptionRewards")}</div>
                      <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">{stats.complete ? t("complete") : t("subscriptionProgressUnknown")}</div>
                    </div>
                  </div>
                </div>
              ) : stats.kind === "action" ? (
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> {timingLabel}</div>
                      <div className="mt-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{t("actionRequired")}</div>
                    </div>
                    <div className="shrink-0 text-xs font-semibold tabular" style={{ color: "var(--accent-text)" }}>{stats.completed}/{stats.totalRewards}</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                    <div className="flex items-end justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> {timingLabel}</div>
                        {stats.complete
                          ? <div className="mt-0.5 truncate text-[11px] font-medium" style={{ color: "var(--accent-text)" }}>{t("complete")}</div>
                          : <div className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">{t("nextReward", stats.nextReward?.name ?? "")}</div>}
                      </div>
                      {!stats.complete && stats.nextRewardRemaining != null ? <div className="shrink-0 text-right text-[10px] tabular text-zinc-500 dark:text-zinc-400">{formatMinutes(stats.nextRewardRemaining)} {t("left").toLowerCase()}</div> : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <MetaStat icon={Clock3} label={t("farmed")} value={formatHours(stats.totalFarmed)} />
                    <MetaStat
                      icon={RotateCcw}
                      label={t("campaignLeft")}
                      value={stats.complete
                        ? t("done")
                        : campaign.hasWatchRewards && stats.remaining > 0
                          ? formatMinutes(stats.remaining)
                          : t("subscriptionProgressUnknown")}
                    />
                    <MetaStat icon={Trophy} label={t("rewards")} value={`${stats.completed}/${stats.totalRewards}`} />
                  </div>
                </>
              )}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200"><Gift size={12} style={{ color: "var(--accent-text)" }} /> {t("rewards")}</span>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t("inCampaignOrder")}</span>
                </div>
                <RewardCarousel rewards={campaign.rewards} />
              </div>
              {claimGuidance ? (
                <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium">
                    <Link2 size={12} className="shrink-0" />
                    <span>{t("externalGameAccountRequired")}</span>
                  </div>
                  <button
                    type="button"
                    data-claim-link
                    onClick={() => runtime?.adapter.openLink(claimGuidance.url)}
                    className="mt-1 flex w-full items-center gap-1.5 rounded-md border border-amber-300/70 bg-white/60 px-2 py-1 text-[11px] font-medium outline-none transition-colors hover:border-amber-400 hover:bg-white focus-visible:ring-2 focus-visible:ring-amber-400 dark:border-amber-500/30 dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
                  >
                    <span>{t("linkExternalGameAccount")}</span>
                    <ExternalLink size={11} className="ml-auto shrink-0 opacity-70" />
                  </button>
                </div>
              ) : null}
              {campaign.hasSubscriptionRewards ? (
                <button
                  type="button"
                  onClick={() => void onRefreshCampaign(campaign.id)}
                  disabled={refreshing}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--accent-ring)] py-1.5 text-[11px] font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RotateCcw size={12} className={cn(refreshing && "animate-spin")} />
                  {t("subscribedRefresh")}
                </button>
              ) : null}
              <div className="rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60">
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <Users size={12} className="shrink-0" />
                  <span className="truncate">{channelLabel}</span>
                </div>
                {campaign.channels.length > 0 && (
                  <div className="no-scrollbar mt-1.5 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                    {campaign.channels.map((channel) => (
                      <a
                        key={channel.name}
                        href={channel.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex max-w-full items-center rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 outline-none transition-colors hover:border-[var(--accent-ring)] hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-white"
                      >
                        <span className="truncate">{channel.name}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
              {!campaign.linked && campaign.linkUrl && (
                <a
                  href={campaign.linkUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-700 outline-none transition-colors hover:border-amber-400 hover:bg-amber-100/70 focus-visible:ring-2 focus-visible:ring-amber-400 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
                >
                  <Link2 size={12} className="shrink-0" />
                  <span className="truncate">{t("linkAccount")}</span>
                  <ExternalLink size={11} className="ml-auto shrink-0 opacity-70" />
                </a>
              )}
              {onToggleExclude && campaign.hasWatchRewards ? (
                <button
                  type="button"
                  onClick={() => void onToggleExclude(campaign.id)}
                  className={cn(
                    "flex w-full items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] font-medium transition-colors",
                    campaign.excluded
                      ? "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100"
                      : "border-red-500/30 text-red-600 hover:border-red-500/60 hover:bg-red-500/5 dark:text-red-400",
                  )}
                >
                  <Ban size={12} /> {campaign.excluded ? t("includeInFarming") : t("excludeFromFarming")}
                </button>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function RewardCarousel({ rewards }: { rewards: RewardView[] }) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const rewardIds = rewards.map((reward) => reward.id).join("\u0000");

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    function updateControls(): void {
      if (!row) return;
      const maxScrollLeft = Math.max(0, row.scrollWidth - row.clientWidth);
      const isRtl = getComputedStyle(row).direction === "rtl";
      const scrollPosition = isRtl ? -row.scrollLeft : row.scrollLeft;
      setCanScrollLeft(isRtl ? scrollPosition < maxScrollLeft - 1 : scrollPosition > 1);
      setCanScrollRight(isRtl ? scrollPosition > 1 : scrollPosition < maxScrollLeft - 1);
    }

    row.addEventListener("scroll", updateControls, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updateControls);
    resizeObserver?.observe(row);
    Array.from(row.children).forEach((child) => resizeObserver?.observe(child));
    const frame = requestAnimationFrame(updateControls);

    return () => {
      cancelAnimationFrame(frame);
      row.removeEventListener("scroll", updateControls);
      resizeObserver?.disconnect();
    };
  }, [rewardIds]);

  function scroll(direction: -1 | 1): void {
    const row = rowRef.current;
    if (!row) return;
    const firstReward = row.firstElementChild as HTMLElement | null;
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    row.scrollBy({ left: direction * ((firstReward?.offsetWidth ?? row.clientWidth) + gap), behavior: "smooth" });
  }

  return (
    <div className="relative -mx-0.5">
      <div ref={rowRef} className="no-scrollbar flex gap-2 overflow-x-auto px-0.5 pb-1">
        {rewards.map((reward) => <RewardTile key={reward.id} reward={reward} />)}
      </div>
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          aria-label={t("scrollRewardsLeft")}
          title={t("scrollRewardsLeft")}
          className="absolute left-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white/95 text-zinc-700 shadow-md outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
      )}
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scroll(1)}
          aria-label={t("scrollRewardsRight")}
          title={t("scrollRewardsRight")}
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white/95 text-zinc-700 shadow-md outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function campaignLifecyclePill(lifecycle: CampaignLifecycleState | undefined, t: TFunction): { icon: LucideIcon; label: string; tone: "muted" | "danger" | "outline" } | undefined {
  if (lifecycle === "upcoming") return { icon: Clock3, label: t("upcomingPill"), tone: "muted" };
  if (lifecycle === "expired") return { icon: AlertTriangle, label: t("expiredPill"), tone: "danger" };
  if (lifecycle === "finished") return { icon: Check, label: t("finishedPill"), tone: "outline" };
  return undefined;
}

export function campaignRejectionMessageKey(code: NonNullable<CampaignView["farmingRejection"]>["code"]): string {
  const keys: Record<NonNullable<CampaignView["farmingRejection"]>["code"], string> = {
    excluded: "campaignRejectionExcluded",
    upcoming: "campaignRejectionUpcoming",
    expired: "campaignRejectionExpired",
    completed: "campaignRejectionCompleted",
    unlinked_campaigns_disabled: "campaignRejectionUnlinkedDisabled",
    twitch_link_required: "campaignRejectionTwitchLinkRequired",
    subscription_campaigns_disabled: "campaignRejectionSubscriptionDisabled",
    category_filtered: "campaignRejectionCategoryFiltered",
    category_blocked: "campaignRejectionCategoryBlocked",
    not_pinned: "campaignRejectionNotPinned",
    no_rewards: "campaignRejectionNoRewards",
    no_unclaimed_rewards: "campaignRejectionNoUnclaimedRewards",
    reward_prerequisites_unmet: "campaignRejectionPrerequisites",
    reward_not_started: "campaignRejectionRewardNotStarted",
    reward_window_ended: "campaignRejectionRewardWindowEnded",
    insufficient_time: "campaignRejectionInsufficientTime",
    subscription_required: "campaignRejectionSubscriptionRequired",
    action_required: "campaignRejectionActionRequired",
    no_farmable_reward: "campaignRejectionNoFarmableReward",
  };
  return keys[code];
}

function RewardTile({ reward }: { reward: RewardView }) {
  const t = useT();
  const done = reward.obtained || (reward.progress ?? 0) >= 100;
  return (
    <div className="w-[128px] shrink-0 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="relative mb-2 flex h-[68px] items-center justify-center overflow-hidden rounded-lg bg-zinc-50 dark:bg-zinc-800/40">
        <ImageWithFallback src={reward.imageUrl} alt={reward.name} fit="contain" className="p-1" fallback={
          <div className={cn("flex h-full w-full items-center justify-center bg-gradient-to-br", reward.tint)}>
            <span className="px-1 text-center text-[11px] font-black tracking-wide text-zinc-900/70 mix-blend-multiply">{reward.art}</span>
          </div>
        } />
        {done && <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white"><Check size={11} strokeWidth={3} /></span>}
      </div>
      <div className="mb-1.5 line-clamp-1 text-[11px] font-medium text-zinc-800 dark:text-zinc-200" title={reward.name}>{reward.name}</div>
      {reward.requirement === "watch" ? (
        <>
          <ProgressBar value={reward.progress ?? 0} size="sm" />
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold tabular" style={(reward.progress ?? 0) > 0 ? { color: "var(--accent-text)" } : undefined}>
              {reward.progress == null ? "—" : `${reward.progress.toFixed(0)}%`}
            </span>
            <span className="tabular">{formatMinutes(reward.requiredMinutes)}</span>
          </div>
          {reward.ineligibilityReason === "insufficient_time" ? (
            <div className="mt-1 text-[10px] font-semibold leading-tight text-amber-600 dark:text-amber-400">
              {t("insufficientTimeRemaining")}
            </div>
          ) : null}
        </>
      ) : reward.requirement === "subscription" ? (
        <div className="space-y-1 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
          <div className="font-semibold text-zinc-700 dark:text-zinc-200">{t("subscriptionRequired")}</div>
          <div>{t("qualifyingSubscriptionsRequired", String(reward.requiredSubs ?? 1))}</div>
          <div className={cn("font-medium", reward.obtained && "text-emerald-600 dark:text-emerald-400")}>{reward.obtained ? t("earned") : t("subscriptionProgressUnknown")}</div>
        </div>
      ) : (
        <div className="text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">{t("actionRequired")}</div>
      )}
    </div>
  );
}
