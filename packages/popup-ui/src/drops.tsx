import React, { useEffect, useRef, useState } from "react";
import { DndContext, DragOverlay, closestCenter, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  Gift,
  GripVertical,
  Link2,
  Radio,
  RotateCcw,
  Trophy,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useT } from "./context";
import { formatCountdown, formatHours, formatMinutes } from "./format";
import { campaignStats, fallbackGame } from "./viewModels";
import type { CampaignLifecycleState, CampaignView, GameItem, RewardView, TFunction } from "./types";
import {
  DragHandle,
  EmptyPanel,
  ImageWithFallback,
  MetaStat,
  Pill,
  ProgressBar,
  cn,
  moveById,
  useDndSensors,
} from "./primitives";

export function DropsPanel({ campaigns, gameMap, focus, onReorder, onToggleExclude }: { campaigns: CampaignView[]; gameMap: Record<string, GameItem>; focus?: { id: string; seq: number } | null; onReorder(campaigns: CampaignView[]): void | Promise<void>; onToggleExclude(id: string): void | Promise<void> }) {
  const t = useT();
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const firstId = campaigns[0]?.id;
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(firstId ? { [firstId]: true } : {});
  const listRef = useRef<HTMLDivElement>(null);

  // Jump to a campaign requested from elsewhere (e.g. the "Farming {campaign}"
  // link in the hero): expand it and scroll its card into view.
  useEffect(() => {
    if (!focus) return;
    setExpandedIds((current) => ({ ...current, [focus.id]: true }));
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-campaign-id]");
    const el = cards && Array.from(cards).find((card) => card.dataset.campaignId === focus.id);
    requestAnimationFrame(() => el?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [focus?.seq]);
  const activeCampaign = campaigns.find((campaign) => campaign.id === activeId);
  const activeIndex = campaigns.findIndex((campaign) => campaign.id === activeId);
  const anyFarming = campaigns.some((campaign) => Boolean(campaign.farmingChannel));

  if (campaigns.length === 0) return <EmptyPanel>{t("noCampaigns")}</EmptyPanel>;

  function endDrag(event: DragEndEvent): void {
    setActiveId(null);
    const active = String(event.active.id);
    const over = event.over?.id == null ? undefined : String(event.over.id);
    if (!over || active === over) return;
    void onReorder(moveById(campaigns, active, over));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
      <SortableContext items={campaigns.map((campaign) => campaign.id)} strategy={verticalListSortingStrategy}>
        <div ref={listRef} className="space-y-2">
          {campaigns.map((campaign, index) => (
            <SortableCampaign key={campaign.id} campaign={campaign} index={index} anyFarming={anyFarming} game={gameMap[campaign.gameId] ?? fallbackGame(campaign, index, t)} expanded={Boolean(expandedIds[campaign.id])} onToggle={() => setExpandedIds((current) => ({ ...current, [campaign.id]: !current[campaign.id] }))} onToggleExclude={onToggleExclude} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeCampaign ? <CampaignCard campaign={activeCampaign} index={activeIndex} anyFarming={anyFarming} game={gameMap[activeCampaign.gameId] ?? fallbackGame(activeCampaign, activeIndex, t)} expanded={false} onToggle={() => undefined} isOverlay dragHandle={<GripVertical size={16} className="text-zinc-400" />} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableCampaign(props: { campaign: CampaignView; index: number; anyFarming: boolean; game: GameItem; expanded: boolean; onToggle(): void; onToggleExclude(id: string): void | Promise<void> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.campaign.id });
  return (
    <div ref={setNodeRef} data-campaign-id={props.campaign.id} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CampaignCard {...props} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${props.campaign.title}`} />} />
    </div>
  );
}

function CampaignCard({ campaign, index, anyFarming, game, expanded, onToggle, onToggleExclude, dragHandle, isOverlay = false, dimmed = false }: { campaign: CampaignView; index: number; anyFarming: boolean; game: GameItem; expanded: boolean; onToggle(): void; onToggleExclude?(id: string): void | Promise<void>; dragHandle?: React.ReactNode; isOverlay?: boolean; dimmed?: boolean }) {
  const t = useT();
  const stats = campaignStats(campaign);
  const isFarming = Boolean(campaign.farmingChannel);
  const emphasized = isFarming || (!anyFarming && index === 0);
  const channelLabel = campaign.channels.length === 0 ? t("allChannels") : t("channelCount", String(campaign.channels.length));
  const timingLabel = campaign.status === "upcoming"
    ? t("startsIn", formatCountdown(campaign.starts, t))
    : t("endsIn", formatCountdown(campaign.ends, t));
  const lifecyclePill = campaignLifecyclePill(campaign.lifecycle, t);

  return (
    <article className={cn("overflow-hidden rounded-2xl border bg-white transition-shadow dark:bg-zinc-900", emphasized ? "border-transparent" : "border-zinc-200 dark:border-zinc-800", isOverlay ? "shadow-2xl shadow-black/25" : "shadow-sm", dimmed && "opacity-40")} style={emphasized ? { boxShadow: isOverlay ? "0 20px 50px -12px rgba(0,0,0,0.5)" : "0 0 0 1.5px var(--accent-ring), 0 10px 30px -18px var(--accent-glow)" } : undefined}>
      <div className="relative flex items-stretch">
        <div className="flex w-8 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">{dragHandle ?? <GripVertical size={16} className="text-zinc-300 dark:text-zinc-600" />}</div>
        {/* Full-area toggle behind the content so the page-link anchor can live next
            to the title without nesting an <a> inside a <button>. */}
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={campaign.title} className="absolute inset-y-0 left-8 right-0 z-0 outline-none" />
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2.5 p-2.5">
          <div className="relative flex h-10 w-10 shrink-0 items-end overflow-hidden rounded-lg shadow-inner">
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
                <span className="text-[13px] font-bold tabular leading-none" style={{ color: "var(--accent-text)" }}>{stats.progress.toFixed(0)}%</span>
                <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-zinc-400 dark:text-zinc-500"><ChevronDown size={16} /></motion.div>
              </div>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: game.accent }} />
              <span className="truncate">{game.name}</span>
              <span className="shrink-0 text-zinc-300 dark:text-zinc-600">·</span>
              <Pill tone="accent">#{index + 1}</Pill>
              {isFarming && <Pill tone="accent"><Radio size={9} /> {t("farmingLabel")}</Pill>}
              {lifecyclePill && (
                <Pill tone={lifecyclePill.tone}>
                  <lifecyclePill.icon size={9} /> {lifecyclePill.label}
                </Pill>
              )}
              {!campaign.linked && <Pill tone="danger"><Link2 size={9} /> {t("notLinked")}</Pill>}
              {campaign.excluded && <Pill tone="outline"><Ban size={9} /> {t("excluded")}</Pill>}
            </div>
            <div className="mt-2"><ProgressBar value={stats.progress} glow={emphasized} /></div>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-2.5 p-2.5">
              <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> {timingLabel}</div>
                    {stats.complete
                      ? <div className="mt-0.5 truncate text-[11px] font-medium" style={{ color: "var(--accent-text)" }}>{t("complete")}</div>
                      : <div className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">{t("nextReward", stats.nextReward?.name ?? "")}</div>}
                  </div>
                  {!stats.complete && <div className="shrink-0 text-right text-[10px] tabular text-zinc-500 dark:text-zinc-400">{formatMinutes(stats.remaining)} {t("left").toLowerCase()}</div>}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <MetaStat icon={Clock3} label={t("farmed")} value={formatHours(stats.totalFarmed)} />
                <MetaStat icon={RotateCcw} label={t("left")} value={stats.complete ? t("done") : formatMinutes(stats.remaining)} />
                <MetaStat icon={Trophy} label={t("rewards")} value={`${stats.completed}/${stats.totalRewards}`} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200"><Gift size={12} style={{ color: "var(--accent-text)" }} /> {t("rewards")}</span>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t("inCampaignOrder")}</span>
                </div>
                <div className="no-scrollbar -mx-0.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
                  {campaign.rewards.map((reward) => <RewardTile key={reward.id} reward={reward} />)}
                </div>
              </div>
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
              {onToggleExclude && (
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
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function campaignLifecyclePill(lifecycle: CampaignLifecycleState | undefined, t: TFunction): { icon: LucideIcon; label: string; tone: "muted" | "danger" | "outline" } | undefined {
  if (lifecycle === "upcoming") return { icon: Clock3, label: t("upcomingPill"), tone: "muted" };
  if (lifecycle === "expired") return { icon: AlertTriangle, label: t("expiredPill"), tone: "danger" };
  if (lifecycle === "finished") return { icon: Check, label: t("finishedPill"), tone: "outline" };
  return undefined;
}

function RewardTile({ reward }: { reward: RewardView }) {
  const done = reward.obtained || reward.progress >= 100;
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
      <ProgressBar value={reward.progress} size="sm" />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold tabular" style={reward.progress > 0 ? { color: "var(--accent-text)" } : undefined}>{reward.progress.toFixed(0)}%</span>
        <span className="tabular">{formatMinutes(reward.requiredMinutes)}</span>
      </div>
    </div>
  );
}
