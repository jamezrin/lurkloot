import React from "react";
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { motion } from "motion/react";
import { ChevronRight, GripVertical, Search, X, type LucideIcon } from "lucide-react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function moveById<T extends { id: string }>(list: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return list;
  const oldIndex = list.findIndex((item) => item.id === activeId);
  const newIndex = list.findIndex((item) => item.id === overId);
  if (oldIndex === -1 || newIndex === -1) return list;
  return arrayMove(list, oldIndex, newIndex);
}

// `compact` only trims the vertical padding — the icon offset and left padding
// classes stay put because styles.css mirrors those exact class names for RTL.
export function SearchBox({ value, onChange, placeholder, autoFocus = false, compact = false }: { value: string; onChange(value: string): void; placeholder: string; autoFocus?: boolean; compact?: boolean }) {
  return (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
      <input
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={placeholder}
        placeholder={placeholder}
        className={cn("w-full rounded-xl border border-zinc-200 bg-white pl-8 pr-3 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100", compact ? "py-1" : "py-2")}
      />
    </div>
  );
}

export function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

export function ImageWithFallback({ src, alt, className, fit = "cover", fallback }: { src?: string; alt: string; className?: string; fit?: "cover" | "contain"; fallback: React.ReactNode }) {
  const [failed, setFailed] = React.useState(false);
  if (!src || failed) return <>{fallback}</>;
  return <img src={src} alt={alt} loading="lazy" className={cn("h-full w-full", fit === "cover" ? "object-cover" : "object-contain", className)} onError={() => setFailed(true)} />;
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange(value: boolean): void | Promise<void>; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => void onChange(!checked)} className={cn("relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]", checked ? "" : "bg-zinc-200 dark:bg-zinc-700", disabled && "cursor-not-allowed opacity-70")} style={checked ? { backgroundColor: "var(--accent)" } : undefined}>
      <motion.span layout transition={{ type: "spring", stiffness: 550, damping: 32 }} className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" style={{ marginLeft: checked ? 16 : 0 }} />
    </button>
  );
}

export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "live" | "warning" | "danger" | "outline" }) {
  const tones = {
    muted: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    outline: "border border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
    accent: "bg-[var(--accent-soft)] text-[var(--accent-text)]",
    live: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
    danger: "bg-red-500/12 text-red-600 dark:text-red-400",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap", tones[tone])}>{children}</span>;
}

export function IconButton({ children, label, active, disabled, onClick }: { children: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick(): void }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled} className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]", disabled ? "text-zinc-300 dark:text-zinc-700" : active ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200")}>{children}</button>;
}

export function RemoveRowButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors outline-none hover:bg-red-500/10 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500 dark:hover:text-red-400"
    >
      <X size={13} />
    </button>
  );
}

export function DragHandle({ setActivatorNodeRef, attributes, listeners, label }: { setActivatorNodeRef(element: HTMLElement | null): void; attributes: React.ButtonHTMLAttributes<HTMLButtonElement>; listeners?: Record<string, unknown>; label: string }) {
  return (
    <button ref={setActivatorNodeRef} type="button" aria-label={label} {...attributes} {...listeners} onClick={(event) => event.stopPropagation()} className="flex cursor-grab touch-none items-center justify-center rounded-md text-zinc-300 transition-colors outline-none hover:text-zinc-500 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] active:cursor-grabbing dark:text-zinc-600 dark:hover:text-zinc-400" style={{ touchAction: "none", userSelect: "none" }}>
      <GripVertical size={16} />
    </button>
  );
}

/** One row of chrome above the lists: what they hold, and the two actions that
 * used to each cost a row of their own (a permanent search field and a pair of
 * view tabs). */
export function ListToolbar({ counts, actions }: { counts: Array<{ label: string; value: string }>; actions: React.ReactNode }) {
  return (
    <div className="mt-1.5 flex h-7 items-center gap-1">
      <span className="min-w-0 truncate text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        {counts.map((count, index) => (
          <React.Fragment key={count.label}>
            {index > 0 ? <span className="text-zinc-300 dark:text-zinc-600"> · </span> : null}
            {count.label} <span className="font-bold tabular text-zinc-700 dark:text-zinc-200">{count.value}</span>
          </React.Fragment>
        ))}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>
    </div>
  );
}

/** Collapsible group heading, used to fold the Idle Watchlist under the drops
 * list instead of hiding it behind a tab. */
export function SectionHeader({ label, count, expanded, icon: Icon, onToggle }: { label: string; count: string; expanded: boolean; icon: LucideIcon; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-[11px] font-semibold text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.18 }} className="flex shrink-0 items-center">
        <ChevronRight size={13} />
      </motion.span>
      <Icon size={13} style={{ color: "var(--accent-text)" }} />
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 tabular text-zinc-400 dark:text-zinc-500">{count}</span>
    </button>
  );
}

export function ProgressBar({ value, size = "md", glow = false }: { value: number; size?: "sm" | "md" | "edge"; glow?: boolean }) {
  const edge = size === "edge";
  return (
    <div className={cn("w-full overflow-hidden bg-zinc-200/70 dark:bg-zinc-700/60", edge ? "h-[3px]" : "rounded-full", size === "sm" ? "h-1" : size === "md" ? "h-1.5" : "")}>
      <motion.div className={cn("h-full", !edge && "rounded-full")} initial={{ width: 0 }} animate={{ width: `${Math.max(value, value > 0 ? 4 : 0)}%` }} transition={{ duration: 0.5 }} style={{ backgroundColor: "var(--accent)", boxShadow: glow && value > 0 ? "0 0 10px -1px var(--accent-glow)" : undefined }} />
    </div>
  );
}

export function MetaStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60">
      <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase text-zinc-400 dark:text-zinc-500"><Icon size={11} /> {label}</div>
      <div className="truncate text-xs font-semibold tabular text-zinc-800 dark:text-zinc-100">{value}</div>
    </div>
  );
}

export function EmptyPanel({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-24 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-white p-4 text-center text-sm font-semibold text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">{children}</div>;
}

export function CompactRow({
  avatar,
  avatarImageUrl,
  avatarStyle,
  index,
  title,
  titleHref,
  subtitle,
  trailing,
  dragHandle,
  isOverlay = false,
  dimmed = false,
}: {
  avatar: string;
  avatarImageUrl?: string;
  avatarStyle: React.CSSProperties;
  index: number;
  title: string;
  titleHref?: string;
  subtitle?: string;
  trailing: React.ReactNode;
  dragHandle: React.ReactNode;
  isOverlay?: boolean;
  dimmed?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border bg-white px-2 py-2 dark:bg-zinc-900", isOverlay ? "border-transparent shadow-2xl shadow-black/25" : "border-zinc-200 shadow-sm dark:border-zinc-800", dimmed && "opacity-40")}>
      {dragHandle}
      <span className="w-4 text-center text-[11px] font-bold tabular" style={{ color: "var(--accent-text)" }}>{index + 1}</span>
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center text-[11px] font-bold",
          avatarImageUrl ? "overflow-hidden rounded-lg" : "rounded-full",
        )}
        style={avatarStyle}
      >
        <ImageWithFallback
          src={avatarImageUrl}
          alt=""
          fit="cover"
          fallback={avatar}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {titleHref ? (
          <a href={titleHref} target="_blank" rel="noreferrer" className="truncate text-[13px] font-medium leading-tight text-zinc-900 outline-none hover:text-[var(--accent-text)] hover:underline focus-visible:text-[var(--accent-text)] dark:text-zinc-100">{title}</a>
        ) : (
          <span className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">{title}</span>
        )}
        {subtitle ? <span className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{subtitle}</span> : null}
      </span>
      {trailing}
    </div>
  );
}
