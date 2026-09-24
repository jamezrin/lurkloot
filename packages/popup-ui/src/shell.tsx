import React from "react";
import { ArrowUpRight, Clock3, Gamepad2, Eye, Gift, ListChecks, Package, Settings as SettingsIcon, Sparkles, Trophy } from "lucide-react";
import type { Platform, WatchSourceId } from "@lurkloot/shared/models";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { statusColor } from "./automation";
import { cn } from "./primitives";

// The workspace's destinations. Platform is a separate axis: the rail's platform
// switch applies to every view, so "which platform" and "which view" can never
// be confused for one another the way the old settingsOpen/activityOpen booleans
// were confused with the drops list.
export type PopupView = "queue" | "completed" | "games" | "watchlist" | "nopixel" | "fortnite" | "activity" | "settings";

export const POPUP_VIEWS: PopupView[] = ["queue", "completed", "games", "watchlist", "nopixel", "fortnite", "activity", "settings"];

interface NavItem {
  view: PopupView;
  labelKey: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  // Views that only exist on one platform. Extensions are Twitch-only, so the
  // rail hides the entry rather than showing a destination that would be empty.
  platform?: Platform;
}

const DROPS_ITEMS: NavItem[] = [
  { view: "queue", labelKey: "navQueue", icon: ListChecks },
  { view: "completed", labelKey: "navCompleted", icon: Trophy },
  { view: "games", labelKey: "navGames", icon: Gamepad2 },
];

// Each Twitch extension provider is its own destination: they share nothing
// but the API they are farmed through, and a shared list could only afford a
// name and a badge each. The rail lists them in the user's watch order.
const SOURCE_ITEMS: NavItem[] = [
  { view: "watchlist", labelKey: "navIdleWatchlist", icon: Eye },
  { view: "nopixel", labelKey: "navNoPixel", icon: Gift, platform: "twitch" },
  { view: "fortnite", labelKey: "navFortnite", icon: Sparkles, platform: "twitch" },
];

// The view that shows each watch source. Drops is the whole Drops group, so its
// live mark goes on the Queue.
export const WATCH_SOURCE_VIEWS: Record<WatchSourceId, PopupView> = {
  drops: "queue",
  nopixel: "nopixel",
  fortnite: "fortnite",
  idle_watchlist: "watchlist",
};

const FOOTER_ITEMS: NavItem[] = [
  { view: "activity", labelKey: "navActivity", icon: Clock3 },
  { view: "settings", labelKey: "navSettings", icon: SettingsIcon },
];

export function viewForPlatform(view: PopupView, platform: Platform): PopupView {
  const item = [...DROPS_ITEMS, ...SOURCE_ITEMS, ...FOOTER_ITEMS].find((entry) => entry.view === view);
  return item?.platform && item.platform !== platform ? "queue" : view;
}

/** The workspace rail: brand, platform switch, then one nav entry per view.
 *
 * At the popup's full width the entries carry their labels; the container query
 * below ~560px (the site's demo frame on a phone) collapses the rail to icons,
 * so the same tree serves both without a second layout. */
export function WorkspaceRail({ view, platform, counts, sourceOrder, liveSource, presentation, version, onViewChange, onPlatformChange, onOpenInventory, onOpenChangelog }: {
  view: PopupView;
  platform: Platform;
  // The platform's watch-source priority, which orders the non-drops sources,
  // and the source being watched right now, which the rail marks.
  sourceOrder: readonly WatchSourceId[];
  liveSource?: WatchSourceId;
  counts: Partial<Record<PopupView, number>>;
  presentation: Record<Platform, AutomationPresentation>;
  version: string;
  onViewChange(view: PopupView): void;
  onPlatformChange(platform: Platform): void;
  onOpenInventory(): void;
  // The release notes for this version, where the host can link to them.
  onOpenChangelog?(): void;
}): React.ReactElement {
  const t = useT();
  const liveView = liveSource ? WATCH_SOURCE_VIEWS[liveSource] : undefined;
  const sourceItems = sourceOrder
    .filter((source) => source !== "drops")
    .map((source) => SOURCE_ITEMS.find((item) => item.view === WATCH_SOURCE_VIEWS[source]))
    .filter((item): item is NavItem => Boolean(item));
  return (
    <nav
      aria-label={t("navWorkspace")}
      className="@[560px]:w-[176px] flex w-[60px] shrink-0 flex-col gap-3 border-e border-zinc-200 bg-white px-2 py-3 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 px-1">
        {/* The mark is Lurkloot's own, so it is drawn in Ember rather than in the
            platform's accent (docs/brand.md). */}
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[var(--brand)]">
          <span className="h-2.5 w-2.5 rounded-full border-[2.5px] border-[var(--brand-contrast)]" />
        </span>
        <span className="font-display @[560px]:inline hidden truncate text-[14px] font-extrabold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">Lurkloot</span>
      </div>

      <PlatformRail active={platform} presentation={presentation} onChange={onPlatformChange} />

      <NavGroup labelKey="navGroupDrops" items={DROPS_ITEMS} view={view} platform={platform} counts={counts} liveView={liveView} onViewChange={onViewChange} />
      <NavGroup labelKey="navGroupSources" items={sourceItems} view={view} platform={platform} counts={counts} liveView={liveView} onViewChange={onViewChange} />

      <div className="flex-1" />

      <div className="flex flex-col gap-0.5">
        {/* The platform's own inventory page: a way out of the popup rather than
            a destination in it, so it sits with the other bottom entries and
            carries an external-link mark instead of ever reading as current. */}
        <RailLink label={t("openInventory")} icon={Package} onClick={onOpenInventory} />
      </div>
      <NavGroup items={FOOTER_ITEMS} view={view} platform={platform} counts={counts} onViewChange={onViewChange} />
      {onOpenChangelog ? (
        <button
          type="button"
          data-rail-link="changelog"
          onClick={onOpenChangelog}
          title={t("railWhatsNew")}
          className="@[560px]:flex hidden items-center gap-1.5 rounded-lg bg-[var(--brand-soft)] px-2 py-1.5 text-start text-[11px] font-semibold text-[var(--brand-text)] outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-[var(--brand-ring)]"
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
          {t("railWhatsNew")}
          <span className="ms-auto font-mono text-[10px] font-medium opacity-80">v{version}</span>
        </button>
      ) : (
        <div className="@[560px]:block hidden px-2 font-mono text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">v{version}</div>
      )}
    </nav>
  );
}

function RailLink({ label, icon: Icon, onClick }: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onClick(): void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-rail-link="inventory"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <Icon size={14} className="shrink-0" />
      <span className="@[560px]:inline hidden truncate">{label}</span>
      <ArrowUpRight size={12} className="@[560px]:block ms-auto hidden shrink-0 text-zinc-400 dark:text-zinc-500" />
    </button>
  );
}

function NavGroup({ labelKey, items, view, platform, counts, liveView, onViewChange }: {
  labelKey?: string;
  liveView?: PopupView;
  items: NavItem[];
  view: PopupView;
  platform: Platform;
  counts: Partial<Record<PopupView, number>>;
  onViewChange(view: PopupView): void;
}): React.ReactElement {
  const t = useT();
  const visible = items.filter((item) => !item.platform || item.platform === platform);
  return (
    <div className="flex flex-col gap-0.5">
      {labelKey ? (
        <div className="@[560px]:block hidden px-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">
          {t(labelKey)}
        </div>
      ) : null}
      {visible.map((item) => {
        const Icon = item.icon;
        const label = t(item.labelKey);
        const selected = view === item.view;
        const count = counts[item.view];
        return (
          <button
            key={item.view}
            type="button"
            title={label}
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            data-view={item.view}
            onClick={() => onViewChange(item.view)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[12px] font-medium transition-colors",
              selected
                ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
            )}
          >
            <span className="relative shrink-0">
              <Icon size={14} />
              {liveView === item.view ? (
                <span
                  data-rail-live
                  role="img"
                  aria-label={t("navWatchingNow")}
                  title={t("navWatchingNow")}
                  className="absolute -end-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--accent)] ring-2 ring-white dark:ring-zinc-900"
                />
              ) : null}
            </span>
            <span className="@[560px]:inline hidden truncate">{label}</span>
            {count === undefined ? null : (
              <span className="@[560px]:inline ms-auto hidden font-mono text-[10.5px] text-zinc-400 tabular dark:text-zinc-500">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The platform switch: Twitch and Kick side by side, each with its status dot.
 *
 * Turning a platform on or off is the strip's switch, beside what that
 * platform is doing; here a platform is only picked. The dot still says how
 * the other platform is getting on without switching to it. */
function PlatformRail({ active, presentation, onChange }: {
  active: Platform;
  presentation: Record<Platform, AutomationPresentation>;
  onChange(platform: Platform): void;
}): React.ReactElement {
  const t = useT();
  const platformIds = Object.keys(PLATFORMS) as Platform[];
  return (
    <div role="tablist" aria-label={t("navPlatform")} className="@[560px]:grid-cols-2 grid grid-cols-1 gap-0.5 rounded-[10px] border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-950">
      {platformIds.map((id) => {
        const details = PLATFORMS[id];
        const status = presentation[id];
        const indicatorColor = statusColor(status, details.color);
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={details.label}
            data-platform-status={id}
            data-state={status.state}
            onClick={() => onChange(id)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
              selected ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
          >
            <span
              aria-hidden
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ backgroundColor: indicatorColor ?? details.color, opacity: indicatorColor ? 1 : 0.35 }}
            />
            <span className="@[560px]:inline hidden truncate">{details.label}</span>
          </button>
        );
      })}
    </div>
  );
}
