import React, { useEffect, useState } from "react";
import { Ban, ChevronDown, type LucideIcon } from "lucide-react";
import type { CampaignFilterKey } from "@lurkloot/shared/models";
import { LOG_LEVELS, type LogLevel } from "@lurkloot/shared/logging";
import {
  CAMPAIGN_FILTERS,
  COLLAPSED_SETTINGS_SECTIONS_KEY,
  EVENT_LEVEL_COLOR,
} from "./constants";
import { usePopupRuntime, useT } from "./context";
import { Toggle, cn } from "./primitives";

export function SettingsSection({ title, description, icon: Icon, iconNode, divided = true, children }: { title: string; description?: string; icon?: LucideIcon; iconNode?: React.ReactNode; divided?: boolean; children: React.ReactNode }) {
  const { adapter, preview } = usePopupRuntime();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      if (!mounted) return;
      const collapsed = stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean | undefined> | undefined;
      setExpanded(collapsed?.[title] === false);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview, title]);

  function toggleExpanded(): void {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (preview) return;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      const collapsed = {
        ...((stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean> | undefined) ?? {}),
        [title]: !nextExpanded,
      };
      void adapter.setStorage({ [COLLAPSED_SETTINGS_SECTIONS_KEY]: collapsed });
    });
  }

  return (
    <section>
      <header className="mb-1.5 px-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex w-full items-start justify-between gap-3 rounded-lg px-1 py-1 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-900/70"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              {iconNode ?? (Icon ? <Icon size={13} className="text-zinc-400 dark:text-zinc-500" /> : null)}
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</span>
            </span>
            {description ? <span className="mt-1 block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">{description}</span> : null}
          </span>
          <ChevronDown size={14} className={cn("mt-0.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500", expanded && "rotate-180")} />
        </button>
      </header>
      {expanded ? <div className={divided ? "divide-y divide-zinc-100 px-0.5 dark:divide-zinc-800/70" : "space-y-3 px-0.5"}>{children}</div> : null}
    </section>
  );
}

export function SettingRow({ title, description, checked, onChange, disabled = false, disabledReason }: {
  title: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")} title={disabled ? disabledReason : undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

// Per-level control over what gets recorded in the Activity log. Errors are
// always kept so failures are never silently dropped, so that pill is locked on.
export function LogLevelSettingRow({ value, onChange }: { value: LogLevel[]; onChange(levels: LogLevel[]): void | Promise<void> }) {
  const t = useT();
  const enabled = new Set(value);
  const toggle = (level: LogLevel) => {
    const next = new Set(enabled);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    next.add("error");
    onChange(LOG_LEVELS.filter((l) => next.has(l)));
  };
  return (
    <div className="py-2.5">
      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("activityLogLevelsTitle")}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {t("activityLogLevelsDescription")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {LOG_LEVELS.map((level) => {
          const active = enabled.has(level) || level === "error";
          const locked = level === "error";
          return (
            <button
              key={level}
              type="button"
              disabled={locked}
              onClick={locked ? undefined : () => toggle(level)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition ${active
                ? "border-transparent text-white"
                : "border-zinc-200 text-zinc-400 dark:border-zinc-700"} ${locked ? "cursor-default opacity-90" : ""}`}
              style={active ? { backgroundColor: EVENT_LEVEL_COLOR[level] } : undefined}
              aria-pressed={active}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "#ffffff" : EVENT_LEVEL_COLOR[level] }} />
              {t(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Controls which campaign states appear in the Drops list. A state with its pill
// turned off is hidden; campaigns in none of these states are always shown.
export function CampaignFilterSettingRow({ value, onChange }: { value: Record<CampaignFilterKey, boolean>; onChange(value: Record<CampaignFilterKey, boolean>): void | Promise<void> }) {
  const t = useT();
  const toggle = (key: CampaignFilterKey) => onChange({ ...value, [key]: !value[key] });
  return (
    <div className="py-2.5">
      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("visibleCampaignsTitle")}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        {t("visibleCampaignsDescription")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {CAMPAIGN_FILTERS.map(({ key, label }) => {
          const active = value[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition ${active
                ? "border-transparent text-white"
                : "border-zinc-200 text-zinc-400 dark:border-zinc-700"}`}
              style={active ? { backgroundColor: "var(--accent)" } : undefined}
              aria-pressed={active}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "#ffffff" : "var(--accent)" }} />
              {t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ForgetExcludedCampaignsRow({ count, onForget }: { count: number; onForget(): void | Promise<void> }) {
  const t = useT();
  const disabled = count === 0;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("forgetExcludedTitle")}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {t("forgetExcludedDescription")}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onForget()}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
          disabled
            ? "border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
            : "border-red-500/30 text-red-600 hover:border-red-500/60 hover:bg-red-500/5 dark:text-red-400",
        )}
      >
        <Ban size={12} />
        {t("forget")}
        <span className="tabular">{count}</span>
      </button>
    </div>
  );
}

export function SelectSettingRow<T extends string>({ title, description, value, options, onChange, disabled = false, disabledReason }: {
  title: string;
  description: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")} title={disabled ? disabledReason : undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <label className={cn("flex shrink-0 items-center rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-500 focus-within:border-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400", disabled && "cursor-not-allowed")}>
        <select
          aria-label={title}
          disabled={disabled}
          value={value}
          onChange={(event) => void onChange(event.target.value as T)}
          className={cn("bg-transparent pr-1 outline-none", disabled && "cursor-not-allowed")}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function NumberSettingRow({ title, description, value, min, max, suffix, onChange }: { title: string; description: string; value: number; min: number; max: number; suffix: string; onChange(value: number): void | Promise<void> }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit(rawValue = draft): void {
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(nextValue)));
    setDraft(String(clamped));
    void onChange(clamped);
  }

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <label className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-500 focus-within:border-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <input
          aria-label={title}
          type="number"
          min={min}
          max={max}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-12 bg-transparent text-right text-xs font-semibold tabular text-zinc-900 outline-none dark:text-zinc-100"
        />
        {suffix}
      </label>
    </div>
  );
}
