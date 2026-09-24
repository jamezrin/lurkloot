import React, { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Gift,
  GripVertical,
  Link2,
  Pin,
  RotateCcw,
  Star,
  Users,
} from "lucide-react";
import type { CategorySelection } from "@lurkloot/shared/models";
import { I18nContext, PopupRuntimeContext, useT } from "./context";
import { formatCountdown, formatDateTime, formatMinutes, formatViewers } from "./format";
import { campaignStats } from "./viewModels";
import type { CampaignView, GameItem, RewardView, TFunction } from "./types";
import {
  DragHandle,
  ImageWithFallback,
  Pill,
  ProgressBar,
  RankInput,
  cn,
  preventNativeDrag,
} from "./primitives";

/** Cards start collapsed; only a campaign that is actively being farmed is worth
 * opening on mount. Anything else (completed, upcoming, merely first) would bury
 * the list under a reward grid the user did not ask for. */
export function initialExpandedIds(campaigns: CampaignView[]): Record<string, boolean> {
  const farmingId = farmingCampaignId(campaigns);
  return farmingId ? { [farmingId]: true } : {};
}

function farmingCampaignId(campaigns: CampaignView[]): string | undefined {
  return campaigns.find((campaign) => campaign.lifecycle !== "finished" && Boolean(campaign.farmingChannel))?.id;
}

export function SortableCampaign(props: Omit<CampaignCardProps, "dragHandle" | "dimmed" | "isOverlay"> & { rank?: number }) {
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

export type CampaignCardProps = {
  campaign: CampaignView;
  index: number;
  farmingIndex: number;
  anyFarming: boolean;
  game: GameItem;
  expanded: boolean;
  refreshing: boolean;
  onToggle(): void;
  onRefreshCampaign(id: string): void | Promise<void>;
  onToggleExclude?(id: string): void | Promise<void>;
  dragHandle?: React.ReactNode;
  isOverlay?: boolean;
  dimmed?: boolean;
  rankCount?: number;
  onRankMove?: (toIndex: number) => void;
  fix?: { label: string; onClick(): void };
  terminal?: boolean;
  pinned?: boolean;
  onPin?: () => void;
  // Why the ranking put this row where it is, shown among the facts. Only the
  // queue passes it: nothing else on screen is ranked.
  rankReason?: string;
  onToggleFavouriteCategory?(category: CategorySelection): void | Promise<void>;
  onToggleBlockedCategory?(category: CategorySelection): void | Promise<void>;
};

/** One campaign. Collapsed, a row: rank, name, progress, when it ends, a pin.
 * Opened, everything about it and everything that can be done to it, so no
 * action hides behind a menu: the rewards on a sliding row, the facts that
 * explain its place, and the actions — with Exclude asking whether it means
 * this campaign or its whole game. */
export function CampaignCard({ campaign, index, farmingIndex, anyFarming, game, expanded, refreshing, onToggle, onRefreshCampaign, onToggleExclude, dragHandle, isOverlay = false, dimmed = false, rankCount, onRankMove, fix, terminal = false, pinned, onPin, rankReason, onToggleFavouriteCategory, onToggleBlockedCategory }: CampaignCardProps) {
  const t = useT();
  const { locale } = React.useContext(I18nContext);
  const runtime = React.useContext(PopupRuntimeContext);
  // Where the pointer went down on the meta row, so drag-scrolling an
  // overflowing pill row does not read as a click on the card.
  const metaPointerX = useRef(0);
  const stats = campaignStats(campaign);
  // `terminal` is "this campaign is over": the Completed view renders expired
  // rows exactly like finished ones — one state, no rank, no rail, no warning.
  // An expired campaign is over wherever it is shown, search results included.
  const finished = terminal || campaign.lifecycle === "finished" || campaign.lifecycle === "expired";
  const expired = campaign.lifecycle === "expired";
  const isFarming = !terminal && Boolean(campaign.farmingChannel);
  // Only watch rewards are farmed by watching: a subscription-only campaign the
  // session happens to point at is not "farming".
  const farmingNow = isFarming && campaign.hasWatchRewards;
  const upcoming = !finished && campaign.status === "upcoming";
  const farmingRejection = isFarming || finished ? undefined : campaign.farmingRejection;
  const farmingRejectionMessage = farmingRejection
    ? t(campaignRejectionMessageKey(farmingRejection.code), farmingRejection.rewardName)
    : undefined;
  const emphasized = !finished && (isFarming || (!anyFarming && index === 0 && !farmingRejection));
  const showsWatchProgress = stats.kind === "watch" || stats.kind === "mixed";
  const endsAt = Date.parse(campaign.ends);
  const endsSoon = !finished && !upcoming && !Number.isNaN(endsAt) && endsAt - Date.now() < 12 * 3_600_000;
  const claimGuidance = campaign.rewards.find((reward) => reward.claimGuidance)?.claimGuidance;
  const category = campaign.category;
  const canExclude = Boolean(onToggleExclude) && campaign.hasWatchRewards && !finished;
  const canBlock = Boolean(onToggleBlockedCategory && category) && !finished;

  return (
    <article className={cn(
      "overflow-hidden rounded-[10px] border bg-white transition-shadow dark:bg-zinc-900",
      emphasized ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]" : "border-zinc-200 dark:border-zinc-800",
      finished && "bg-zinc-50/60 dark:bg-zinc-900/60",
      farmingRejection && "border-dashed bg-transparent dark:bg-transparent",
      isOverlay && "shadow-2xl shadow-black/25",
      dimmed && "opacity-40",
    )}
    >
      <div className="relative flex items-stretch">
        {/* Drag rail doubles as the priority column: grip and rank share a
            16px column centered in the rail so the number is a caption of the
            handle, not full-rail text. */}
        {!finished ? (
          <div className="flex w-7 shrink-0 items-center justify-center">
            <div className="flex w-4 flex-col items-center gap-0.5">
              {dragHandle ?? <GripVertical size={14} className="text-zinc-300 dark:text-zinc-600" />}
              <RankInput index={index} count={rankCount ?? 0} label={campaign.title} onMove={onRankMove} size="rail" />
            </div>
          </div>
        ) : null}
        {/* Full-area toggle behind the content, so the row's own buttons can
            sit on top of it without nesting a button inside a button. */}
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={campaign.title} className={cn("absolute inset-y-0 end-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-ring)]", finished ? "start-0" : "start-7")} />
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
            <div className="flex min-w-0 items-center gap-1">
              {campaign.favourited && !finished ? (
                <Star size={11} aria-label={t("campaignFavouriteOn", game.name)} className="shrink-0 fill-current text-[var(--accent-text)]" />
              ) : null}
              <span className="line-clamp-1 text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{campaign.title}</span>
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
              {!finished && showsWatchProgress ? (
                <span aria-hidden className="h-[3px] w-11 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, stats.progress ?? 0)}%` }} />
                </span>
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: game.accent }} />
              )}
              <span className="truncate">{game.name}</span>
              <span aria-hidden className="text-zinc-300 dark:text-zinc-600">·</span>
              <span className="shrink-0 tabular">{t("campaignRewardsProgress", [String(stats.completed), String(stats.totalRewards)])}</span>
              {!finished && showsWatchProgress ? <span className="shrink-0 tabular">· {(stats.progress ?? 0).toFixed(0)}%</span> : null}
              {!finished && campaign.hasSubscriptionRewards ? <Pill tone="outline"><Users size={9} /> {t("subscriptionRequired")}</Pill> : null}
              {!finished && stats.kind === "action" ? <Pill tone="outline"><AlertTriangle size={9} /> {t("actionRequired")}</Pill> : null}
              {!finished && !campaign.linked && <Pill tone="danger"><Link2 size={9} /> {t("notLinked")}</Pill>}
              {!finished && campaign.excluded && campaign.hasWatchRewards ? <Pill tone="outline"><Ban size={9} /> {t("excluded")}</Pill> : null}
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
          <div className="pointer-events-auto flex shrink-0 items-center gap-1">
            {fix ? (
              <button
                type="button"
                data-queue-fix
                onClick={(event) => { event.stopPropagation(); fix.onClick(); }}
                className="shrink-0 rounded-full border border-[var(--accent-ring)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-softer)]"
              >
                {fix.label}
              </button>
            ) : (
              <StatusPill
                tone={finished ? (expired ? "muted" : "done") : farmingNow ? "farming" : endsSoon ? "hot" : "muted"}
                label={finished
                  ? t(expired ? "expiredPill" : "finished")
                  : farmingNow ? t("farmingLabel")
                  : upcoming ? startsLabel(campaign.starts, t)
                  : timeLeftLabel(campaign.ends, t)}
              />
            )}
            {onPin ? (
              <button
                type="button"
                data-queue-pin
                aria-pressed={Boolean(pinned)}
                aria-label={t(pinned ? "queueUnpin" : "queueFixPin")}
                title={t(pinned ? "queueUnpin" : "queueFixPin")}
                onClick={(event) => { event.stopPropagation(); onPin(); }}
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-md transition-colors",
                  pinned ? "text-[var(--accent-text)]" : "text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300",
                )}
              >
                <Pin size={13} fill={pinned ? "currentColor" : "none"} />
              </button>
            ) : null}
            <motion.div animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.18 }} className="pointer-events-none grid h-6 w-5 place-items-center text-zinc-400 rtl:-scale-x-100 dark:text-zinc-500"><ChevronRight size={15} /></motion.div>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-2.5 border-t border-zinc-100 p-2.5 dark:border-zinc-800">
              {farmingRejectionMessage ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1">{farmingRejectionMessage}</span>
                  {fix ? (
                    <button type="button" onClick={fix.onClick} className="shrink-0 rounded-full border border-current px-2 py-0.5 text-[10px] font-semibold hover:bg-amber-100 dark:hover:bg-amber-500/20">
                      {fix.label}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {stats.kind === "subscription" ? (
                <div className="flex items-start justify-between gap-2 rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{t("subscriptionRequired")}</div>
                    <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">{t("notEarnableByWatching")}</div>
                  </div>
                  <div className="shrink-0 text-end">
                    <div className="text-xs font-semibold tabular" style={{ color: "var(--accent-text)" }}>{stats.completed}/{stats.totalRewards}</div>
                    <div className="mt-0.5 text-[9px] font-medium uppercase text-zinc-400 dark:text-zinc-500">{t("subscriptionRewards")}</div>
                    <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">{stats.complete ? t("complete") : t("subscriptionProgressUnknown")}</div>
                  </div>
                </div>
              ) : null}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200"><Gift size={12} style={{ color: "var(--accent-text)" }} /> {t("rewards")}</span>
                  <span className="font-mono text-[11px] font-semibold tabular" style={{ color: "var(--accent-text)" }}>{stats.completed}/{stats.totalRewards}</span>
                </div>
                <RewardCarousel rewards={campaign.rewards} missed={expired} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {upcoming ? <Fact label={t("campaignFactStarts")} value={formatDateTime(campaign.starts, locale)} /> : null}
                {Number.isNaN(endsAt) ? null : (
                  <Fact
                    label={t(finished ? "campaignFactEnded" : "campaignFactEnds")}
                    value={finished ? formatDateTime(campaign.ends, locale) : `${formatDateTime(campaign.ends, locale)} · ${formatCountdown(campaign.ends, t)}`}
                  />
                )}
                {!finished && farmingNow && campaign.farmingChannel ? (
                  <Fact label={t("campaignFactWatching")}>
                    {campaign.farmingChannel.url ? (
                      <a href={campaign.farmingChannel.url} target="_blank" rel="noreferrer" className="font-semibold text-[var(--accent-text)] underline decoration-1 underline-offset-2">{campaign.farmingChannel.name}</a>
                    ) : campaign.farmingChannel.name}
                    {campaign.farmingChannel.viewers != null ? <span className="text-zinc-500 dark:text-zinc-400"> · {t("viewerCount", formatViewers(campaign.farmingChannel.viewers))}</span> : null}
                  </Fact>
                ) : !finished ? (
                  <Fact label={t("campaignFactChannels")}>
                    {campaign.channels.length === 0 ? t("allChannels") : (
                      <>
                        {campaign.channels.slice(0, 3).map((channel, channelIndex) => (
                          <React.Fragment key={channel.name}>
                            {channelIndex > 0 ? ", " : null}
                            <a href={channel.url} target="_blank" rel="noreferrer" className="hover:text-[var(--accent-text)] hover:underline">{channel.name}</a>
                          </React.Fragment>
                        ))}
                        {campaign.channels.length > 3 ? <span className="text-zinc-500 dark:text-zinc-400"> {t("campaignMoreChannels", String(campaign.channels.length - 3))}</span> : null}
                      </>
                    )}
                  </Fact>
                ) : null}
                {!finished && !stats.complete && stats.nextReward && stats.nextRewardRemaining != null ? (
                  <Fact label={t("campaignFactNextReward")} value={`${stats.nextReward.name} · ${formatMinutes(stats.nextRewardRemaining)} ${t("left").toLowerCase()}`} />
                ) : null}
                {!finished && showsWatchProgress ? (
                  <Fact
                    label={t("campaignLeft")}
                    value={stats.complete
                      ? t("done")
                      : campaign.hasWatchRewards && stats.remaining > 0
                        ? formatMinutes(stats.remaining)
                        : t("subscriptionProgressUnknown")}
                  />
                ) : null}
                {rankReason ? <Fact label={t("campaignFactWhyRank")} value={rankReason} /> : null}
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
                    <ExternalLink size={11} className="ms-auto shrink-0 opacity-70" />
                  </button>
                </div>
              ) : null}
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
                  <ExternalLink size={11} className="ms-auto shrink-0 opacity-70" />
                </a>
              )}
              <CampaignActions
                campaign={campaign}
                gameName={category?.name ?? game.name}
                finished={finished}
                refreshing={refreshing}
                pinned={pinned}
                onPin={onPin}
                onRefresh={campaign.hasSubscriptionRewards ? () => void onRefreshCampaign(campaign.id) : undefined}
                onFavourite={onToggleFavouriteCategory && category && !finished ? () => void onToggleFavouriteCategory(category) : undefined}
                onExclude={canExclude ? () => void onToggleExclude!(campaign.id) : undefined}
                onBlock={canBlock ? () => void onToggleBlockedCategory!(category!) : undefined}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

// The collapsed row's deadline. A campaign with no end carries no deadline at
// all rather than "later left", and one whose end has passed says so until the
// next refresh marks it expired.
function timeLeftLabel(ends: string, t: TFunction): string | undefined {
  const at = Date.parse(ends);
  if (Number.isNaN(at)) return undefined;
  if (at <= Date.now()) return t("ended");
  return t("campaignTimeLeft", formatCountdown(ends, t));
}

function startsLabel(starts: string, t: TFunction): string {
  const at = Date.parse(starts);
  return Number.isNaN(at) || at <= Date.now() ? t("upcomingPill") : t("startsIn", formatCountdown(starts, t));
}

function StatusPill({ tone, label }: { tone: "farming" | "hot" | "done" | "muted"; label?: string }): React.ReactElement | null {
  if (!label) return null;
  return (
    <span
      data-campaign-status={tone}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-medium tabular",
        tone === "farming" && "bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]",
        tone === "hot" && "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
        tone === "done" && "bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]",
        tone === "muted" && "border border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
      )}
    >
      {tone === "done" ? <Check size={10} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

function Fact({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className="text-[11px] font-medium text-zinc-800 tabular dark:text-zinc-100">{value ?? children}</span>
    </div>
  );
}

// Everything that can be done to one campaign, on the campaign. Exclude is one
// button with two meanings, so it asks: this campaign, or its whole game. The
// choice opens in flow under the row rather than floating, because the card
// clips its overflow and the site demo scales the popup with a transform.
function CampaignActions({ campaign, gameName, finished, refreshing, pinned, onPin, onRefresh, onFavourite, onExclude, onBlock }: {
  campaign: CampaignView;
  gameName: string;
  finished: boolean;
  refreshing: boolean;
  pinned?: boolean;
  onPin?: () => void;
  onRefresh?: () => void;
  onFavourite?: () => void;
  onExclude?: () => void;
  onBlock?: () => void;
}): React.ReactElement | null {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const excludeButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const blocked = Boolean(campaign.categoryBlocked);
  const excludeActive = campaign.excluded || blocked;
  const hasChoice = Boolean(onExclude && onBlock);

  useEffect(() => {
    if (choosing) firstChoice.current?.focus();
  }, [choosing]);

  function close(): void {
    setChoosing(false);
    excludeButton.current?.focus();
  }

  const excludeLabel = blocked
    ? t("campaignCategoryBlocked", gameName)
    : campaign.excluded ? t("excluded") : t("campaignExclude");

  if (!onPin && !onFavourite && !onExclude && !onBlock && !onRefresh && !campaign.pageUrl) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {onPin && !finished ? (
          <ActionChip pressed={Boolean(pinned)} onClick={onPin} icon={<Pin size={12} fill={pinned ? "currentColor" : "none"} />}>
            {pinned && campaign.pinIndex != null ? t("campaignPinnedAt", String(campaign.pinIndex + 1)) : t("campaignPinToTop")}
          </ActionChip>
        ) : null}
        {onFavourite ? (
          <ActionChip pressed={Boolean(campaign.favourited)} onClick={onFavourite} icon={<Star size={12} fill={campaign.favourited ? "currentColor" : "none"} />}>
            {campaign.favourited ? t("campaignFavouriteOn", gameName) : t("campaignFavourite", gameName)}
          </ActionChip>
        ) : null}
        {onExclude || onBlock ? (
          <button
            ref={excludeButton}
            type="button"
            data-campaign-exclude
            aria-haspopup={hasChoice ? "menu" : undefined}
            aria-expanded={hasChoice ? choosing : undefined}
            aria-pressed={hasChoice ? undefined : excludeActive}
            onClick={() => {
              if (hasChoice) setChoosing((current) => !current);
              else (onExclude ?? onBlock)!();
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
              excludeActive
                ? "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                : "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100",
            )}
          >
            <Ban size={12} aria-hidden="true" />
            {hasChoice ? excludeLabel : campaign.excluded ? t("includeInFarming") : t("excludeFromFarming")}
            {hasChoice ? <ChevronDown size={11} aria-hidden="true" className={cn("opacity-70 transition-transform", choosing && "rotate-180")} /> : null}
          </button>
        ) : null}
        {onRefresh ? (
          <ActionChip onClick={onRefresh} disabled={refreshing} icon={<RotateCcw size={12} className={cn(refreshing && "animate-spin")} />}>
            {t("subscribedRefresh")}
          </ActionChip>
        ) : null}
        {campaign.pageUrl ? (
          <a
            href={campaign.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="ms-auto inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent-text)] hover:underline"
          >
            {t("viewDropPage")}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {hasChoice && choosing ? (
        <div
          role="menu"
          aria-label={t("campaignExclude")}
          data-campaign-exclude-menu
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); close(); }
          }}
          className="grid gap-1 rounded-xl border border-zinc-200 bg-white p-1 shadow-sm @[520px]:grid-cols-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <ExcludeChoice
            ref={firstChoice}
            checked={campaign.excluded}
            title={t("campaignExcludeThis")}
            hint={campaign.excluded ? t("campaignExcludeThisUndo") : t("campaignExcludeThisHint", gameName)}
            onClick={() => { onExclude!(); close(); }}
          />
          <ExcludeChoice
            checked={blocked}
            title={t("campaignExcludeCategory", gameName)}
            hint={blocked ? t("campaignExcludeCategoryUndo") : t("campaignExcludeCategoryHint", gameName)}
            onClick={() => { onBlock!(); close(); }}
          />
        </div>
      ) : null}
    </div>
  );
}

const ExcludeChoice = React.forwardRef<HTMLButtonElement, { checked: boolean; title: string; hint: string; onClick(): void }>(
  function ExcludeChoice({ checked, title, hint, onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={onClick}
        className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 rounded-lg px-2 py-1.5 text-start outline-none hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800"
      >
        <span className="mt-0.5 text-[var(--accent-text)]">{checked ? <Check size={12} strokeWidth={3} /> : null}</span>
        <span className="text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</span>
        <span className="col-start-2 text-[10.5px] text-zinc-500 dark:text-zinc-400">{hint}</span>
      </button>
    );
  },
);

function ActionChip({ pressed, disabled, onClick, icon, children }: { pressed?: boolean; disabled?: boolean; onClick(): void; icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        pressed
          ? "border-[var(--accent-ring)] text-[var(--accent-text)]"
          : "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function RewardCarousel({ rewards, missed = false }: { rewards: RewardView[]; missed?: boolean }) {
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
        {rewards.map((reward) => <RewardTile key={reward.id} reward={reward} missed={missed} />)}
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

function RewardTile({ reward, missed = false }: { reward: RewardView; missed?: boolean }) {
  const t = useT();
  const done = reward.obtained || (reward.progress ?? 0) >= 100;
  // An expired campaign's unearned rewards are gone, not pending.
  const lost = missed && !reward.obtained;
  return (
    <div data-reward-missed={lost || undefined} className={cn("w-[128px] shrink-0 rounded-xl border bg-white p-2 dark:bg-zinc-900", lost ? "border-dashed border-zinc-300 dark:border-zinc-700" : "border-zinc-200 dark:border-zinc-800")}>
      <div className={cn("relative mb-2 flex h-[68px] items-center justify-center overflow-hidden rounded-lg bg-zinc-50 dark:bg-zinc-800/40", lost && "opacity-50 grayscale")}>
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
          {lost ? (
            <div className="mt-1 text-[10px] font-semibold leading-tight text-amber-600 dark:text-amber-400">{t("rewardMissed")}</div>
          ) : reward.ineligibilityReason === "insufficient_time" ? (
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
