import React from "react";
import {
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  Clock3,
  Gamepad2,
  Eye,
  Gift,
  ListChecks,
  Package,
  Settings as SettingsIcon,
  Sparkles,
  Trophy,
} from "lucide-react";
import type { Platform, WatchSourceId } from "@lurkloot/shared/models";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { type PopupHostCapabilities, useHostCapabilities } from "./hostCapabilities";
import { statusColor } from "./automation";
import { LurklootMark } from "./mark";
import { cn } from "./primitives";
import { Tabs } from "@base-ui/react/tabs";
import { Tip } from "./tooltip";

// The workspace's destinations. Platform is a separate axis: the rail's platform
// switch applies to every view, so "which platform" and "which view" can never
// be confused for one another the way the old settingsOpen/activityOpen booleans
// were confused with the drops list.
export type PopupView =
  | "queue"
  | "completed"
  | "games"
  | "watchlist"
  | "nopixel"
  | "fortnite"
  | "activity"
  | "settings";

export const POPUP_VIEWS: PopupView[] = [
  "queue",
  "completed",
  "games",
  "watchlist",
  "nopixel",
  "fortnite",
  "activity",
  "settings",
];

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

const COMBINED_DROPS_ITEMS: NavItem[] = [
  { view: "queue", labelKey: "navGroupDrops", icon: ListChecks },
];

// Each Twitch extension provider is its own destination: they share nothing
// but the API they are farmed through, and a shared list could only afford a
// name and a badge each. They have a group of their own; the other watch
// sources follow in another. Each group lists its entries in the user's watch
// order.
const EXTENSION_ITEMS: NavItem[] = [
  { view: "nopixel", labelKey: "navNoPixel", icon: Gift, platform: "twitch" },
  { view: "fortnite", labelKey: "navFortnite", icon: Sparkles, platform: "twitch" },
];
const OTHER_ITEMS: NavItem[] = [{ view: "watchlist", labelKey: "navWatchlist", icon: Eye }];
const SOURCE_ITEMS: NavItem[] = [...EXTENSION_ITEMS, ...OTHER_ITEMS];

// The view that shows each watch source. Drops is the whole Drops group, so its
// live mark goes on the Queue.
export const WATCH_SOURCE_VIEWS: Record<WatchSourceId, PopupView> = {
  drops: "queue",
  nopixel: "nopixel",
  fortnite: "fortnite",
  // Watch streaks are rows of the watchlist, so they share its view.
  watch_streaks: "watchlist",
  watchlist: "watchlist",
};

// How the rail shows its labels. The popup's rail follows its frame's width
// ("auto": a container query collapses it to icons below ~560px); a window
// frame's sidebar is expanded or collapsed by the user. Each class is a full
// literal so Tailwind's scanner sees it.
type RailMode = "auto" | "expanded" | "collapsed";
const RailModeContext = React.createContext<RailMode>("auto");
const RAIL_INLINE: Record<RailMode, string> = {
  auto: "@[560px]:inline hidden",
  expanded: "inline",
  collapsed: "hidden",
};
const RAIL_BLOCK: Record<RailMode, string> = {
  auto: "@[560px]:block hidden",
  expanded: "block",
  collapsed: "hidden",
};
const RAIL_FLEX: Record<RailMode, string> = {
  auto: "@[560px]:flex hidden",
  expanded: "flex",
  collapsed: "hidden",
};

/** A window frame's sidebar state: collapsed to icons or showing labels, and
 * the toggle between them. Without it the rail is the popup's. */
export interface RailSidebar {
  collapsed: boolean;
  onToggleCollapsed(): void;
}

const FOOTER_ITEMS: NavItem[] = [
  { view: "activity", labelKey: "navActivity", icon: Clock3 },
  { view: "settings", labelKey: "navSettings", icon: SettingsIcon },
];

/** A destination a host adds to the rail, after Activity and Settings: the
 * CLI app's Accounts, for one. The host renders it inside the frame, so it can
 * read the frame's translator and capabilities. */
export interface PopupHostView {
  id: string;
  labelKey: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  render(): React.ReactNode;
}

/** The view a host can show: one of a capability it lacks falls back to the
 * Queue, so no stored or requested view lands on a hidden destination. */
export function viewForHost(
  view: PopupView,
  capabilities: Readonly<PopupHostCapabilities>,
): PopupView {
  return !capabilities.twitchExtensions && EXTENSION_ITEMS.some((item) => item.view === view)
    ? "queue"
    : view;
}

export function viewForPlatform(view: PopupView, platform: Platform): PopupView {
  const item = [...DROPS_ITEMS, ...SOURCE_ITEMS, ...FOOTER_ITEMS].find(
    (entry) => entry.view === view,
  );
  return item?.platform && item.platform !== platform ? "queue" : view;
}

/** The workspace rail: brand, platform switch, then one nav entry per view.
 *
 * At the popup's full width the entries carry their labels; the container query
 * below ~560px (the site's demo frame on a phone) collapses the rail to icons,
 * so the same tree serves both without a second layout.
 *
 * As a window frame's sidebar (`sidebar`), the platform switch lives in the
 * window's header instead, and the user collapses the rail to icons or
 * expands it to labels with the toggle at its foot. */
export function WorkspaceRail({
  view,
  platform,
  counts,
  sourceOrder,
  liveSource,
  presentation,
  version,
  onViewChange,
  onPlatformChange,
  onOpenInventory,
  onOpenChangelog,
  hostViews = [],
  hostView,
  onHostViewChange,
  combineDropViews = false,
  sidebar,
}: {
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
  // The host's own destinations, and the one open, if any. While one is open
  // no built-in entry reads as current.
  hostViews?: readonly PopupHostView[];
  hostView?: string;
  onHostViewChange?(id: string): void;
  // Completed and Games are part of the Queue view (a window frame's combined
  // drops page), so the rail lists Queue alone in its drops group.
  combineDropViews?: boolean;
  // Set in a window frame: the rail is its collapsible sidebar.
  sidebar?: RailSidebar;
}): React.ReactElement {
  const t = useT();
  const hostCapabilities = useHostCapabilities();
  const mode: RailMode = sidebar ? (sidebar.collapsed ? "collapsed" : "expanded") : "auto";
  const currentView = hostView ? undefined : view;
  const liveView = liveSource ? WATCH_SOURCE_VIEWS[liveSource] : undefined;
  const inWatchOrder = (items: NavItem[]): NavItem[] =>
    sourceOrder
      // Watch streaks share the watchlist's view; the rail follows the watchlist.
      .filter((source) => source !== "watch_streaks")
      .map((source) => items.find((item) => item.view === WATCH_SOURCE_VIEWS[source]))
      .filter((item): item is NavItem => Boolean(item));
  return (
    <RailModeContext.Provider value={mode}>
      <nav
        id={sidebar ? "window-sidebar" : undefined}
        aria-label={t("navWorkspace")}
        data-tour="rail"
        {...(sidebar ? { "data-sidebar": mode } : {})}
        className={cn(
          "rail flex shrink-0 flex-col gap-3 border-e border-[var(--rail-edge)] px-2 text-zinc-400",
          mode === "auto" && "@[560px]:w-[176px] w-[60px] py-3",
          // The sidebar's brand row is as tall as the window's header beside it.
          mode === "expanded" && "nice-scroll w-[220px] overflow-y-auto pb-3",
          mode === "collapsed" && "nice-scroll w-[60px] overflow-y-auto pb-3",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 px-1",
            sidebar ? "-mx-2 h-[58px] shrink-0 border-b border-[var(--rail-edge)] px-3" : "pt-0.5",
            mode === "collapsed" && "justify-center px-0",
          )}
        >
          <LurklootMark size={26} className="shrink-0" />
          <span
            className={cn(
              "font-display truncate text-[15px] font-bold tracking-[-0.02em] text-white",
              RAIL_INLINE[mode],
            )}
          >
            Lurkloot
          </span>
        </div>

        {sidebar ? null : (
          <PlatformRail active={platform} presentation={presentation} onChange={onPlatformChange} />
        )}

        <NavGroup
          // Combined, the Queue is the whole drops page: one entry, named for
          // it, needs no group heading.
          labelKey={combineDropViews ? undefined : "navGroupDrops"}
          items={combineDropViews ? COMBINED_DROPS_ITEMS : DROPS_ITEMS}
          view={currentView}
          platform={platform}
          counts={counts}
          liveView={liveView}
          onViewChange={onViewChange}
        />
        <NavGroup
          labelKey="navExtensions"
          tourId="rail-extensions"
          items={hostCapabilities.twitchExtensions ? inWatchOrder(EXTENSION_ITEMS) : []}
          view={currentView}
          platform={platform}
          counts={counts}
          liveView={liveView}
          onViewChange={onViewChange}
        />
        <NavGroup
          labelKey="navGroupOthers"
          items={inWatchOrder(OTHER_ITEMS)}
          view={currentView}
          platform={platform}
          counts={counts}
          liveView={liveView}
          onViewChange={onViewChange}
        />

        <div className="flex-1" />

        <div className="flex flex-col gap-0.5">
          {/* The platform's own inventory page: a way out of the popup rather than
            a destination in it, so it sits with the other bottom entries and
            carries an external-link mark instead of ever reading as current. */}
          <RailLink label={t("openInventory")} icon={Package} onClick={onOpenInventory} />
        </div>
        <NavGroup
          items={FOOTER_ITEMS}
          view={currentView}
          platform={platform}
          counts={counts}
          onViewChange={onViewChange}
        />
        {hostViews.length > 0 ? (
          <div data-rail-group="host" className="flex flex-col gap-0.5">
            {hostViews.map((entry) => (
              <NavButton
                key={entry.id}
                label={t(entry.labelKey)}
                icon={entry.icon}
                selected={hostView === entry.id}
                attributes={{ "data-host-view": entry.id }}
                onClick={() => onHostViewChange?.(entry.id)}
              />
            ))}
          </div>
        ) : null}
        {onOpenChangelog ? (
          <button
            type="button"
            data-rail-link="changelog"
            onClick={onOpenChangelog}
            className={cn(
              "rail-selected items-center gap-1.5 rounded-lg px-2 py-1.5 text-start text-[11px] font-semibold text-zinc-100 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40",
              RAIL_FLEX[mode],
            )}
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
            {t("railWhatsNew")}
            <span className="ms-auto font-mono text-[10px] font-medium text-zinc-400">
              v{version}
            </span>
          </button>
        ) : (
          <div
            className={cn(
              "px-2 font-mono text-[10px] leading-tight text-zinc-500",
              RAIL_BLOCK[mode],
            )}
          >
            v{version}
          </div>
        )}
        {sidebar ? <SidebarToggle sidebar={sidebar} /> : null}
      </nav>
    </RailModeContext.Provider>
  );
}

function SidebarToggle({ sidebar }: { sidebar: RailSidebar }): React.ReactElement {
  const t = useT();
  const label = t(sidebar.collapsed ? "navSidebarExpand" : "navSidebarCollapse");
  const Icon = sidebar.collapsed ? PanelLeftOpen : PanelLeftClose;
  const button = (
    <button
      type="button"
      data-sidebar-toggle
      aria-label={label}
      aria-expanded={!sidebar.collapsed}
      aria-controls="window-sidebar"
      onClick={sidebar.onToggleCollapsed}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border-t border-[var(--rail-edge)] px-2 pt-2.5 pb-1 text-start text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-white/40",
        sidebar.collapsed && "justify-center",
      )}
    >
      <Icon size={15} className="shrink-0 rtl:-scale-x-100" />
      {sidebar.collapsed ? null : <span className="truncate">{label}</span>}
    </button>
  );
  return sidebar.collapsed ? <Tip label={label}>{button}</Tip> : button;
}

function RailLink({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onClick(): void;
}): React.ReactElement {
  const mode = React.useContext(RailModeContext);
  const button = (
    <button
      type="button"
      aria-label={label}
      data-rail-link="inventory"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-start text-[12px] font-medium text-zinc-400 outline-none transition-colors hover:bg-white/[0.05] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-white/40",
        mode === "collapsed" && "justify-center",
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className={cn("truncate", RAIL_INLINE[mode])}>{label}</span>
      <ArrowUpRight size={12} className={cn("ms-auto shrink-0 text-zinc-600", RAIL_BLOCK[mode])} />
    </button>
  );
  return mode === "collapsed" ? <Tip label={label}>{button}</Tip> : button;
}

function NavGroup({
  labelKey,
  tourId,
  items,
  view,
  platform,
  counts,
  liveView,
  onViewChange,
}: {
  labelKey?: string;
  // The onboarding tour's anchor for the group.
  tourId?: string;
  liveView?: PopupView;
  items: NavItem[];
  view: PopupView | undefined;
  platform: Platform;
  counts: Partial<Record<PopupView, number>>;
  onViewChange(view: PopupView): void;
}): React.ReactElement | null {
  const t = useT();
  const mode = React.useContext(RailModeContext);
  const visible = items.filter((item) => !item.platform || item.platform === platform);
  // A group with nothing on this platform (Extensions on Kick) is left out
  // whole, heading included.
  if (visible.length === 0) return null;
  return (
    <div data-rail-group={labelKey} data-tour={tourId} className="flex flex-col gap-0.5">
      {labelKey ? (
        <div
          className={cn(
            "px-2 pb-1 text-[10.5px] font-medium tracking-[0.01em] text-zinc-500",
            RAIL_BLOCK[mode],
          )}
        >
          {t(labelKey)}
        </div>
      ) : null}
      {visible.map((item) => (
        <NavButton
          key={item.view}
          label={t(item.labelKey)}
          icon={item.icon}
          selected={view === item.view}
          live={liveView === item.view}
          count={counts[item.view]}
          attributes={{ "data-view": item.view }}
          onClick={() => onViewChange(item.view)}
        />
      ))}
    </div>
  );
}

function NavButton({
  label,
  icon: Icon,
  selected,
  live = false,
  count,
  attributes,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  selected: boolean;
  live?: boolean;
  count?: number;
  attributes: Record<`data-${string}`, string>;
  onClick(): void;
}): React.ReactElement {
  const t = useT();
  const mode = React.useContext(RailModeContext);
  const collapsed = mode === "collapsed";
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-current={selected ? "page" : undefined}
      {...attributes}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-start text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40",
        selected
          ? "rail-selected border-transparent text-white"
          : "border-transparent text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100",
        collapsed && "justify-center",
      )}
    >
      <span className="relative shrink-0">
        <Icon size={14} />
        {live ? (
          <Tip label={t("navWatchingNow")}>
            <span
              data-rail-live
              role="img"
              aria-label={t("navWatchingNow")}
              className="absolute -end-1 -top-1 h-1.5 w-1.5 rounded-full bg-white ring-2 ring-[var(--rail-bg)]"
            />
          </Tip>
        ) : null}
        {/* Collapsed to an icon, the count rides on it as a badge. */}
        {collapsed && count ? (
          <span
            aria-hidden
            data-rail-count-badge
            className="tabular absolute -bottom-1.5 -end-2.5 min-w-[15px] rounded-full bg-zinc-700 px-1 text-center font-mono text-[9px] leading-[13px] font-semibold text-zinc-100 ring-2 ring-[var(--rail-bg)]"
          >
            {count}
          </span>
        ) : null}
      </span>
      <span className={cn("truncate", RAIL_INLINE[mode])}>{label}</span>
      {count === undefined ? null : (
        <span
          className={cn(
            "ms-auto font-mono text-[10.5px] tabular",
            RAIL_INLINE[mode],
            selected ? "text-zinc-300" : "text-zinc-600",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
  return collapsed ? <Tip label={label}>{button}</Tip> : button;
}

/** The platform switch: Twitch and Kick side by side, each with its status dot.
 *
 * Turning a platform on or off is the strip's switch, beside what that
 * platform is doing; here a platform is only picked. The dot still says how
 * the other platform is getting on without switching to it. */
function PlatformRail({
  active,
  presentation,
  onChange,
}: {
  active: Platform;
  presentation: Record<Platform, AutomationPresentation>;
  onChange(platform: Platform): void;
}): React.ReactElement {
  const t = useT();
  const platformIds = Object.keys(PLATFORMS) as Platform[];
  return (
    // Base UI Tabs: arrow keys move between the platforms and select as they
    // go, Home/End jump to the ends, and only the selected tab is a tab stop.
    <Tabs.Root value={active} onValueChange={(value) => onChange(value as Platform)}>
      <Tabs.List
        data-tour="platform-switch"
        activateOnFocus
        aria-label={t("navPlatform")}
        className="@[560px]:grid-cols-2 grid grid-cols-1 gap-0.5 rounded-lg border border-[var(--rail-edge)] p-0.5"
      >
        {platformIds.map((id) => {
          const details = PLATFORMS[id];
          const status = presentation[id];
          const indicatorColor = statusColor(status, details.color);
          return (
            <Tabs.Tab
              key={id}
              value={id}
              aria-label={details.label}
              data-platform-status={id}
              data-state={status.state}
              className="flex min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-1.5 py-1 text-[12px] font-semibold text-zinc-500 outline-none transition-colors hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-white/40 data-[active]:bg-[var(--rail-selected)] data-[active]:text-white"
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{
                  backgroundColor: indicatorColor ?? details.color,
                  opacity: indicatorColor ? 1 : 0.35,
                }}
              />
              <span className="@[560px]:inline hidden truncate">{details.label}</span>
            </Tabs.Tab>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
