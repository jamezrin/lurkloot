import React, { useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Bell,
  Check,
  ChevronDown,
  Clock3,
  Gift,
  GripVertical,
  Info,
  Layers3,
  Link2,
  Play,
  Plus,
  Power,
  Radio,
  RotateCcw,
  Settings as SettingsIcon,
  Trophy,
  Users,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/* ───────────────────────────────────────────────────────────────
   Data
   ─────────────────────────────────────────────────────────────── */
const PLATFORMS = {
  twitch: { label: "Twitch", mark: "T", color: "#9147ff" },
  kick: { label: "Kick", mark: "K", color: "#53fc18" },
};

const initialGames = [
  { id: "fortnite", name: "Fortnite", short: "FN", accent: "#2563eb" },
  { id: "rocket", name: "Rocket League", short: "RL", accent: "#0891b2" },
  { id: "finals", name: "The Finals", short: "TF", accent: "#ef4444" },
  { id: "delta", name: "Delta Force", short: "DF", accent: "#16a34a" },
];

const initialCampaigns = [
  {
    id: "fncs-major",
    gameId: "fortnite",
    title: "FNCS Major 1 Summit",
    linked: true,
    ends: "2026-05-31 05:59:59",
    allowedChannels: ["fortnite", "fauxy", "nikof", "aussieantics"],
    moreChannels: 9,
    farmingChannel: { name: "nikof", category: "Fortnite", viewers: 12480 },
    thumbnail: "FN",
    tint: "from-orange-400 via-sky-400 to-blue-700",
    rewards: [
      { id: "dub-spray", name: "Missed The Dub Spray", progress: 93.3, requiredMinutes: 30, obtained: false, art: "SPRAY", tint: "from-lime-200 via-zinc-100 to-sky-200" },
    ],
  },
  {
    id: "drop-rush-rlcs",
    gameId: "rocket",
    title: "Drop Rush | post-RLCS",
    linked: true,
    ends: "2026-06-01 17:59:59",
    allowedChannels: ["All"],
    moreChannels: 0,
    farmingChannel: { name: "RocketLeague", category: "Rocket League", viewers: 8230 },
    thumbnail: "RL",
    tint: "from-cyan-400 via-zinc-700 to-rose-500",
    rewards: [
      { id: "aero-mage", name: "Aero Mage (Painted)", progress: 0, requiredMinutes: 30, obtained: false, art: "WHEEL", tint: "from-lime-500 via-zinc-800 to-cyan-600" },
      { id: "big-splash", name: "Big Splash GE (Painted)", progress: 0, requiredMinutes: 60, obtained: false, art: "SPLASH", tint: "from-fuchsia-400 via-pink-300 to-lime-300" },
      { id: "nemesis", name: "Nemesis (Painted)", progress: 0, requiredMinutes: 120, obtained: false, art: "CAR", tint: "from-cyan-400 via-emerald-500 to-zinc-800" },
      { id: "nuke-1", name: "Tactical Nuke (Painted)", progress: 0, requiredMinutes: 180, obtained: false, art: "BOOM", tint: "from-orange-400 via-red-500 to-zinc-800" },
      { id: "nuke-2", name: "Tactical Nuke (Painted)", progress: 0, requiredMinutes: 240, obtained: false, art: "BOOM", tint: "from-orange-400 via-red-500 to-zinc-800" },
    ],
  },
  {
    id: "tangerine-pt2",
    gameId: "finals",
    title: "STREAM TANGERINE PT.2",
    linked: true,
    ends: "2026-06-11 11:58:59",
    allowedChannels: ["All"],
    moreChannels: 0,
    farmingChannel: { name: "thefinals", category: "THE FINALS", viewers: 3110 },
    thumbnail: "TF",
    tint: "from-red-600 via-pink-500 to-cyan-300",
    rewards: [
      { id: "sh1900", name: "Tangerine SH1900", progress: 0, requiredMinutes: 60, obtained: false, art: "SH1900", tint: "from-orange-300 via-zinc-100 to-sky-100" },
      { id: "model1887", name: "Tangerine Model 1887", progress: 0, requiredMinutes: 120, obtained: false, art: "M1887", tint: "from-orange-300 via-zinc-100 to-sky-100" },
      { id: "m60", name: "Tangerine M60", progress: 0, requiredMinutes: 240, obtained: false, art: "M60", tint: "from-orange-300 via-zinc-100 to-sky-100" },
    ],
  },
  {
    id: "open-qualifier",
    gameId: "delta",
    title: "OPEN QUALIFIER W1",
    linked: false,
    ends: "2026-06-01 05:59:59",
    allowedChannels: ["All"],
    moreChannels: 0,
    farmingChannel: { name: "DeltaForceGame", category: "Delta Force", viewers: 1540 },
    thumbnail: "DF",
    tint: "from-zinc-700 via-slate-500 to-emerald-500",
    rewards: [
      { id: "gear-ticket", name: "Standard Gear Ticket", progress: 0, requiredMinutes: 15, obtained: false, art: "TICKET", tint: "from-yellow-100 via-zinc-100 to-stone-200" },
      { id: "voucher", name: "Armament Voucher ×2", progress: 0, requiredMinutes: 20, obtained: false, art: "VOUCHER", tint: "from-blue-400 via-blue-600 to-zinc-100" },
      { id: "xp-card", name: "Warfare 2× EXP Card", progress: 0, requiredMinutes: 30, obtained: false, art: "2× XP", tint: "from-zinc-100 via-emerald-200 to-slate-500" },
      { id: "cry", name: "Spray Paint — Cry", progress: 0, requiredMinutes: 60, obtained: false, art: "SPRAY", tint: "from-orange-100 via-white to-amber-200" },
      { id: "advanced", name: "QBZ95 — Advanced Pack", progress: 0, requiredMinutes: 90, obtained: false, art: "PACK", tint: "from-green-800 via-zinc-700 to-lime-900" },
    ],
  },
];

const initialPermawatch = [
  { id: "shroud", name: "shroud", live: true, viewers: 32140, category: "VALORANT" },
  { id: "tarik", name: "tarik", live: true, viewers: 18920, category: "Counter-Strike 2" },
  { id: "lirik", name: "LIRIK", live: false, viewers: 0, category: null },
  { id: "xqc", name: "xQc", live: true, viewers: 47655, category: "Just Chatting" },
  { id: "summit", name: "summit1g", live: false, viewers: 0, category: null },
];

/* ───────────────────────────────────────────────────────────────
   Helpers
   ─────────────────────────────────────────────────────────────── */
function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

function moveById(list, activeId, overId) {
  if (!overId || activeId === overId) return list;
  const oldIndex = list.findIndex((item) => item.id === activeId);
  const newIndex = list.findIndex((item) => item.id === overId);
  if (oldIndex === -1 || newIndex === -1) return list;
  return arrayMove(list, oldIndex, newIndex);
}

function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
}

function formatMinutes(minutes) {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatHours(minutes) {
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatViewers(count) {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`;
  return String(count);
}

function formatCountdown(ends) {
  const end = new Date(ends.replace(" ", "T"));
  if (Number.isNaN(end.getTime())) return ends;
  const diff = end.getTime() - Date.now();
  if (diff <= 0) return "Ended";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getCampaignStats(campaign) {
  const totalRequired = campaign.rewards.reduce((sum, r) => sum + r.requiredMinutes, 0);
  const totalFarmed = campaign.rewards.reduce((sum, r) => sum + (r.requiredMinutes * r.progress) / 100, 0);
  const remaining = Math.max(totalRequired - totalFarmed, 0);
  const progress = totalRequired ? Math.min(100, (totalFarmed / totalRequired) * 100) : 0;
  const completed = campaign.rewards.filter((r) => r.obtained || r.progress >= 100).length;
  const nextReward = campaign.rewards.find((r) => !r.obtained && r.progress < 100) || campaign.rewards.at(-1);
  return { totalRequired, totalFarmed, remaining, progress, completed, totalRewards: campaign.rewards.length, nextReward };
}

/* ───────────────────────────────────────────────────────────────
   Primitives
   ─────────────────────────────────────────────────────────────── */
function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900",
        checked ? "" : "bg-zinc-200 dark:bg-zinc-700"
      )}
      style={checked ? { backgroundColor: "var(--accent)" } : undefined}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 550, damping: 32 }}
        className="h-[18px] w-[18px] rounded-full bg-white shadow-sm"
        style={{ marginLeft: checked ? 16 : 0 }}
      />
    </button>
  );
}

function Pill({ children, tone = "muted", className, style }) {
  const tones = {
    muted: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    outline: "border border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
    accent: "",
    live: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    danger: "bg-red-500/12 text-red-600 dark:text-red-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap",
        tones[tone],
        className
      )}
      style={tone === "accent" ? { backgroundColor: "var(--accent-soft)", color: "var(--accent-text)", ...style } : style}
    >
      {children}
    </span>
  );
}

function ProgressBar({ value, size = "md", glow = false }) {
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-700/60", size === "sm" ? "h-1" : "h-1.5")}>
      <motion.div
        className="h-full rounded-full"
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(value, value > 0 ? 4 : 0)}%` }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{
          backgroundColor: "var(--accent)",
          boxShadow: glow && value > 0 ? "0 0 10px -1px var(--accent-glow)" : undefined,
        }}
      />
    </div>
  );
}

function IconButton({ children, label, active, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        active
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      )}
    >
      {children}
    </button>
  );
}

function DragHandle({ setActivatorNodeRef, attributes, listeners, label }) {
  return (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label={label}
      {...attributes}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      className="flex cursor-grab touch-none items-center justify-center rounded-md text-zinc-300 transition-colors hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:text-zinc-400 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      style={{ touchAction: "none", userSelect: "none" }}
    >
      <GripVertical size={16} />
    </button>
  );
}

/* ───────────────────────────────────────────────────────────────
   Platform switcher + sub tabs
   ─────────────────────────────────────────────────────────────── */
function PlatformSwitcher({ active, automation, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {Object.entries(PLATFORMS).map(([id, platform]) => {
        const selected = active === id;
        const running = automation[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            title={`${platform.label} automation ${running ? "running" : "paused"}`}
            className={cn(
              "relative flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors outline-none",
              selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            )}
          >
            {selected && (
              <motion.span
                layoutId="platform-pill"
                transition={{ type: "spring", stiffness: 520, damping: 38 }}
                className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700"
              />
            )}
            <span
              className="relative z-10 flex h-4 w-4 items-center justify-center rounded text-[10px] font-black"
              style={{
                backgroundColor: selected ? platform.color : "transparent",
                color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color,
                boxShadow: selected ? `0 0 12px -2px ${platform.color}` : undefined,
              }}
            >
              {platform.mark}
            </span>
            <span className="relative z-10">{platform.label}</span>
            <span className="relative z-10 ml-0.5 flex items-center" aria-hidden>
              {running ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                    style={{ backgroundColor: platform.color }}
                  />
                  <span
                    className="relative inline-flex h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: platform.color, boxShadow: `0 0 6px ${platform.color}` }}
                  />
                </span>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full border border-zinc-400 dark:border-zinc-500" />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SubTabs({ tabs, active, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors outline-none",
              selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            )}
          >
            {selected && (
              <motion.span
                layoutId="subtab-pill"
                transition={{ type: "spring", stiffness: 520, damping: 38 }}
                className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700"
              />
            )}
            <Icon size={14} className="relative z-10" style={selected ? { color: "var(--accent-text)" } : undefined} />
            <span className="relative z-10">{tab.label}</span>
            {tab.count != null && (
              <span className="relative z-10 text-[10px] font-bold tabular text-zinc-400 dark:text-zinc-500">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Automation hero
   ─────────────────────────────────────────────────────────────── */
function AutomationHero({ platformLabel, enabled, onChange, farmingTitle, farmingChannel }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      style={{ boxShadow: enabled ? "0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px var(--accent-ring)" : undefined }}
    >
      {/* ambient accent wash when active */}
      {enabled && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl"
          style={{ backgroundColor: "var(--accent-glow)", opacity: 0.5 }}
        />
      )}
      <div className="relative flex items-center gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors"
          style={{
            backgroundColor: enabled ? "var(--accent)" : "var(--accent-soft)",
            color: enabled ? "var(--accent-contrast)" : "var(--accent-text)",
          }}
        >
          <Power size={20} strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{platformLabel} automation</span>
            <Pill tone={enabled ? "accent" : "muted"}>{enabled ? "Running" : "Paused"}</Pill>
          </div>
          {/* Two text lines always reserved so toggling never shifts the layout. */}
          <div className="mt-0.5 flex h-[34px] flex-col justify-center text-xs text-zinc-500 dark:text-zinc-400">
            {enabled ? (
              <>
                <p className="truncate">
                  Farming <span className="font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span>
                </p>
                <p className="flex items-center gap-1 truncate">
                  <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
                  Watching
                  <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel?.name}</span>
                  {farmingChannel?.viewers != null && (
                    <span className="shrink-0 text-zinc-400 dark:text-zinc-500">· {formatViewers(farmingChannel.viewers)}</span>
                  )}
                </p>
              </>
            ) : (
              <p className="line-clamp-2 leading-snug">Watching paused. Toggle to resume drop farming.</p>
            )}
          </div>
        </div>
        <Toggle checked={enabled} onChange={onChange} label={`${platformLabel} automation`} />
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Reward tile + campaign card
   ─────────────────────────────────────────────────────────────── */
function RewardTile({ reward }) {
  const done = reward.obtained || reward.progress >= 100;
  return (
    <div className="w-[128px] shrink-0 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className={cn("relative mb-2 flex h-[68px] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br", reward.tint)}>
        <span className="px-1 text-center text-[11px] font-black tracking-wide text-zinc-900/70 mix-blend-multiply">{reward.art}</span>
        {done && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="mb-1.5 line-clamp-1 text-[11px] font-medium text-zinc-800 dark:text-zinc-200" title={reward.name}>
        {reward.name}
      </div>
      <ProgressBar value={reward.progress} size="sm" />
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold tabular" style={reward.progress > 0 ? { color: "var(--accent-text)" } : undefined}>
          {reward.progress.toFixed(0)}%
        </span>
        <span className="tabular">{formatMinutes(reward.requiredMinutes)}</span>
      </div>
    </div>
  );
}

function MetaStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60">
      <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        <Icon size={11} /> {label}
      </div>
      <div className="truncate text-xs font-semibold tabular text-zinc-800 dark:text-zinc-100">{value}</div>
    </div>
  );
}

function CampaignCard({
  campaign,
  index,
  game,
  expanded,
  onToggle,
  dragHandle,
  isOverlay = false,
  dimmed = false,
}) {
  const stats = getCampaignStats(campaign);
  const isTop = index === 0;
  const channelLabel = campaign.allowedChannels[0] === "All" ? "All channels" : `${campaign.allowedChannels.length + campaign.moreChannels} channels`;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-white transition-shadow dark:bg-zinc-900",
        isTop ? "border-transparent" : "border-zinc-200 dark:border-zinc-800",
        isOverlay ? "shadow-2xl shadow-black/25" : "shadow-sm",
        dimmed && "opacity-40"
      )}
      style={
        isTop
          ? { boxShadow: isOverlay ? "0 20px 50px -12px rgba(0,0,0,0.5)" : "0 0 0 1.5px var(--accent-ring), 0 10px 30px -18px var(--accent-glow)" }
          : undefined
      }
    >
      {/* header / handle row */}
      <div className="flex items-stretch">
        <div className="flex w-8 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">
          {dragHandle ?? <GripVertical size={16} className="text-zinc-300 dark:text-zinc-600" />}
        </div>

        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2.5 p-2.5 text-left outline-none">
          <div className={cn("relative flex h-12 w-12 shrink-0 items-end overflow-hidden rounded-xl bg-gradient-to-br p-1.5 shadow-inner", campaign.tint)}>
            <span className="text-[11px] font-black leading-none tracking-tight text-white drop-shadow">{campaign.thumbnail}</span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="line-clamp-1 text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{campaign.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: game.accent }} />
                  <span className="truncate">{game.name}</span>
                </div>
              </div>
              <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500">
                <ChevronDown size={16} />
              </motion.div>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Pill tone="accent" className="font-bold">#{index + 1}</Pill>
              {isTop && (
                <Pill tone="accent">
                  <Radio size={9} /> Farming now
                </Pill>
              )}
              <Pill tone={campaign.linked ? "live" : "danger"}>
                <Link2 size={9} /> {campaign.linked ? "Linked" : "Not linked"}
              </Pill>
            </div>
          </div>
        </button>
      </div>

      {/* progress strip (always visible) */}
      <div className="p-2.5">
        <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
          <div className="mb-1.5 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                <Clock3 size={10} /> Ends in {formatCountdown(campaign.ends)}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
                Next: <span className="font-medium text-zinc-800 dark:text-zinc-100">{stats.nextReward?.name}</span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular leading-none" style={{ color: "var(--accent-text)" }}>
                {stats.progress.toFixed(0)}%
              </div>
              <div className="mt-0.5 text-[10px] tabular text-zinc-500 dark:text-zinc-400">{formatMinutes(stats.remaining)} left</div>
            </div>
          </div>
          <ProgressBar value={stats.progress} glow={isTop} />
        </div>

        {/* expandable detail */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="space-y-2.5 pt-2.5">
                <div className="grid grid-cols-3 gap-1.5">
                  <MetaStat icon={Clock3} label="Farmed" value={formatHours(stats.totalFarmed)} />
                  <MetaStat icon={RotateCcw} label="Left" value={formatMinutes(stats.remaining)} />
                  <MetaStat icon={Trophy} label="Rewards" value={`${stats.completed}/${stats.totalRewards}`} />
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                      <Gift size={12} style={{ color: "var(--accent-text)" }} /> Rewards
                    </span>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500">in campaign order</span>
                  </div>
                  <div className="no-scrollbar -mx-0.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
                    {campaign.rewards.map((reward) => (
                      <RewardTile key={reward.id} reward={reward} />
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 rounded-lg bg-zinc-50 px-2 py-1.5 text-[11px] text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                  <Users size={12} className="shrink-0" />
                  <span className="truncate">{channelLabel}</span>
                  {campaign.allowedChannels[0] !== "All" && (
                    <span className="truncate text-zinc-400 dark:text-zinc-500">· {campaign.allowedChannels.join(", ")}</span>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </article>
  );
}

function SortableCampaign({ campaign, index, game, expanded, onToggle }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: campaign.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="relative">
      <CampaignCard
        campaign={campaign}
        index={index}
        game={game}
        expanded={expanded}
        onToggle={onToggle}
        dimmed={isDragging}
        dragHandle={
          <DragHandle
            setActivatorNodeRef={setActivatorNodeRef}
            attributes={attributes}
            listeners={listeners}
            label={`Reorder ${campaign.title}`}
          />
        }
      />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Drops panel
   ─────────────────────────────────────────────────────────────── */
function DropsPanel({ campaigns, setCampaigns, gameMap }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState(null);
  const firstId = campaigns[0]?.id;
  const [expandedIds, setExpandedIds] = useState(firstId ? { [firstId]: true } : {});
  const activeCampaign = campaigns.find((c) => c.id === activeId);
  const activeIndex = campaigns.findIndex((c) => c.id === activeId);

  const toggle = (id) => setExpandedIds((cur) => ({ ...cur, [id]: !cur[id] }));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragEnd={({ active, over }) => {
        setActiveId(null);
        if (over && active.id !== over.id) setCampaigns((cur) => moveById(cur, active.id, over.id));
      }}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={campaigns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {campaigns.map((campaign, index) => (
            <SortableCampaign
              key={campaign.id}
              campaign={campaign}
              index={index}
              game={gameMap[campaign.gameId]}
              expanded={Boolean(expandedIds[campaign.id])}
              onToggle={() => toggle(campaign.id)}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeCampaign ? (
          <CampaignCard
            campaign={activeCampaign}
            index={activeIndex}
            game={gameMap[activeCampaign.gameId]}
            expanded={false}
            onToggle={() => {}}
            isOverlay
            dragHandle={<GripVertical size={16} className="text-zinc-400" />}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* ───────────────────────────────────────────────────────────────
   Compact sortable rows (permawatch + game priority)
   ─────────────────────────────────────────────────────────────── */
function CompactRow({ avatar, avatarStyle, index, title, subtitle, trailing, dragHandle, isOverlay = false, dimmed = false }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border bg-white px-2 py-2 dark:bg-zinc-900",
        isOverlay ? "border-transparent shadow-2xl shadow-black/25" : "border-zinc-200 shadow-sm dark:border-zinc-800",
        dimmed && "opacity-40"
      )}
    >
      {dragHandle}
      <span className="w-4 text-center text-[11px] font-bold tabular" style={{ color: "var(--accent-text)" }}>
        {index + 1}
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={avatarStyle}>
        {avatar}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">{title}</span>
        {subtitle && (
          <span className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{subtitle}</span>
        )}
      </span>
      {trailing}
    </div>
  );
}

function SortablePermawatch({ streamer, index }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: streamer.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow
        index={index}
        avatar={streamer.name.slice(0, 2).toUpperCase()}
        avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }}
        title={streamer.name}
        subtitle={streamer.live ? streamer.category : "Offline"}
        dimmed={isDragging}
        dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${streamer.name}`} />}
        trailing={
          streamer.live ? (
            <Pill tone="live">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {formatViewers(streamer.viewers)}
            </Pill>
          ) : (
            <Pill tone="muted">offline</Pill>
          )
        }
      />
    </div>
  );
}

function PermawatchPanel({ streamers, setStreamers }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState(null);
  const active = streamers.find((s) => s.id === activeId);
  const activeIndex = streamers.findIndex((s) => s.id === activeId);

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 p-2.5 text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
        <Layers3 size={14} className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
        <p className="leading-relaxed">
          A fallback queue, independent from drops. Channels here are watched in order when no prioritized drop is available.
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragEnd={({ active, over }) => {
          setActiveId(null);
          if (over && active.id !== over.id) setStreamers((cur) => moveById(cur, active.id, over.id));
        }}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={streamers.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {streamers.map((streamer, index) => (
              <SortablePermawatch key={streamer.id} streamer={streamer} index={index} />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {active ? (
            <CompactRow
              isOverlay
              index={activeIndex}
              avatar={active.name.slice(0, 2).toUpperCase()}
              avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }}
              title={active.name}
              subtitle={active.live ? active.category : "Offline"}
              dragHandle={<GripVertical size={16} className="text-zinc-400" />}
              trailing={<Pill tone={active.live ? "live" : "muted"}>{active.live ? formatViewers(active.viewers) : "offline"}</Pill>}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <button
        type="button"
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
      >
        <Plus size={14} /> Add channel
      </button>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Settings
   ─────────────────────────────────────────────────────────────── */
function SettingsSection({ title, description, icon: Icon, children }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }}>
          <Icon size={14} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
          {description && <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function SettingRow({ title, description, checked, onChange }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        {description && <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function SortableGameRow({ game, index }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: game.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow
        index={index}
        avatar={game.short}
        avatarStyle={{ backgroundColor: game.accent, color: "#fff" }}
        title={game.name}
        dimmed={isDragging}
        dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${game.name}`} />}
        trailing={<Pill tone="outline">game</Pill>}
      />
    </div>
  );
}

function GamePriority({ games, setGames }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState(null);
  const active = games.find((g) => g.id === activeId);
  const activeIndex = games.findIndex((g) => g.id === activeId);

  return (
    <div className="space-y-2 rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">Fallback game order</div>
        <Pill tone="accent">drag to sort</Pill>
      </div>
      <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Used when campaign order is reset to defaults.</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragEnd={({ active, over }) => {
          setActiveId(null);
          if (over && active.id !== over.id) setGames((cur) => moveById(cur, active.id, over.id));
        }}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={games.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {games.map((game, index) => (
              <SortableGameRow key={game.id} game={game} index={index} />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {active ? (
            <CompactRow
              isOverlay
              index={activeIndex}
              avatar={active.short}
              avatarStyle={{ backgroundColor: active.accent, color: "#fff" }}
              title={active.name}
              dragHandle={<GripVertical size={16} className="text-zinc-400" />}
              trailing={<Pill tone="outline">game</Pill>}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function SettingsView({ games, setGames, settings, setSettings }) {
  const set = (key) => (value) => setSettings((cur) => ({ ...cur, [key]: value }));
  return (
    <div className="space-y-2.5">
      <SettingsSection title="General" description="Tab audio and cleanup behavior." icon={SettingsIcon}>
        <SettingRow title="Mute farming tabs" description="Keep drop and Permawatch tabs muted while farming." checked={settings.muteFarmingTabs} onChange={set("muteFarmingTabs")} />
        <SettingRow title="Pause when watching manually" description="Stop farming while you have a stream open and are watching yourself." checked={settings.pauseOnManualWatch} onChange={set("pauseOnManualWatch")} />
        <SettingRow title="Auto-close farming tabs" description="Automatically close when the extension is idle (no drops to farm or no streamers to watch)." checked={settings.autoClose} onChange={set("autoClose")} />
        <SettingRow title="Auto-start on launch" description="Begin farming as soon as the extension loads." checked={settings.autoStartDropFarming} onChange={set("autoStartDropFarming")} />
      </SettingsSection>

      <SettingsSection title="Notifications" description="When Streamaxxer should ping you." icon={Bell}>
        <SettingRow title="Reward earned" description="Notify when a drop reward is claimable." checked={settings.notifyRewardEarned} onChange={set("notifyRewardEarned")} />
        <SettingRow title="No drops left" description="Notify when all active campaigns are exhausted." checked={settings.notifyNoDropsLeft} onChange={set("notifyNoDropsLeft")} />
      </SettingsSection>

      <SettingsSection title="Drops" description="Farming priority is set by dragging campaigns in the Drops tab." icon={Gift}>
        <GamePriority games={games} setGames={setGames} />
      </SettingsSection>

      <SettingsSection title="Permawatch" description="Fallback queue behavior." icon={Play}>
        <SettingRow title="Only when no drops are active" description="Preserves drop priority automatically." checked={settings.permawatchFallbackOnly} onChange={set("permawatchFallbackOnly")} />
      </SettingsSection>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Popup shell
   ─────────────────────────────────────────────────────────────── */
function Popup() {
  const [platform, setPlatform] = useState("twitch");
  const [tab, setTab] = useState("drops");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [automation, setAutomation] = useState({ twitch: true, kick: false });
  const [games, setGames] = useState(initialGames);
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [permawatch, setPermawatch] = useState(initialPermawatch);
  const [settings, setSettings] = useState({
    muteFarmingTabs: true,
    pauseOnManualWatch: true,
    autoClose: true,
    notifyRewardEarned: true,
    notifyNoDropsLeft: true,
    autoStartDropFarming: true,
    permawatchFallbackOnly: true,
  });

  const gameMap = useMemo(() => Object.fromEntries(initialGames.map((g) => [g.id, g])), []);
  const platformLabel = PLATFORMS[platform].label;
  const topCampaign = campaigns[0];
  const enabled = automation[platform];

  return (
    <div
      data-platform={platform}
      className="flex h-[600px] w-[400px] flex-col overflow-hidden rounded-[26px] border border-zinc-200/80 bg-zinc-50 shadow-2xl shadow-black/30 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="relative shrink-0 border-b border-zinc-200/70 bg-white/85 px-3 pb-3 pt-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
          style={{ background: "linear-gradient(90deg, transparent, var(--accent), transparent)" }}
        />
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo-ring.svg"
              alt="Streamaxxer"
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl shadow-sm"
              style={{ boxShadow: "0 4px 14px -4px var(--accent-glow)" }}
            />
            <div className="leading-tight">
              <div className="font-display text-[15px] font-bold tracking-tight text-zinc-900 dark:text-zinc-50">Streamaxxer</div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: enabled ? "var(--accent)" : "#a1a1aa" }} />
                {enabled ? "Active" : "Paused"} · {platformLabel}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton label={settingsOpen ? "Close settings" : "Open settings"} active={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
              {settingsOpen ? <X size={16} /> : <SettingsIcon size={16} />}
            </IconButton>
          </div>
        </header>

        <PlatformSwitcher active={platform} automation={automation} onChange={setPlatform} />
      </div>

      {/* ── Scroll body ────────────────────────────────────── */}
      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto text-zinc-700 dark:text-zinc-300">
        <div className="space-y-3 p-3">
          <AnimatePresence mode="wait" initial={false}>
            {settingsOpen ? (
              <motion.div
                key="settings"
                initial={{ opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 14 }}
                transition={{ duration: 0.18 }}
                className="space-y-2.5"
              >
                <SettingsView games={games} setGames={setGames} settings={settings} setSettings={setSettings} />
              </motion.div>
            ) : (
              <motion.div
                key="main"
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -14 }}
                transition={{ duration: 0.18 }}
                className="space-y-3"
              >
                <AutomationHero
                  platformLabel={platformLabel}
                  enabled={enabled}
                  onChange={(v) => setAutomation((cur) => ({ ...cur, [platform]: v }))}
                  farmingTitle={topCampaign?.title}
                  farmingChannel={topCampaign?.farmingChannel}
                />

                <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[11px]" style={{ backgroundColor: "var(--accent-softer)" }}>
                  <Info size={13} className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
                  <p className="leading-snug text-zinc-600 dark:text-zinc-300">
                    Drops always take priority over Permawatch. Drag campaigns by the{" "}
                    <GripVertical size={11} className="inline align-text-bottom text-zinc-400" /> grip to set farming order.
                  </p>
                </div>

                <SubTabs
                  tabs={[
                    { id: "drops", label: "Drops", icon: Gift, count: campaigns.length },
                    { id: "permawatch", label: "Permawatch", icon: Play, count: `${permawatch.length}/20` },
                  ]}
                  active={tab}
                  onChange={setTab}
                />

                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={tab}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.15 }}
                  >
                    {tab === "drops" ? (
                      <DropsPanel campaigns={campaigns} setCampaigns={setCampaigns} gameMap={gameMap} />
                    ) : (
                      <PermawatchPanel streamers={permawatch} setStreamers={setPermawatch} />
                    )}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Page wrapper (preview surface)
   ─────────────────────────────────────────────────────────────── */
export default function StreamaxxerMockup() {
  const reduce = useReducedMotion();
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* ambient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, rgba(145,71,255,0.10), transparent 70%), radial-gradient(40% 40% at 85% 90%, rgba(83,252,24,0.08), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18] mix-blend-overlay dark:opacity-[0.12]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 px-6 py-12">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="max-w-xl text-center"
        >
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/70 px-3 py-1 text-[11px] font-medium text-zinc-500 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-[#9147ff]" />
            Browser-extension popup prototype
          </div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-50">Streamaxxer</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Drag campaigns by the grip to set farming priority. Switch platforms to retheme, and the popup follows your system light / dark
            preference.
          </p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 22, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
        >
          <Popup />
        </motion.div>
      </div>
    </div>
  );
}
