import React, { useEffect, useState } from "react";
import { Ban, ChevronDown, Lock, Minus, Plus } from "lucide-react";
import { NumberField } from "@base-ui/react/number-field";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import {
  COLLAPSED_SETTINGS_SECTIONS_KEY,
} from "./constants";
import { usePopupRuntime, useT } from "./context";
import { SearchBox, Toggle, cn } from "./primitives";
import { Dropdown } from "./dropdown";
import { Tip } from "./tooltip";

export function SettingsSection({ id, title, description, badge, forceExpanded, children }: {
  // Stable, locale-independent identity. Collapse state is keyed by this, not by
  // the translated title, so changing language does not reset the accordion.
  id: string;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  // While searching, sections holding matches are opened regardless of the
  // persisted state, and the persisted state is left untouched.
  forceExpanded?: boolean;
  children: React.ReactNode;
}) {
  const { adapter, preview } = usePopupRuntime();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (preview) return;
    let mounted = true;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      if (!mounted) return;
      const map = stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean | undefined> | undefined;
      setCollapsed(map?.[id] === true);
    });
    return () => {
      mounted = false;
    };
  }, [adapter, preview, id]);

  function toggleCollapsed(): void {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    if (preview) return;
    void adapter.getStorage(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      const map = (stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean> | undefined) ?? {};
      const next = { ...map, [id]: nextCollapsed };
      void adapter.setStorage({ [COLLAPSED_SETTINGS_SECTIONS_KEY]: next });
    });
  }

  const expanded = forceExpanded || !collapsed;

  // At full width an open section's name and purpose sit in a label column
  // beside its rows, so the width goes to the settings rather than to stacked
  // headings. A folded section has no rows, so its header spans the full width:
  // the name stays in the label column and the description moves into the
  // content column, one compact line aligned with the open sections. The same
  // button is kept across both states so focus survives the toggle.
  return (
    <section id={`settings-section-${id}`} className={cn("@[520px]:grid-cols-[8.5rem_minmax(0,1fr)] grid scroll-mt-2 grid-cols-1 gap-x-5 border-t border-zinc-200 first:border-t-0 first:pt-0 dark:border-zinc-800", expanded ? "pt-3" : "pt-2")}>
      <header className={expanded ? "@[520px]:mb-0 mb-1.5" : "col-span-full"}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleCollapsed}
          className={cn(
            "group grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
            !expanded && "@[520px]:grid-cols-[8.5rem_minmax(0,1fr)_auto] @[520px]:gap-x-5",
          )}
        >
          <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5">
            <span data-settings-section-title className="font-display text-[12.5px] font-bold leading-tight text-zinc-900 dark:text-zinc-50">{title}</span>
            {badge}
          </span>
          {description ? (
            <span className={cn("col-start-1 row-start-2 mt-1 block min-w-0 text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400", !expanded && "@[520px]:col-start-2 @[520px]:row-start-1 @[520px]:mt-0.5 truncate")}>{description}</span>
          ) : null}
          {/* Shown on hover and focus while open, as the prototype has no
              arrows; always shown while collapsed, so a folded section says so. */}
          <ChevronDown size={13} className={cn("col-start-2 row-start-1 mt-0.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500", expanded ? "rotate-180 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "@[520px]:col-start-3")} />
        </button>
      </header>
      {expanded ? <div className="min-w-0 space-y-3 pb-2">{children}</div> : null}
    </section>
  );
}

// A labelled divider inside the flat settings flow. Groups do not collapse:
// search is the direct route to a long page, and all advanced settings remain
// available without a separate visual warning state. The anchor id sits on the
// group itself rather than on a wrapper, so `first:` only matches the real first
// group and every later group keeps its divider.
export function SettingsGroup({ id, title, description, badge, children }: {
  id?: string;
  title: string;
  // Groups whose whole body is one editor carry that editor's subtitle and count
  // here, so the editor itself renders bare instead of repeating the heading.
  description?: string;
  badge?: React.ReactNode;
  advanced?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div id={id ? `settings-group-${id}` : undefined} className="mt-2 border-t border-zinc-200 pt-3 first:mt-0 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</span>
        {badge}
      </div>
      {description ? <p className="mb-1.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p> : null}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</div>
    </div>
  );
}

export function SettingsSearchBox({ value, onChange, autoFocus = false, compact = false }: { value: string; onChange(value: string): void; autoFocus?: boolean; compact?: boolean }) {
  const t = useT();
  return <SearchBox autoFocus={autoFocus} compact={compact} value={value} onChange={onChange} placeholder={t("settingsSearchPlaceholder")} />;
}

export function AdvancedSettingsSwitch({ checked, onChange }: { checked: boolean; onChange(value: boolean): void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{t("settingsShowAdvancedTitle")}</span>
      <Toggle checked={checked} onChange={onChange} label={t("settingsShowAdvancedTitle")} />
    </div>
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
    <Tip label={disabled ? disabledReason : undefined}>
      <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5", disabled && "opacity-60")}>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</div>
          <div className="mt-0.5 max-w-[46ch] text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
        </div>
        <Toggle size="sm" checked={checked} onChange={onChange} label={title} disabled={disabled} />
      </div>
    </Tip>
  );
}


export function ForgetExcludedCampaignsRow({ count, onForget }: { count: number; onForget(): void | Promise<void> }) {
  const t = useT();
  const disabled = count === 0;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{t("forgetExcludedTitle")}</div>
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

// The bare select control: the popup's own dropdown, since the OS menu of a
// native <select> cannot follow the popup's theme. It is capped and allowed to
// shrink; long labels ellipsize instead of squeezing whatever sits beside it,
// and the full label stays available on hover.
export function SelectControl<T extends string>({ label, value, options, onChange, disabled = false, disabledReason }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="@[520px]:max-w-[15rem] min-w-[9.5rem] max-w-[11rem] shrink-0">
      <Dropdown
        label={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-700 hover:border-zinc-300 focus-visible:border-[var(--accent-ring)] aria-expanded:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600"
      />
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
    <Tip label={disabled ? disabledReason : undefined}>
      <div className={cn("flex items-center gap-4 py-2.5", disabled && "opacity-60")}>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
        </div>
        <SelectControl label={title} value={value} options={options} onChange={onChange} disabled={disabled} disabledReason={disabledReason} />
      </div>
    </Tip>
  );
}

// A whole-number setting on Base UI's NumberField: typing, arrow keys (Shift for
// tens), and the − / + buttons all clamp to min/max, and the value is saved once
// it is committed — on blur, Enter, or a step — rather than on every keystroke.
export function NumberSettingRow({ title, description, value, min, max, suffix, onChange, disabled = false, disabledReason }: { title: string; description: string; value: number; min: number; max: number; suffix: string; onChange(value: number): void | Promise<void>; disabled?: boolean; disabledReason?: string }) {
  const [draft, setDraft] = useState<number | null>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const stepButton = "grid h-5 w-5 shrink-0 place-items-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
  return (
    <Tip label={disabled ? disabledReason : undefined}>
      <div className={cn("flex items-center gap-3 py-2.5", disabled && "opacity-60")}>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
        </div>
        <NumberField.Root
          value={draft}
          min={min}
          max={max}
          step={1}
          largeStep={10}
          format={{ maximumFractionDigits: 0, useGrouping: false }}
          disabled={disabled}
          onValueChange={(next) => setDraft(next)}
          onValueCommitted={(next) => {
            if (next === null) {
              setDraft(value);
              return;
            }
            const clamped = Math.min(max, Math.max(min, Math.round(next)));
            setDraft(clamped);
            if (clamped !== value) void onChange(clamped);
          }}
          className={cn("shrink-0", disabled && "cursor-not-allowed")}
        >
          <NumberField.Group className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 text-[11px] font-semibold text-zinc-500 focus-within:border-[var(--accent-ring)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            <NumberField.Decrement aria-label={`${title} −`} className={stepButton}>
              <Minus size={11} aria-hidden />
            </NumberField.Decrement>
            <NumberField.Input
              aria-label={title}
              className="w-9 bg-transparent text-center text-xs font-semibold tabular text-zinc-900 outline-none dark:text-zinc-100"
            />
            <NumberField.Increment aria-label={`${title} +`} className={stepButton}>
              <Plus size={11} aria-hidden />
            </NumberField.Increment>
            <span className="pe-1.5 ps-0.5">{suffix}</span>
          </NumberField.Group>
        </NumberField.Root>
      </div>
    </Tip>
  );
}

// A setting that lives in another view: its name and what it does, and the way
// there. Settings points at Games rather than keeping a second category editor.
export function SettingsLinkRow({ title, description, action, onClick }: { title: string; description: string; action: string; onClick?(): void }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 max-w-[46ch] text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      {onClick ? (
        <button
          type="button"
          data-settings-link
          onClick={onClick}
          className="shrink-0 rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:border-[var(--accent-ring)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-700"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}
