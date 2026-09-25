import React, { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { AnimatePresence } from "motion/react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Gift,
  Hourglass,
  Link2,
  MousePointerClick,
  Pin,
  RotateCcw,
  Star,
  Users,
} from "lucide-react";
import type { CategorySelection } from "@lurkloot/shared/models";
import { I18nContext, PopupRuntimeContext, useT } from "./context";
import { formatCountdown, formatDateTime, formatMinutes, formatViewers } from "./format";
import { campaignStats, campaignTimeline } from "./viewModels";
import type { CampaignTimeline, CampaignView, GameItem, RewardView, TFunction } from "./types";
import {
  DragHandle,
  ImageWithFallback,
  ProgressBar,
  RankInput,
  cn,
  preventNativeDrag,
} from "./primitives";
import { Menu } from "@base-ui/react/menu";
import { FLOATING_POPUP_CLASS } from "./dropdown";
import { usePortalContainer } from "./portal";
import { Tip } from "./tooltip";

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
  const stats = campaignStats(campaign);
  const timeline = campaignTimeline(campaign);
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
  const rewardsLabel = t("campaignRewardsProgress", [String(stats.completed), String(stats.totalRewards)]);
  const deadline: { tone: DeadlineTone; label: string; hint?: string } | undefined = finished
    ? { tone: expired ? "muted" : "done", label: t(expired ? "expiredPill" : "finished") }
    : upcoming
      ? { tone: "muted", label: startsLabel(campaign.starts, t), hint: campaign.starts ? `${t("campaignFactStarts")} · ${formatDateTime(campaign.starts, locale)}` : undefined }
      : (() => {
        const label = timeLeftLabel(campaign.ends, t);
        return label ? { tone: endsSoon ? "hot" : "muted", label, hint: `${t("campaignFactEnds")} · ${formatDateTime(campaign.ends, locale)}` } : undefined;
      })();
  // Watching still needed for every reward, set against the time the campaign
  // has left to run. When it cannot all fit, the row says so and the bar marks
  // how far the viewing can get before the end.
  const watchLeft = !finished && timeline && timeline.remainingMinutes > 0 ? timeline.remainingMinutes : undefined;
  const startsAt = Date.parse(campaign.starts);
  const windowStart = upcoming && !Number.isNaN(startsAt) ? Math.max(Date.now(), startsAt) : Date.now();
  const minutesToEnd = Number.isNaN(endsAt) ? undefined : Math.max(0, (endsAt - windowStart) / 60_000);
  const outOfTime = watchLeft !== undefined && minutesToEnd !== undefined && watchLeft > minutesToEnd;
  const reachable = outOfTime && timeline
    ? (timeline.totalMinutes - timeline.remainingMinutes + minutesToEnd!) / timeline.totalMinutes
    : undefined;
  // States that used to be pills, now icons after the title. The expanded card
  // lists the same states in words (a rejection has its own banner there).
  const notices: CampaignFlag[] = finished ? [] : [
    ...(!campaign.linked ? [{ key: "not-linked", tone: "danger", icon: <Link2 size={12} />, label: t("notLinked") } as const] : []),
    ...(campaign.hasSubscriptionRewards ? [{ key: "subscription", tone: "muted", icon: <Users size={12} />, label: t("subscriptionRequired") } as const] : []),
    ...(stats.kind === "action" ? [{ key: "action", tone: "muted", icon: <MousePointerClick size={12} />, label: t("actionRequired") } as const] : []),
    ...(campaign.excluded && campaign.hasWatchRewards ? [{ key: "excluded", tone: "muted", icon: <Ban size={12} />, label: t("excluded") } as const] : []),
  ];
  // A subscription-only card already heads its panel with the same words.
  const expandedNotices = stats.kind === "subscription" ? notices.filter((notice) => notice.key !== "subscription") : notices;
  const flags: CampaignFlag[] = farmingRejectionMessage
    ? [...notices, { key: "rejected", tone: "warning", icon: <AlertTriangle size={12} />, label: farmingRejectionMessage }]
    : notices;

  return (
    <article className={cn(
      "overflow-hidden rounded-[10px] border bg-white transition-shadow dark:bg-zinc-900",
      emphasized ? "border-[var(--ink)]" : "border-zinc-200 dark:border-zinc-800",
      finished && "bg-zinc-50/60 dark:bg-zinc-900/60",
      farmingRejection && "border-dashed bg-transparent dark:bg-transparent",
      isOverlay && "shadow-2xl shadow-black/25",
      dimmed && "opacity-40",
    )}
    >
      <div className="relative flex items-stretch">
        {/* Drag rail doubles as the priority column: grip and rank share a
            16px column centered in the rail so the number is a caption of the
            handle, not full-rail text. Only pins can be dragged, so a row
            without a handle shows its rank alone rather than a grip that
            would promise a drag it cannot do. */}
        {!finished ? (
          <div className="flex w-7 shrink-0 items-center justify-center">
            <div className="flex w-4 flex-col items-center gap-0.5">
              {dragHandle}
              <RankInput index={index} count={rankCount ?? 0} label={campaign.title} onMove={onRankMove} size="rail" />
            </div>
          </div>
        ) : null}
        {/* Full-area toggle behind the content, so the row's own buttons can
            sit on top of it without nesting a button inside a button. */}
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={campaign.title} className={cn("absolute inset-y-0 end-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-ring)]", finished ? "start-0" : "start-7")} />
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-2">
          <div className="relative flex h-9 w-9 shrink-0 items-end overflow-hidden rounded-lg shadow-inner">
            <ImageWithFallback src={campaign.imageUrl} alt={campaign.title} fit="cover" fallback={
              <div className={cn("flex h-full w-full items-end bg-gradient-to-br p-1.5", campaign.tint)}>
                <span className="text-[11px] font-black leading-none tracking-normal text-white drop-shadow">{campaign.thumbnail}</span>
              </div>
            } />
          </div>
          <div className="min-w-0 flex-1">
            {/* The title keeps the line to itself but for small state icons
                right after it: each names its state in a tooltip, and the
                expanded card spells it out. */}
            <div className="flex min-w-0 items-center gap-1">
              {campaign.favourited && !finished ? (
                <Star size={11} aria-label={t("campaignFavouriteOn", game.name)} className="shrink-0 fill-current text-amber-500 dark:text-amber-400" />
              ) : null}
              <span className="min-w-0 truncate text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{campaign.title}</span>
              {flags.map((flag) => (
                <Tip key={flag.key} label={flag.label}>
                  <span
                    data-campaign-flag={flag.key}
                    {...(flag.key === "rejected" ? { "data-farming-rejection-indicator": "" } : {})}
                    role="img"
                    aria-label={flag.label}
                    // The content layer lets clicks through to the row's
                    // toggle; a flag takes the pointer for its tooltip, so it
                    // does the toggle's job itself.
                    onClick={onToggle}
                    className={cn("pointer-events-auto inline-flex shrink-0 p-px", FLAG_TONE[flag.tone])}
                  >
                    {flag.icon}
                  </span>
                </Tip>
              ))}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
              <span className="min-w-0 truncate">{game.name}</span>
              {!timeline || finished ? (
                <>
                  <span aria-hidden className="text-zinc-300 dark:text-zinc-600">·</span>
                  <span className="shrink-0 tabular">{rewardsLabel}</span>
                </>
              ) : null}
              {deadline ? (
                <>
                  <span aria-hidden className="text-zinc-300 dark:text-zinc-600">·</span>
                  <Deadline tone={deadline.tone} label={deadline.label} hint={deadline.hint} onClick={onToggle} />
                </>
              ) : null}
              {watchLeft !== undefined ? (
                <>
                  <span aria-hidden className="text-zinc-300 dark:text-zinc-600">·</span>
                  <RowFact
                    attribute="data-campaign-watch-left"
                    icon={<Hourglass size={10} aria-hidden="true" />}
                    label={formatMinutes(watchLeft)}
                    hint={outOfTime
                      ? `${t("campaignLeft")} · ${formatMinutes(watchLeft)} · ${t("insufficientTimeRemaining")}`
                      : `${t("campaignLeft")} · ${formatMinutes(watchLeft)}`}
                    className={outOfTime ? "font-medium text-amber-600 dark:text-amber-400" : undefined}
                    onClick={onToggle}
                  />
                </>
              ) : null}
            </div>
            {timeline && !finished ? (
              <CampaignProgress timeline={timeline} reachable={reachable} rewardsLabel={rewardsLabel} onClick={onToggle} />
            ) : null}
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-1">
            {fix ? (
              <button
                type="button"
                data-queue-fix
                onClick={(event) => { event.stopPropagation(); fix.onClick(); }}
                className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-[10px] font-semibold text-zinc-800 hover:bg-[var(--ink-soft)] dark:border-zinc-700 dark:text-zinc-100"
              >
                {fix.label}
              </button>
            ) : null}
            {onPin ? (
              <Tip label={t(pinned ? "queueUnpin" : "queueFixPin")}>
                <button
                  type="button"
                  data-queue-pin
                  aria-pressed={Boolean(pinned)}
                  aria-label={t(pinned ? "queueUnpin" : "queueFixPin")}
                  onClick={(event) => { event.stopPropagation(); onPin(); }}
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-md transition-colors",
                    pinned ? "text-[var(--ink-text)]" : "text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300",
                  )}
                >
                  <Pin size={13} fill={pinned ? "currentColor" : "none"} />
                </button>
              </Tip>
            ) : null}
            {/* The chevron opens and closes the card like the row itself does.
                It sits among the row's own controls, which take their clicks,
                so it has to be a button rather than a picture of one. The
                row's full-area toggle already names the action for assistive
                technology, so this duplicate stays out of the tab order.
                Rotated with CSS: a motion element per card made every list
                mount pay for Motion's scroll measurement. */}
            <Tip label={t(expanded ? "campaignHideDetails" : "campaignShowDetails")}>
              <button
                type="button"
                data-campaign-chevron
                tabIndex={-1}
                aria-hidden
                onClick={(event) => { event.stopPropagation(); onToggle(); }}
                className="grid h-6 w-6 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 rtl:-scale-x-100 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <ChevronRight size={15} className={cn("transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")} />
              </button>
            </Tip>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <div className="lurk-reveal">
            <div className="space-y-2.5 border-t border-zinc-100 p-2.5 dark:border-zinc-800">
              {farmingRejectionMessage ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1">{farmingRejectionMessage}</span>
                  {fix ? (
                    <button type="button" onClick={fix.onClick} className="shrink-0 rounded-md border border-current px-2 py-0.5 text-[10px] font-semibold hover:bg-amber-100 dark:hover:bg-amber-500/20">
                      {fix.label}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {expandedNotices.length > 0 ? (
                <ul data-campaign-notices className="space-y-1">
                  {expandedNotices.map((notice) => (
                    <li key={notice.key} className={cn("flex min-h-5 items-center gap-1.5 text-[11px] font-medium", FLAG_TONE[notice.tone])}>
                      <span className="flex shrink-0">{notice.icon}</span>
                      <span className="min-w-0 flex-1">{notice.label}</span>
                      {notice.key === "not-linked" && campaign.linkUrl ? (
                        <a
                          href={campaign.linkUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-current px-2 py-0.5 text-[10px] font-semibold outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-red-500/10"
                        >
                          {t("linkAccount")}
                          <ExternalLink size={10} className="opacity-70" />
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
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
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200"><Gift size={12} className="text-zinc-400 dark:text-zinc-500" /> {t("rewards")}</span>
                  <span className="font-mono text-[11px] font-semibold text-zinc-500 tabular dark:text-zinc-400">{stats.completed}/{stats.totalRewards}</span>
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
                      <a href={campaign.farmingChannel.url} target="_blank" rel="noreferrer" className="font-semibold text-zinc-900 underline decoration-zinc-300 decoration-1 underline-offset-2 hover:decoration-current dark:text-zinc-50 dark:decoration-zinc-600">{campaign.farmingChannel.name}</a>
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
                            <a href={channel.url} target="_blank" rel="noreferrer" className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-50">{channel.name}</a>
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
                      : timeline && timeline.remainingMinutes > 0
                        ? formatMinutes(timeline.remainingMinutes)
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
          </div>
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
  return formatCountdown(ends, t);
}

function startsLabel(starts: string, t: TFunction): string {
  const at = Date.parse(starts);
  return Number.isNaN(at) || at <= Date.now() ? t("upcomingPill") : t("startsIn", formatCountdown(starts, t));
}

type DeadlineTone = "hot" | "done" | "muted";

// The row's time line: how long is left, when it starts, or how it ended.
function Deadline({ tone, label, hint, onClick }: { tone: DeadlineTone; label: string; hint?: string; onClick(): void }): React.ReactElement {
  return (
    <RowFact
      attribute="data-campaign-status"
      value={tone}
      icon={tone === "done" ? <Check size={10} aria-hidden="true" /> : <Clock size={10} aria-hidden="true" />}
      label={label}
      hint={hint}
      className={cn(
        tone === "hot" && "font-medium text-amber-600 dark:text-amber-400",
        tone === "done" && "font-medium text-[var(--ink-text)]",
      )}
      onClick={onClick}
    />
  );
}

// A short value on the row's second line, explained by its tooltip. With a
// tooltip it takes the pointer, so it passes clicks on to the row toggle.
function RowFact({ attribute, value = "", icon, label, hint, className, onClick }: {
  attribute: string;
  value?: string;
  icon: React.ReactElement;
  label: string;
  hint?: string;
  className?: string;
  onClick(): void;
}): React.ReactElement {
  return (
    <Tip label={hint}>
      <span
        {...{ [attribute]: value }}
        onClick={hint ? onClick : undefined}
        className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap tabular", hint && "pointer-events-auto", className)}
      >
        {icon}
        {label}
      </span>
    </Tip>
  );
}

type CampaignFlag = {
  key: string;
  tone: keyof typeof FLAG_TONE;
  icon: React.ReactElement;
  label: string;
};

const FLAG_TONE = {
  danger: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  muted: "text-zinc-500 dark:text-zinc-400",
} as const;

/** The campaign's watch progress on one bar, with a small tick where each watch
 * reward becomes claimable. Ticks the viewing has passed turn solid. Positions
 * are logical, so the bar fills from the right in a right-to-left locale. */
function CampaignProgress({ timeline, reachable, rewardsLabel, onClick }: { timeline: CampaignTimeline; reachable?: number; rewardsLabel: string; onClick(): void }): React.ReactElement {
  // Rounded down, so the row never says 100% before the last reward is due.
  const percent = timeline.progress >= 1 ? 100 : Math.floor(timeline.progress * 100);
  return (
    <Tip label={rewardsLabel}>
      <div
        data-campaign-progress={percent}
        role="img"
        aria-label={`${rewardsLabel} · ${percent}%`}
        // Takes the pointer for its tooltip, so it passes the click on to the
        // row toggle the content layer otherwise lets it reach.
        onClick={onClick}
        className="pointer-events-auto mt-1 flex items-center gap-2"
      >
        <div className="relative h-[11px] min-w-0 flex-1">
          <span className="absolute inset-x-0 top-[3px] h-[5px] rounded-full bg-zinc-200 dark:bg-zinc-800" />
          {/* What the campaign ends before the viewing can reach. */}
          {reachable !== undefined ? (
            <span
              data-campaign-out-of-time
              className="absolute end-0 top-[3px] h-[5px] rounded-e-full bg-amber-500/30"
              style={{ insetInlineStart: `${reachable * 100}%` }}
            />
          ) : null}
          <span className="absolute start-0 top-[3px] h-[5px] rounded-full bg-[var(--ink)]" style={{ width: `${timeline.progress * 100}%` }} />
          {timeline.markers.map((marker) => (
            <span
              key={marker.id}
              data-reward-marker={marker.reached ? "reached" : reachable !== undefined && marker.at > reachable ? "out-of-time" : "pending"}
              className={cn(
                "absolute top-0 h-[11px] w-0.5 rounded-full",
                marker.reached ? "bg-[var(--ink)]"
                  : reachable !== undefined && marker.at > reachable ? "bg-amber-500/70 dark:bg-amber-400/70"
                  : "bg-zinc-300 dark:bg-zinc-600",
              )}
              // Kept inside the bar at both ends: a tick at 100% ends flush with it.
              style={{ insetInlineStart: `calc(${marker.at * 100}% - ${marker.at * 2}px)` }}
            />
          ))}
        </div>
        <span aria-hidden className="w-8 shrink-0 text-end text-[10.5px] font-medium leading-none text-zinc-500 tabular dark:text-zinc-400">{percent}%</span>
      </div>
    </Tip>
  );
}

function Fact({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-[11px] font-medium text-zinc-800 tabular dark:text-zinc-100">{value ?? children}</span>
    </div>
  );
}

// Everything that can be done to one campaign, on the campaign. Exclude is one
// button with two meanings, so it asks: this campaign, or its whole game, in a
// Base UI menu portalled out of the card (which clips its overflow).
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
  const [portalRef, portalContainer] = usePortalContainer();
  const blocked = Boolean(campaign.categoryBlocked);
  const excludeActive = campaign.excluded || blocked;
  const hasChoice = Boolean(onExclude && onBlock);

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
        {hasChoice ? (
          <Menu.Root modal={false}>
            <Menu.Trigger ref={portalRef} data-campaign-exclude className={excludeClass(excludeActive)}>
              <Ban size={12} aria-hidden="true" />
              {excludeLabel}
              <ChevronDown size={11} aria-hidden="true" className="opacity-70 transition-transform [[data-popup-open]>&]:rotate-180" />
            </Menu.Trigger>
            <Menu.Portal container={portalContainer}>
              <Menu.Positioner align="start" sideOffset={4} collisionPadding={8} className="z-50 outline-none">
                <Menu.Popup aria-label={t("campaignExclude")} data-campaign-exclude-menu className={cn(FLOATING_POPUP_CLASS, "w-[17rem]")}>
                  <ExcludeChoice
                    checked={campaign.excluded}
                    title={t("campaignExcludeThis")}
                    hint={campaign.excluded ? t("campaignExcludeThisUndo") : t("campaignExcludeThisHint", gameName)}
                    onClick={onExclude!}
                  />
                  <ExcludeChoice
                    checked={blocked}
                    title={t("campaignExcludeCategory", gameName)}
                    hint={blocked ? t("campaignExcludeCategoryUndo") : t("campaignExcludeCategoryHint", gameName)}
                    onClick={onBlock!}
                  />
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : onExclude ? (
          <button
            type="button"
            data-campaign-exclude
            aria-pressed={campaign.excluded}
            onClick={onExclude}
            className={excludeClass(campaign.excluded)}
          >
            <Ban size={12} aria-hidden="true" />
            {campaign.excluded ? t("includeInFarming") : t("excludeFromFarming")}
          </button>
        ) : onBlock ? (
          // Only the whole game can be kept out (a campaign with nothing to
          // watch cannot be excluded on its own), so the button says so.
          <button
            type="button"
            data-campaign-exclude
            aria-pressed={blocked}
            onClick={onBlock}
            className={excludeClass(blocked)}
          >
            <Ban size={12} aria-hidden="true" />
            {blocked ? t("campaignCategoryBlocked", gameName) : t("gamesBlock", gameName)}
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
            className="ms-auto inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ink-text)] hover:underline"
          >
            {t("viewDropPage")}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function excludeClass(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
    active
      ? "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
      : "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 data-[popup-open]:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100",
  );
}

function ExcludeChoice({ checked, title, hint, onClick }: { checked: boolean; title: string; hint: string; onClick(): void }): React.ReactElement {
  return (
    <Menu.CheckboxItem
      checked={checked}
      closeOnClick
      onClick={onClick}
      className="grid cursor-default select-none grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 rounded-md px-2 py-1.5 text-start outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
    >
      <Menu.CheckboxItemIndicator className="mt-0.5 text-[var(--ink-text)]">
        <Check size={12} strokeWidth={3} />
      </Menu.CheckboxItemIndicator>
      <span className="col-start-2 row-start-1 text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</span>
      <span className="col-start-2 text-[10.5px] text-zinc-500 dark:text-zinc-400">{hint}</span>
    </Menu.CheckboxItem>
  );
}

function ActionChip({ pressed, disabled, onClick, icon, children }: { pressed?: boolean; disabled?: boolean; onClick(): void; icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        pressed
          ? "border-zinc-400 bg-[var(--ink-soft)] text-[var(--ink-text)] dark:border-zinc-500"
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
        <Tip label={t("scrollRewardsLeft")}>
          <button
            type="button"
            onClick={() => scroll(-1)}
            aria-label={t("scrollRewardsLeft")}
            className="absolute left-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-800 outline-none transition-colors hover:border-zinc-400 hover:text-black focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        </Tip>
      )}
      {canScrollRight && (
        <Tip label={t("scrollRewardsRight")}>
          <button
            type="button"
            onClick={() => scroll(1)}
            aria-label={t("scrollRewardsRight")}
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-800 outline-none transition-colors hover:border-zinc-400 hover:text-black focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </Tip>
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
      <Tip label={reward.name}>
        <div className="mb-1.5 line-clamp-1 text-[11px] font-medium text-zinc-800 dark:text-zinc-200">{reward.name}</div>
      </Tip>
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
