import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { AnimatePresence, motion } from "framer-motion";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Bell,
  Check,
  ChevronDown,
  Clock3,
  Gift,
  Github,
  GripVertical,
  Info,
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
  type LucideIcon,
} from "lucide-react";
import type { RuntimeMessage, RuntimeSnapshot } from "../../src/core/messages";
import type { DropCampaign, ExtensionSettings, Platform, WatchSession } from "../../src/core/models";
import "./style.css";

type PopupTab = "drops" | "watchQueue";
type GameItem = { id: string; name: string; short: string; accent: string };
type StreamerItem = { id: string; name: string; live: boolean; subtitle?: string; viewers?: number };
type FarmingChannelView = { name: string; category?: string; viewers?: number };
type RewardView = { id: string; name: string; progress: number; requiredMinutes: number; obtained: boolean; art: string; tint: string };
type CampaignView = {
  id: string;
  gameId: string;
  title: string;
  linked: boolean;
  ends: string;
  allowedChannels: string[];
  moreChannels: number;
  farmingChannel?: FarmingChannelView;
  thumbnail: string;
  tint: string;
  rewards: RewardView[];
};

const PLATFORMS: Record<Platform, { label: string; mark: string; color: string }> = {
  twitch: { label: "Twitch", mark: "T", color: "#9147ff" },
  kick: { label: "Kick", mark: "K", color: "#53fc18" },
};
const SELECTED_PLATFORM_KEY = "popup:selectedPlatform";

const GAME_ACCENTS = ["#2563eb", "#0891b2", "#ef4444", "#16a34a", "#9333ea", "#f59e0b"];
const CAMPAIGN_TINTS = [
  "from-orange-400 via-sky-400 to-blue-700",
  "from-cyan-400 via-zinc-700 to-rose-500",
  "from-red-600 via-pink-500 to-cyan-300",
  "from-zinc-700 via-slate-500 to-emerald-500",
  "from-violet-500 via-fuchsia-400 to-emerald-300",
  "from-amber-400 via-red-500 to-zinc-800",
];
const REWARD_TINTS = [
  "from-lime-200 via-zinc-100 to-sky-200",
  "from-lime-500 via-zinc-800 to-cyan-600",
  "from-fuchsia-400 via-pink-300 to-lime-300",
  "from-cyan-400 via-emerald-500 to-zinc-800",
  "from-orange-400 via-red-500 to-zinc-800",
  "from-yellow-100 via-zinc-100 to-stone-200",
  "from-blue-400 via-blue-600 to-zinc-100",
  "from-zinc-100 via-emerald-200 to-slate-500",
];
const EXTENSION_VERSION = browser.runtime.getManifest().version;

function send<T>(message: RuntimeMessage): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function moveById<T extends { id: string }>(list: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return list;
  const oldIndex = list.findIndex((item) => item.id === activeId);
  const newIndex = list.findIndex((item) => item.id === overId);
  if (oldIndex === -1 || newIndex === -1) return list;
  return arrayMove(list, oldIndex, newIndex);
}

function isPlatform(value: unknown): value is Platform {
  return value === "twitch" || value === "kick";
}

function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

function Popup(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [platform, setPlatform] = useState<Platform>("twitch");
  const [tab, setTab] = useState<PopupTab>("drops");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAutomation, setPendingAutomation] = useState<Partial<Record<Platform, boolean>>>({});

  useEffect(() => {
    void Promise.all([
      send<RuntimeSnapshot>({ type: "getSnapshot" }),
      browser.storage.local.get(SELECTED_PLATFORM_KEY),
    ]).then(([nextSnapshot, stored]) => {
      const savedPlatform = stored[SELECTED_PLATFORM_KEY];
      if (isPlatform(savedPlatform)) setPlatform(savedPlatform);
      setSnapshot(nextSnapshot);
    });
  }, []);

  function selectPlatform(nextPlatform: Platform): void {
    setPlatform(nextPlatform);
    void browser.storage.local.set({ [SELECTED_PLATFORM_KEY]: nextPlatform });
  }

  async function updateSettings(patch: Partial<ExtensionSettings>, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void> {
    if (!snapshot) return;
    const nextSettings = { ...snapshot.settings, ...patch };
    setSnapshot({ ...snapshot, settings: nextSettings });
    setSnapshot(await send<RuntimeSnapshot>({
      type: "saveSettings",
      settings: nextSettings,
      tickAfterSave: options?.tickAfterSave,
      tickAfterSavePlatforms: options?.tickAfterSavePlatforms,
    }));
  }

  async function setAutomation(enabled: boolean): Promise<void> {
    if (!snapshot || pendingAutomation[platform] != null) return;
    const pendingPlatform = platform;
    setPendingAutomation((current) => ({ ...current, [pendingPlatform]: enabled }));
    try {
      setSnapshot(await send<RuntimeSnapshot>({ type: "setAutomation", platform: pendingPlatform, enabled }));
    } catch (error) {
      console.error("Failed to update automation", error);
    } finally {
      setPendingAutomation((current) => {
        const { [pendingPlatform]: _completed, ...rest } = current;
        return rest;
      });
    }
  }

  async function refreshNow(): Promise<void> {
    if (!snapshot || refreshing) return;
    setRefreshing(true);
    try {
      setSnapshot(await send<RuntimeSnapshot>({ type: "tickNow" }));
    } finally {
      setRefreshing(false);
    }
  }

  if (!snapshot) {
    return (
      <main className="grid h-[600px] w-[400px] place-items-center border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400" data-platform="twitch">
        Loading
      </main>
    );
  }

  const settings = snapshot.settings;
  const rawCampaigns = sortCampaignsForPopup(snapshot.state.campaigns[platform], settings);
  const session = snapshot.state.sessions[platform];
  const sessionChannel = channelViewFromSession(session);
  const campaigns = rawCampaigns.map((campaign, index) => campaignViewFromCampaign(campaign, index, session));
  const games = gameItemsFromCampaigns(platform, snapshot.state.campaigns[platform], settings);
  const settingsGames: Record<Platform, GameItem[]> = {
    twitch: gameItemsFromCampaigns("twitch", snapshot.state.campaigns.twitch, settings),
    kick: gameItemsFromCampaigns("kick", snapshot.state.campaigns.kick, settings),
  };
  const gameMap = Object.fromEntries(games.map((game) => [game.id, game]));
  const watchQueueChannels = settings.platform[platform].watchQueueChannels;
  const watchQueue = watchQueueChannels.map((username) => streamerItemFromFallback(username, session));
  const automation = {
    twitch: pendingAutomation.twitch ?? (settings.running && settings.platform.twitch.enabled),
    kick: pendingAutomation.kick ?? (settings.running && settings.platform.kick.enabled),
  };
  const enabled = automation[platform];
  const automationPending = pendingAutomation[platform] != null;
  const activeCampaign = campaigns.find((campaign) => campaign.farmingChannel);
  const farmingChannel = activeCampaign?.farmingChannel ?? sessionChannel;

  return (
    <main
      data-platform={platform}
      className="flex h-[600px] w-[400px] flex-col overflow-hidden border border-zinc-200/80 bg-zinc-50 shadow-2xl shadow-black/30 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="relative shrink-0 border-b border-zinc-200/70 bg-white/85 px-3 pb-3 pt-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-linear-to-r from-transparent via-[var(--accent)] to-transparent" />
        <header className="mb-3 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/logo-ring.svg" alt="StreamMaxxing" width={36} height={36} className="h-9 w-9 rounded-xl shadow-sm" style={{ boxShadow: "0 4px 14px -4px var(--accent-glow)" }} />
            <div className="min-w-0 leading-tight">
              <div className="font-display truncate text-[15px] font-bold tracking-normal text-zinc-900 dark:text-zinc-50">StreamMaxxing</div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: enabled ? "var(--accent)" : "#a1a1aa" }} />
                {settingsOpen ? "Settings" : `${enabled ? "Active" : "Paused"} · ${PLATFORMS[platform].label}`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Refresh schedule" onClick={() => void refreshNow()} disabled={refreshing}>
              <RotateCcw size={16} className={cn(refreshing && "animate-spin")} />
            </IconButton>
            <IconButton label={settingsOpen ? "Close settings" : "Open settings"} active={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>
              {settingsOpen ? <X size={16} /> : <SettingsIcon size={16} />}
            </IconButton>
          </div>
        </header>
        {!settingsOpen ? (
          <PlatformSwitcher
            active={platform}
            automation={automation}
            onChange={selectPlatform}
          />
        ) : null}
      </div>

      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto text-zinc-700 dark:text-zinc-300">
        <div className="space-y-3 p-3">
          <AnimatePresence mode="wait" initial={false}>
            {settingsOpen ? (
              <motion.div key="settings" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }} className="space-y-2.5">
                <SettingsView games={settingsGames} settings={settings} onSettingsChange={updateSettings} />
              </motion.div>
            ) : (
              <motion.div key="main" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }} className="space-y-3">
                <AutomationHero platformLabel={PLATFORMS[platform].label} enabled={enabled} pending={automationPending} farmingTitle={activeCampaign?.title} farmingChannel={farmingChannel} onChange={setAutomation} />
                <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[11px]" style={{ backgroundColor: "var(--accent-softer)" }}>
                  <Info size={13} className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
                  <p className="leading-snug text-zinc-600 dark:text-zinc-300">
                    Drops always take priority over the Watch Queue. Drag campaigns by the <GripVertical size={11} className="inline align-text-bottom text-zinc-400" /> grip to set farming order.
                  </p>
                </div>
                <SubTabs
                  tabs={[
                    { id: "drops", label: "Drops", icon: Gift, count: campaigns.length },
                    { id: "watchQueue", label: "Watch Queue", icon: Play, count: `${watchQueue.length}/20` },
                  ]}
                  active={tab}
                  onChange={setTab}
                />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
                    {tab === "drops" ? (
                      <DropsPanel
                        campaigns={campaigns}
                        gameMap={gameMap}
                        onReorder={(ordered) => updateSettings({ campaignPriorities: prioritiesFromOrder(ordered) })}
                      />
                    ) : (
                      <WatchQueuePanel
                        platform={platform}
                        streamers={watchQueue}
                        onChange={(ordered) => updateSettings(
                          {
                            platform: {
                              ...settings.platform,
                              [platform]: {
                                ...settings.platform[platform],
                                watchQueueChannels: ordered.map((streamer) => streamer.id),
                              },
                            },
                          },
                          { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
                        )}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
          <AttributionFooter version={EXTENSION_VERSION} />
        </div>
      </div>
    </main>
  );
}

function AttributionFooter({ version }: { version: string }): React.ReactElement {
  return (
    <footer className="flex items-center justify-between gap-2 px-1 pb-0.5 pt-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
      <span className="shrink-0 tabular">v{version}</span>
      <nav aria-label="Attribution links" className="flex min-w-0 items-center gap-1.5">
        <a
          href="https://github.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title="jamezrin on GitHub"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <Github size={12} />
          GitHub
        </a>
        <a
          href="https://x.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title="jamezrin on X"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <span aria-hidden className="text-[11px] font-black leading-none">X</span>
          @jamezrin
        </a>
      </nav>
    </footer>
  );
}

function PlatformSwitcher({ active, automation, onChange }: { active: Platform; automation: Record<Platform, boolean>; onChange(platform: Platform): void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {Object.entries(PLATFORMS).map(([id, platform]) => {
        const selected = active === id;
        const running = automation[id as Platform];
        return (
          <button key={id} type="button" onClick={() => onChange(id as Platform)} title={`${platform.label} automation ${running ? "running" : "paused"}`} className={cn("relative flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}>
            {selected && <motion.span layoutId="platform-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
            <span className="relative z-10 flex h-4 w-4 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color, boxShadow: selected ? `0 0 12px -2px ${platform.color}` : undefined }}>
              {platform.mark}
            </span>
            <span className="relative z-10">{platform.label}</span>
            <span className="relative z-10 ml-0.5 flex items-center" aria-hidden>
              {running ? <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: platform.color, boxShadow: `0 0 6px ${platform.color}` }} /> : <span className="h-1.5 w-1.5 rounded-full border border-zinc-400 dark:border-zinc-500" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AutomationHero({ platformLabel, enabled, pending, onChange, farmingTitle, farmingChannel }: { platformLabel: string; enabled: boolean; pending: boolean; onChange(value: boolean): Promise<void>; farmingTitle?: string; farmingChannel?: FarmingChannelView }) {
  const status = pending ? (enabled ? "Starting" : "Stopping") : enabled ? "Running" : "Paused";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900" style={{ boxShadow: enabled ? "0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px var(--accent-ring)" : undefined }}>
      {enabled && <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl" style={{ backgroundColor: "var(--accent-glow)", opacity: 0.5 }} />}
      <div className="relative flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors" style={{ backgroundColor: enabled ? "var(--accent)" : "var(--accent-soft)", color: enabled ? "var(--accent-contrast)" : "var(--accent-text)" }}>
          <Power size={20} strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{platformLabel} automation</span>
            <Pill tone={enabled ? "accent" : "muted"}>{status}</Pill>
          </div>
          <div className="mt-0.5 flex h-[34px] flex-col justify-center text-xs text-zinc-500 dark:text-zinc-400">
            {pending ? (
              <p className="line-clamp-2 leading-snug">{enabled ? "Starting automation..." : "Pausing automation..."}</p>
            ) : enabled ? (
              <>
                {farmingChannel ? (
                  <p className="flex items-center gap-1 truncate">
                    <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
                    Watching
                    <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel.name}</span>
                    {farmingChannel.viewers != null && <span className="shrink-0 text-zinc-400 dark:text-zinc-500">· {formatViewers(farmingChannel.viewers)}</span>}
                  </p>
                ) : (
                  <p className="truncate">Waiting for an eligible stream</p>
                )}
                {farmingTitle && <p className="truncate">Farming <span className="font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span></p>}
              </>
            ) : (
              <p className="line-clamp-2 leading-snug">Watching paused. Toggle to resume drop farming.</p>
            )}
          </div>
        </div>
        <Toggle checked={enabled} onChange={onChange} label={`${platformLabel} automation`} disabled={pending} />
      </div>
    </div>
  );
}

function DropsPanel({ campaigns, gameMap, onReorder }: { campaigns: CampaignView[]; gameMap: Record<string, GameItem>; onReorder(campaigns: CampaignView[]): void | Promise<void> }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const firstId = campaigns[0]?.id;
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(firstId ? { [firstId]: true } : {});
  const activeCampaign = campaigns.find((campaign) => campaign.id === activeId);
  const activeIndex = campaigns.findIndex((campaign) => campaign.id === activeId);

  if (campaigns.length === 0) return <EmptyPanel>No campaigns discovered yet.</EmptyPanel>;

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
        <div className="space-y-2">
          {campaigns.map((campaign, index) => (
            <SortableCampaign key={campaign.id} campaign={campaign} index={index} game={gameMap[campaign.gameId] ?? fallbackGame(campaign, index)} expanded={Boolean(expandedIds[campaign.id])} onToggle={() => setExpandedIds((current) => ({ ...current, [campaign.id]: !current[campaign.id] }))} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeCampaign ? <CampaignCard campaign={activeCampaign} index={activeIndex} game={gameMap[activeCampaign.gameId] ?? fallbackGame(activeCampaign, activeIndex)} expanded={false} onToggle={() => undefined} isOverlay dragHandle={<GripVertical size={16} className="text-zinc-400" />} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableCampaign(props: { campaign: CampaignView; index: number; game: GameItem; expanded: boolean; onToggle(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.campaign.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CampaignCard {...props} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${props.campaign.title}`} />} />
    </div>
  );
}

function CampaignCard({ campaign, index, game, expanded, onToggle, dragHandle, isOverlay = false, dimmed = false }: { campaign: CampaignView; index: number; game: GameItem; expanded: boolean; onToggle(): void; dragHandle?: React.ReactNode; isOverlay?: boolean; dimmed?: boolean }) {
  const stats = campaignStats(campaign);
  const isTop = index === 0;
  const channelLabel = campaign.allowedChannels[0] === "All" ? "All channels" : `${campaign.allowedChannels.length + campaign.moreChannels} channels`;

  return (
    <article className={cn("overflow-hidden rounded-2xl border bg-white transition-shadow dark:bg-zinc-900", isTop ? "border-transparent" : "border-zinc-200 dark:border-zinc-800", isOverlay ? "shadow-2xl shadow-black/25" : "shadow-sm", dimmed && "opacity-40")} style={isTop ? { boxShadow: isOverlay ? "0 20px 50px -12px rgba(0,0,0,0.5)" : "0 0 0 1.5px var(--accent-ring), 0 10px 30px -18px var(--accent-glow)" } : undefined}>
      <div className="flex items-stretch">
        <div className="flex w-8 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">{dragHandle ?? <GripVertical size={16} className="text-zinc-300 dark:text-zinc-600" />}</div>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2.5 p-2.5 text-left outline-none">
          <div className={cn("relative flex h-12 w-12 shrink-0 items-end overflow-hidden rounded-xl bg-gradient-to-br p-1.5 shadow-inner", campaign.tint)}>
            <span className="text-[11px] font-black leading-none tracking-normal text-white drop-shadow">{campaign.thumbnail}</span>
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
              <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500"><ChevronDown size={16} /></motion.div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Pill tone="accent">#{index + 1}</Pill>
              {isTop && <Pill tone="accent"><Radio size={9} /> Farming now</Pill>}
              <Pill tone={campaign.linked ? "live" : "danger"}><Link2 size={9} /> {campaign.linked ? "Linked" : "Not linked"}</Pill>
            </div>
          </div>
        </button>
      </div>
      <div className="p-2.5">
        <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
          <div className="mb-1.5 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> Ends in {formatCountdown(campaign.ends)}</div>
              <div className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">Next: <span className="font-medium text-zinc-800 dark:text-zinc-100">{stats.nextReward?.name}</span></div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-bold tabular leading-none" style={{ color: "var(--accent-text)" }}>{stats.progress.toFixed(0)}%</div>
              <div className="mt-0.5 text-[10px] tabular text-zinc-500 dark:text-zinc-400">{formatMinutes(stats.remaining)} left</div>
            </div>
          </div>
          <ProgressBar value={stats.progress} glow={isTop} />
        </div>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
              <div className="space-y-2.5 pt-2.5">
                <div className="grid grid-cols-3 gap-1.5">
                  <MetaStat icon={Clock3} label="Farmed" value={formatHours(stats.totalFarmed)} />
                  <MetaStat icon={RotateCcw} label="Left" value={formatMinutes(stats.remaining)} />
                  <MetaStat icon={Trophy} label="Rewards" value={`${stats.completed}/${stats.totalRewards}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200"><Gift size={12} style={{ color: "var(--accent-text)" }} /> Rewards</span>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500">in campaign order</span>
                  </div>
                  <div className="no-scrollbar -mx-0.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
                    {campaign.rewards.map((reward) => <RewardTile key={reward.id} reward={reward} />)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg bg-zinc-50 px-2 py-1.5 text-[11px] text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                  <Users size={12} className="shrink-0" />
                  <span className="truncate">{channelLabel}</span>
                  {campaign.allowedChannels[0] !== "All" ? <span className="truncate text-zinc-400 dark:text-zinc-500">· {campaign.allowedChannels.join(", ")}</span> : null}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </article>
  );
}

function RewardTile({ reward }: { reward: RewardView }) {
  const done = reward.obtained || reward.progress >= 100;
  return (
    <div className="w-[128px] shrink-0 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className={cn("relative mb-2 flex h-[68px] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br", reward.tint)}>
        <span className="px-1 text-center text-[11px] font-black tracking-wide text-zinc-900/70 mix-blend-multiply">{reward.art}</span>
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

function WatchQueuePanel({ streamers, onChange }: { platform: Platform; streamers: StreamerItem[]; onChange(streamers: StreamerItem[]): void | Promise<void> }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const active = streamers.find((streamer) => streamer.id === activeId);
  const activeIndex = streamers.findIndex((streamer) => streamer.id === activeId);

  function endDrag(event: DragEndEvent): void {
    setActiveId(null);
    const active = String(event.active.id);
    const over = event.over?.id == null ? undefined : String(event.over.id);
    if (!over || active === over) return;
    void onChange(moveById(streamers, active, over));
  }

  function addChannel(): void {
    const username = value.trim().replace(/^@/, "").toLowerCase();
    if (!username || streamers.some((streamer) => streamer.name.toLowerCase() === username)) {
      setValue("");
      setAdding(false);
      return;
    }
    void onChange([...streamers, { id: username, name: username, live: false }]);
    setValue("");
    setAdding(false);
  }

  function removeChannel(id: string): void {
    void onChange(streamers.filter((streamer) => streamer.id !== id));
  }

  return (
    <div className="space-y-2.5">
      {streamers.length === 0 ? <EmptyPanel>No watch queue channels configured.</EmptyPanel> : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
          <SortableContext items={streamers.map((streamer) => streamer.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {streamers.map((streamer, index) => <SortableWatchQueue key={streamer.id} streamer={streamer} index={index} onRemove={() => removeChannel(streamer.id)} />)}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {active ? <CompactRow isOverlay index={activeIndex} avatar={active.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={active.name} subtitle={active.subtitle} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<WatchQueueStatus streamer={active} />} /> : null}
          </DragOverlay>
        </DndContext>
      )}
      {adding ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="channel" className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <button type="submit" className="rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)]">Add</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200">
          <Plus size={14} /> Add channel
        </button>
      )}
    </div>
  );
}

function SortableWatchQueue({ streamer, index, onRemove }: { streamer: StreamerItem; index: number; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: streamer.id });
  const status = <WatchQueueStatus streamer={streamer} />;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={streamer.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={streamer.name} subtitle={streamer.subtitle} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${streamer.name}`} />} trailing={<span className="flex shrink-0 items-center gap-1.5">{status}<RemoveRowButton label={`Remove ${streamer.name}`} onClick={onRemove} /></span>} />
    </div>
  );
}

function SettingsView({ games, settings, onSettingsChange }: {
  games: Record<Platform, GameItem[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: Partial<ExtensionSettings>, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void>;
}) {
  const set = (key: keyof ExtensionSettings) => (value: boolean) => onSettingsChange({ [key]: value } as Partial<ExtensionSettings>);
  const pollIntervalSeconds = Math.round(settings.pollIntervalMinutes * 60);
  const setPlatformEnabled = (platform: Platform) => (enabled: boolean) => onSettingsChange(
    {
      platform: {
        ...settings.platform,
        [platform]: {
          ...settings.platform[platform],
          enabled,
        },
      },
    },
    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
  );
  const setPlatformGamePriority = (platform: Platform) => (ordered: GameItem[]) => onSettingsChange({
    platform: {
      ...settings.platform,
      [platform]: {
        ...settings.platform[platform],
        gamePriority: ordered.map((game) => game.id),
      },
    },
  });

  return (
    <div className="space-y-2.5">
      <SettingsSection title="General settings" description="Applies to Twitch and Kick." icon={SettingsIcon}>
        <SettingRow title="Mute farming tabs" description="Keep drop and Watch Queue tabs muted while farming." checked={settings.muteFarmingTabs} onChange={set("muteFarmingTabs")} />
        <SettingRow title="Pause when watching manually" description="Stop farming while you have a stream open and are watching yourself." checked={settings.pauseOnManualWatch} onChange={set("pauseOnManualWatch")} />
        <SettingRow title="Auto-close farming tabs" description="Automatically close when the extension is idle (no drops to farm or no streamers to watch)." checked={settings.autoCloseFinishedDrops} onChange={set("autoCloseFinishedDrops")} />
        <SettingRow title="Auto-start on launch" description="Begin farming as soon as the extension loads." checked={settings.autoStartDropFarming} onChange={set("autoStartDropFarming")} />
        <NumberSettingRow title="Scheduler interval" description="How often campaign and streamer status refreshes." value={pollIntervalSeconds} min={30} max={3600} suffix="sec" onChange={(value) => onSettingsChange({ pollIntervalMinutes: value / 60 })} />
      </SettingsSection>
      <SettingsSection title="Notifications" description="Applies to all enabled platforms." icon={Bell}>
        <SettingRow title="Reward earned" description="Notify when a drop reward is claimable." checked={settings.notifyRewardEarned} onChange={set("notifyRewardEarned")} />
        <SettingRow title="No drops left" description="Notify when all active campaigns are exhausted." checked={settings.notifyNoDropsLeft} onChange={set("notifyNoDropsLeft")} />
      </SettingsSection>
      <SettingsSection title="Drops" description="Shared campaign farming behavior." icon={Gift}>
        <SettingRow title="Auto-claim drops" description="Claim earned drop rewards automatically when they become available." checked={settings.autoClaim} onChange={set("autoClaim")} />
      </SettingsSection>
      <SettingsSection title="Watch Queue" description="Shared fallback queue behavior." icon={Play}>
        <SettingRow title="Only when no drops are active" description="Preserves drop priority automatically." checked={settings.watchQueueFallbackOnly} onChange={set("watchQueueFallbackOnly")} />
      </SettingsSection>
      <SettingsSection title="Platform settings" description="Controls that only affect one provider." icon={Radio}>
        <PlatformSettingsCard platform="twitch" games={games.twitch} settings={settings} onEnabledChange={setPlatformEnabled("twitch")} onGamePriorityChange={setPlatformGamePriority("twitch")} />
        <PlatformSettingsCard platform="kick" games={games.kick} settings={settings} onEnabledChange={setPlatformEnabled("kick")} onGamePriorityChange={setPlatformGamePriority("kick")} />
      </SettingsSection>
    </div>
  );
}

function PlatformSettingsCard({ platform, games, settings, onEnabledChange, onGamePriorityChange }: {
  platform: Platform;
  games: GameItem[];
  settings: ExtensionSettings;
  onEnabledChange(enabled: boolean): void | Promise<void>;
  onGamePriorityChange(games: GameItem[]): void | Promise<void>;
}) {
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];
  const queueCount = platformSettings.watchQueueChannels.length;

  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="mb-2 flex items-start gap-2">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-black shadow-sm"
          style={{
            backgroundColor: details.color,
            color: platform === "kick" ? "#07140a" : "#fff",
            boxShadow: `0 0 14px -5px ${details.color}`,
          }}
        >
          {details.mark}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-50">{details.label}</h4>
            <Pill tone={platformSettings.enabled ? "live" : "muted"}>{platformSettings.enabled ? "Enabled" : "Paused"}</Pill>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            Uses its own automation toggle and Watch Queue channels.
          </p>
        </div>
        <Toggle checked={platformSettings.enabled} onChange={onEnabledChange} label={`${details.label} platform automation`} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-zinc-100 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-100">{details.label} Watch Queue</div>
          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">Edit it from the Watch Queue tab after selecting {details.label}.</div>
        </div>
        <Pill tone="outline">{queueCount}/20</Pill>
      </div>
      <div className="mt-2">
        <GamePriority games={games} label={`${details.label} game order`} onChange={onGamePriorityChange} />
      </div>
    </div>
  );
}

function GamePriority({ games, label = "Fallback game order", onChange }: { games: GameItem[]; label?: string; onChange(games: GameItem[]): void | Promise<void> }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = games.find((game) => game.id === activeId);
  const activeIndex = games.findIndex((game) => game.id === activeId);

  function endDrag(event: DragEndEvent): void {
    setActiveId(null);
    const active = String(event.active.id);
    const over = event.over?.id == null ? undefined : String(event.over.id);
    if (!over || active === over) return;
    void onChange(moveById(games, active, over));
  }

  return (
    <div className="space-y-2 rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{label}</div>
        <Pill tone="accent">drag to sort</Pill>
      </div>
      <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Used when campaign order is reset to defaults.</p>
      {games.length === 0 ? <div className="text-[11px] text-zinc-400">No games discovered yet.</div> : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
          <SortableContext items={games.map((game) => game.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">{games.map((game, index) => <SortableGameRow key={game.id} game={game} index={index} />)}</div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>{active ? <CompactRow isOverlay index={activeIndex} avatar={active.short} avatarStyle={{ backgroundColor: active.accent, color: "#fff" }} title={active.name} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<Pill tone="outline">game</Pill>} /> : null}</DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function SortableGameRow({ game, index }: { game: GameItem; index: number }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: game.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={game.short} avatarStyle={{ backgroundColor: game.accent, color: "#fff" }} title={game.name} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${game.name}`} />} trailing={<Pill tone="outline">game</Pill>} />
    </div>
  );
}

function CompactRow({ avatar, avatarStyle, index, title, subtitle, trailing, dragHandle, isOverlay = false, dimmed = false }: { avatar: string; avatarStyle: React.CSSProperties; index: number; title: string; subtitle?: string; trailing: React.ReactNode; dragHandle: React.ReactNode; isOverlay?: boolean; dimmed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border bg-white px-2 py-2 dark:bg-zinc-900", isOverlay ? "border-transparent shadow-2xl shadow-black/25" : "border-zinc-200 shadow-sm dark:border-zinc-800", dimmed && "opacity-40")}>
      {dragHandle}
      <span className="w-4 text-center text-[11px] font-bold tabular" style={{ color: "var(--accent-text)" }}>{index + 1}</span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={avatarStyle}>{avatar}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">{title}</span>
        {subtitle ? <span className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{subtitle}</span> : null}
      </span>
      {trailing}
    </div>
  );
}

function SettingsSection({ title, description, icon: Icon, children }: { title: string; description: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }}><Icon size={14} /></span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function SettingRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange(value: boolean): void | Promise<void> }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function NumberSettingRow({ title, description, value, min, max, suffix, onChange }: { title: string; description: string; value: number; min: number; max: number; suffix: string; onChange(value: number): void | Promise<void> }) {
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
    <div className="flex items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
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

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange(value: boolean): void | Promise<void>; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => void onChange(!checked)} className={cn("relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]", checked ? "" : "bg-zinc-200 dark:bg-zinc-700", disabled && "cursor-wait opacity-70")} style={checked ? { backgroundColor: "var(--accent)" } : undefined}>
      <motion.span layout transition={{ type: "spring", stiffness: 550, damping: 32 }} className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" style={{ marginLeft: checked ? 16 : 0 }} />
    </button>
  );
}

function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "live" | "danger" | "outline" }) {
  const tones = {
    muted: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    outline: "border border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
    accent: "bg-[var(--accent-soft)] text-[var(--accent-text)]",
    live: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    danger: "bg-red-500/12 text-red-600 dark:text-red-400",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap", tones[tone])}>{children}</span>;
}

function IconButton({ children, label, active, disabled, onClick }: { children: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick(): void }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled} className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]", disabled ? "text-zinc-300 dark:text-zinc-700" : active ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200")}>{children}</button>;
}

function RemoveRowButton({ label, onClick }: { label: string; onClick(): void }) {
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

function DragHandle({ setActivatorNodeRef, attributes, listeners, label }: { setActivatorNodeRef(element: HTMLElement | null): void; attributes: React.ButtonHTMLAttributes<HTMLButtonElement>; listeners?: Record<string, unknown>; label: string }) {
  return (
    <button ref={setActivatorNodeRef} type="button" aria-label={label} {...attributes} {...listeners} onClick={(event) => event.stopPropagation()} className="flex cursor-grab touch-none items-center justify-center rounded-md text-zinc-300 transition-colors outline-none hover:text-zinc-500 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] active:cursor-grabbing dark:text-zinc-600 dark:hover:text-zinc-400" style={{ touchAction: "none", userSelect: "none" }}>
      <GripVertical size={16} />
    </button>
  );
}

function SubTabs({ tabs, active, onChange }: { tabs: Array<{ id: PopupTab; label: string; icon: LucideIcon; count: number | string }>; active: PopupTab; onChange(tab: PopupTab): void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        const Icon = tab.icon;
        return (
          <button key={tab.id} type="button" onClick={() => onChange(tab.id)} className={cn("relative flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}>
            {selected && <motion.span layoutId="subtab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
            <Icon size={14} className="relative z-10" style={selected ? { color: "var(--accent-text)" } : undefined} />
            <span className="relative z-10">{tab.label}</span>
            <span className="relative z-10 text-[10px] font-bold tabular text-zinc-400 dark:text-zinc-500">{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function ProgressBar({ value, size = "md", glow = false }: { value: number; size?: "sm" | "md"; glow?: boolean }) {
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-700/60", size === "sm" ? "h-1" : "h-1.5")}>
      <motion.div className="h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${Math.max(value, value > 0 ? 4 : 0)}%` }} transition={{ duration: 0.5 }} style={{ backgroundColor: "var(--accent)", boxShadow: glow && value > 0 ? "0 0 10px -1px var(--accent-glow)" : undefined }} />
    </div>
  );
}

function MetaStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60">
      <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase text-zinc-400 dark:text-zinc-500"><Icon size={11} /> {label}</div>
      <div className="truncate text-xs font-semibold tabular text-zinc-800 dark:text-zinc-100">{value}</div>
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-24 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-white p-4 text-center text-sm font-semibold text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">{children}</div>;
}

function sortCampaignsForPopup(campaigns: DropCampaign[], settings: ExtensionSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftPriority = settings.campaignPriorities[left.id] ?? left.priority;
    const rightPriority = settings.campaignPriorities[right.id] ?? right.priority;
    if (leftPriority != null && rightPriority != null && leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (leftPriority != null && rightPriority == null) return -1;
    if (rightPriority != null && leftPriority == null) return 1;
    const gameOrder = gamePriorityScore(left, settings) - gamePriorityScore(right, settings);
    if (gameOrder !== 0) return gameOrder;
    const leftEnd = left.endsAt ? Date.parse(left.endsAt) : Number.MAX_SAFE_INTEGER;
    const rightEnd = right.endsAt ? Date.parse(right.endsAt) : Number.MAX_SAFE_INTEGER;
    return leftEnd - rightEnd;
  });
}

function prioritiesFromOrder(campaigns: Array<{ id: string }>): Record<string, number> {
  return Object.fromEntries(campaigns.map((campaign, index) => [campaign.id, campaigns.length - index]));
}

function gameItemsFromCampaigns(platform: Platform, campaigns: DropCampaign[], settings: ExtensionSettings): GameItem[] {
  const discovered = new Map<string, GameItem>();
  campaigns.forEach((campaign, index) => {
    const id = gameId(campaign);
    if (!discovered.has(id)) {
      discovered.set(id, {
        id,
        name: campaign.gameName ?? "Unknown game",
        short: initials(campaign.gameName ?? campaign.name),
        accent: GAME_ACCENTS[index % GAME_ACCENTS.length],
      });
    }
  });
  const items = [...discovered.values()];
  return items.sort((left, right) => {
    const gamePriority = settings.platform[platform].gamePriority ?? [];
    const leftIndex = gamePriority.indexOf(left.id);
    const rightIndex = gamePriority.indexOf(right.id);
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
    if (leftIndex !== -1) return -1;
    if (rightIndex !== -1) return 1;
    return left.name.localeCompare(right.name);
  });
}

function gamePriorityScore(campaign: DropCampaign, settings: ExtensionSettings): number {
  const id = gameId(campaign);
  const index = (settings.platform[campaign.platform].gamePriority ?? []).indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function gameId(campaign: DropCampaign): string {
  return (campaign.categoryId ?? campaign.gameName ?? campaign.name).trim().toLowerCase();
}

function fallbackGame(campaign: DropCampaign | CampaignView, index: number): GameItem {
  const id = "gameId" in campaign ? campaign.gameId : gameId(campaign);
  const name = "title" in campaign ? "Drops campaign" : campaign.gameName ?? "Drops campaign";
  const short = "thumbnail" in campaign ? campaign.thumbnail : initials(campaign.gameName ?? campaign.name);
  return { id, name, short, accent: GAME_ACCENTS[Math.max(0, index) % GAME_ACCENTS.length] };
}

function campaignStats(campaign: CampaignView) {
  const totalRequired = campaign.rewards.reduce((sum, reward) => sum + reward.requiredMinutes, 0);
  const totalFarmed = campaign.rewards.reduce((sum, reward) => sum + (reward.requiredMinutes * reward.progress) / 100, 0);
  const remaining = Math.max(totalRequired - totalFarmed, 0);
  const progress = totalRequired ? Math.min(100, (totalFarmed / totalRequired) * 100) : 0;
  const completed = campaign.rewards.filter((reward) => reward.obtained || reward.progress >= 100).length;
  const nextReward = campaign.rewards.find((reward) => !reward.obtained && reward.progress < 100) ?? campaign.rewards.at(-1);
  return { totalRequired, totalFarmed, remaining, progress, completed, totalRewards: campaign.rewards.length, nextReward };
}

function campaignViewFromCampaign(campaign: DropCampaign, index: number, session: WatchSession): CampaignView {
  const visibleChannels = channelsForView(campaign);
  return {
    id: campaign.id,
    gameId: gameId(campaign),
    title: campaign.name,
    linked: campaign.accountLinked !== false,
    ends: campaign.endsAt ?? campaign.rewards.find((reward) => reward.availableUntil)?.availableUntil ?? "",
    allowedChannels: visibleChannels.channels,
    moreChannels: visibleChannels.more,
    farmingChannel: session.campaignId === campaign.id ? channelViewFromSession(session) : undefined,
    thumbnail: initials(campaign.gameName ?? campaign.name),
    tint: CAMPAIGN_TINTS[index % CAMPAIGN_TINTS.length],
    rewards: campaign.rewards.map((reward, rewardIndex) => {
      const progress = reward.requiredMinutes > 0
        ? Math.min(100, (Math.min(reward.watchedMinutes, reward.requiredMinutes) / reward.requiredMinutes) * 100)
        : reward.status === "claimed" ? 100 : 0;
      return {
        id: reward.id,
        name: reward.name,
        progress,
        requiredMinutes: reward.requiredMinutes,
        obtained: reward.status === "claimed",
        art: initials(reward.name).slice(0, 8),
        tint: REWARD_TINTS[rewardIndex % REWARD_TINTS.length],
      };
    }),
  };
}

function channelsForView(campaign: DropCampaign): { channels: string[]; more: number } {
  if (campaign.isGeneralDrop || !campaign.allowedChannels?.length) return { channels: ["All"], more: 0 };
  const channels = campaign.allowedChannels.slice(0, 4);
  return { channels, more: Math.max(0, campaign.allowedChannels.length - channels.length) };
}

function channelViewFromSession(session: WatchSession): FarmingChannelView | undefined {
  if (session.status !== "watching") return undefined;
  const channel = session.channel;
  if (!channel) return undefined;
  return {
    name: channel.displayName ?? channel.username,
    category: channel.categoryName,
    viewers: channel.viewerCount,
  };
}

function streamerItemFromFallback(username: string, session: WatchSession): StreamerItem {
  const channel = session.channel;
  const live = channel != null && channel.username.toLowerCase() === username.toLowerCase() && session.status === "watching";
  if (!live) return { id: username, name: username, live: false, subtitle: "Queued" };
  return {
    id: username,
    name: channel.displayName ?? username,
    live: true,
    subtitle: channel.categoryName,
    viewers: channel.viewerCount,
  };
}

function WatchQueueStatus({ streamer }: { streamer: StreamerItem }): React.ReactElement {
  if (streamer.live) {
    return <Pill tone="live"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{streamer.viewers != null ? formatViewers(streamer.viewers) : "live"}</Pill>;
  }
  return <Pill tone="muted">queued</Pill>;
}

function initials(value: string): string {
  const result = value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return result || "SM";
}

function formatCountdown(value: string): string {
  const timestamp = Date.parse(value);
  if (!value || Number.isNaN(timestamp)) return "later";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "Ended";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatViewers(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`;
  return String(count);
}

createRoot(document.getElementById("root")!).render(<Popup />);
