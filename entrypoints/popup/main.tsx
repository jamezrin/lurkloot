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
  Ban,
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
  SlidersHorizontal,
  Trophy,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PlaybackControl, RuntimeMessage, RuntimeSnapshot } from "../../src/core/messages";
import type { AdFocusMode, CampaignFilterKey, DropCampaign, EventLogEntry, ExtensionSettings, Platform, WatchSession } from "../../src/core/models";
import { LOG_LEVELS, type LogLevel } from "../../src/core/logging";
import { DEFAULT_SETTINGS, mergeSettings } from "../../src/core/settings";
import { kickRewardImageUrl } from "../../src/platforms/kickParser";
import "./style.css";

type PopupTab = "drops" | "watchQueue";
type GameItem = { id: string; name: string; short: string; accent: string };
type StreamerItem = { id: string; name: string; live: boolean; subtitle?: string; viewers?: number };
type FarmingChannelView = { name: string; category?: string; viewers?: number };
type RewardView = { id: string; name: string; progress: number; requiredMinutes: number; obtained: boolean; art: string; tint: string; imageUrl?: string };
type CampaignView = {
  id: string;
  gameId: string;
  title: string;
  linked: boolean;
  excluded: boolean;
  ends: string;
  allowedChannels: string[];
  moreChannels: number;
  farmingChannel?: FarmingChannelView;
  thumbnail: string;
  tint: string;
  imageUrl?: string;
  rewards: RewardView[];
};

const PLATFORMS: Record<Platform, { label: string; mark: string; color: string }> = {
  twitch: { label: "Twitch", mark: "T", color: "#9147ff" },
  kick: { label: "Kick", mark: "K", color: "#53fc18" },
};
const SELECTED_PLATFORM_KEY = "popup:selectedPlatform";
const COLLAPSED_SETTINGS_SECTIONS_KEY = "popup:collapsedSettingsSections";

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
const SCREENSHOT_MODE = new URLSearchParams(window.location.search).get("screenshot") === "store";
const EXTENSION_VERSION = SCREENSHOT_MODE ? "1.0.0" : browser.runtime.getManifest().version;

type ScreenshotView = "drops" | "watchQueue" | "settings" | "activity";
type ScreenshotVariant = {
  platform: Platform;
  view: ScreenshotView;
  accentGradient: string;
  headline: string;
  subcopy: string;
};
// Drives the marketing screenshots captured by scripts/capture-store-screenshot.mjs.
// Each variant frames a different platform/view with tailored copy; the script
// loops over these ids via ?screenshot=store&variant=<id>.
const TWITCH_GRADIENT =
  "radial-gradient(circle_at_22%_24%,rgba(145,71,255,0.34),transparent_32%),radial-gradient(circle_at_78%_78%,rgba(83,252,24,0.18),transparent_28%)";
const KICK_GRADIENT =
  "radial-gradient(circle_at_22%_24%,rgba(83,252,24,0.30),transparent_32%),radial-gradient(circle_at_78%_78%,rgba(145,71,255,0.20),transparent_28%)";
const SCREENSHOT_VARIANTS: Record<string, ScreenshotVariant> = {
  "twitch-drops": {
    platform: "twitch",
    view: "drops",
    accentGradient: TWITCH_GRADIENT,
    headline: "Twitch and Kick drops, managed from one popup.",
    subcopy: "Stream Autopilot farms eligible campaigns through your normal browser session with visible muted tabs.",
  },
  "kick-drops": {
    platform: "kick",
    view: "drops",
    accentGradient: KICK_GRADIENT,
    headline: "Now farming Kick drops too.",
    subcopy: "The same automation, eligibility checks, and auto-claim you rely on for Twitch — now covering Kick creator rewards.",
  },
  "watch-queue": {
    platform: "twitch",
    view: "watchQueue",
    accentGradient: TWITCH_GRADIENT,
    headline: "A fallback Watch Queue keeps you earning.",
    subcopy: "When no drops are active, Stream Autopilot watches your favorite channels so your time online never goes to waste.",
  },
  "settings": {
    platform: "twitch",
    view: "settings",
    accentGradient: TWITCH_GRADIENT,
    headline: "Tune every detail to your setup.",
    subcopy: "Per-platform automation, auto-claim, muted tabs, game priority, and an experimental low-resource tabless mode.",
  },
  "activity": {
    platform: "twitch",
    view: "activity",
    accentGradient: TWITCH_GRADIENT,
    headline: "See exactly what it's doing.",
    subcopy: "A transparent activity log shows every check, switch, and claim — filterable by level so nothing happens behind your back.",
  },
};
const SCREENSHOT_VARIANT_ID = new URLSearchParams(window.location.search).get("variant") ?? "twitch-drops";
const SCREENSHOT_VARIANT = SCREENSHOT_VARIANTS[SCREENSHOT_VARIANT_ID] ?? SCREENSHOT_VARIANTS["twitch-drops"];

function send<T>(message: RuntimeMessage): Promise<T> {
  if (SCREENSHOT_MODE) return Promise.resolve(handleScreenshotMessage(message) as T);
  return browser.runtime.sendMessage(message) as Promise<T>;
}

function handleScreenshotMessage(message: RuntimeMessage): RuntimeSnapshot | PlaybackControl {
  switch (message.type) {
    case "getSnapshot":
    case "tickNow":
      return screenshotSnapshot();
    case "saveSettings":
      return { ...screenshotSnapshot(), settings: mergeSettings(message.settings) };
    case "setAutomation":
      return {
        ...screenshotSnapshot(),
        settings: mergeSettings({
          ...screenshotSnapshot().settings,
          running: message.enabled,
          platform: {
            ...screenshotSnapshot().settings.platform,
            [message.platform]: {
              ...screenshotSnapshot().settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "setRunning":
      return { ...screenshotSnapshot(), settings: mergeSettings({ ...screenshotSnapshot().settings, running: message.running }) };
    case "setPlatformEnabled":
      return {
        ...screenshotSnapshot(),
        settings: mergeSettings({
          ...screenshotSnapshot().settings,
          platform: {
            ...screenshotSnapshot().settings.platform,
            [message.platform]: {
              ...screenshotSnapshot().settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "claimReward":
      return screenshotSnapshot();
    case "getPlaybackControl":
      return { managed: true, keepVideosUnmuted: true };
    case "playbackTelemetry":
      return screenshotSnapshot();
  }
}

function screenshotSnapshot(): RuntimeSnapshot {
  const now = Date.now();
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    running: true,
    platform: {
      twitch: {
        enabled: true,
        watchQueueChannels: ["rivalspilot", "lootforge", "nightrunlive"],
        excludedChannels: ["spoilerboss"],
        gamePriority: ["marathon legends", "starfall arena", "spellforge"],
      },
      kick: {
        enabled: true,
        watchQueueChannels: ["greenroomgg", "pixelboost"],
        excludedChannels: [],
        gamePriority: ["arena clash"],
      },
    },
    campaignPriorities: {
      "tw-marathon": 3,
      "tw-starfall": 2,
      "tw-spellforge": 1,
    },
  });

  const twitchCampaigns: DropCampaign[] = [
    {
      id: "tw-marathon",
      platform: "twitch",
      name: "Marathon Legends Launch Drops",
      gameName: "Marathon Legends",
      categoryId: "marathon legends",
      startsAt: inHours(-18),
      endsAt: inHours(31),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 3,
      allowedChannels: ["RivalsPilot", "DropHunter", "LootForge", "NightRunLive", "ArenaDesk"],
      rewards: [
        { id: "tw-marathon-badge", name: "Founder Badge", requiredMinutes: 30, watchedMinutes: 30, status: "claimed" },
        { id: "tw-marathon-boost", name: "Signal Booster", requiredMinutes: 60, watchedMinutes: 44, status: "in_progress", isCurrentReward: true },
        { id: "tw-marathon-skin", name: "Chrome Runner Skin", requiredMinutes: 120, watchedMinutes: 0, status: "locked" },
      ],
    },
    {
      id: "tw-starfall",
      platform: "twitch",
      name: "Starfall Arena Weekend",
      gameName: "Starfall Arena",
      categoryId: "starfall arena",
      startsAt: inHours(-6),
      endsAt: inHours(54),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 2,
      isGeneralDrop: true,
      rewards: [
        { id: "tw-starfall-crate", name: "Meteor Crate", requiredMinutes: 45, watchedMinutes: 18, status: "in_progress" },
        { id: "tw-starfall-emote", name: "Victory Emote", requiredMinutes: 90, watchedMinutes: 0, status: "locked" },
      ],
    },
    {
      id: "tw-spellforge",
      platform: "twitch",
      name: "Spellforge Creator Drops",
      gameName: "Spellforge",
      categoryId: "spellforge",
      startsAt: inHours(-3),
      endsAt: inHours(78),
      status: "active",
      accountLinked: false,
      eligibility: "account_not_linked",
      priority: 1,
      allowedChannels: ["ManaCraft", "ArcaneHQ"],
      rewards: [
        { id: "tw-spellforge-card", name: "Arcane Card Back", requiredMinutes: 60, watchedMinutes: 0, status: "locked" },
      ],
    },
  ];

  const kickCampaigns: DropCampaign[] = [
    {
      id: "kick-arena",
      platform: "kick",
      name: "Arena Clash Creator Rewards",
      gameName: "Arena Clash",
      categoryId: "arena clash",
      startsAt: inHours(-11),
      endsAt: inHours(39),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 2,
      allowedChannels: ["GreenRoomGG", "PixelBoost", "ClutchDesk"],
      rewards: [
        { id: "kick-arena-spray", name: "Neon Spray", requiredMinutes: 30, watchedMinutes: 30, status: "claimed" },
        { id: "kick-arena-token", name: "Drop Token", requiredMinutes: 90, watchedMinutes: 22, status: "in_progress" },
      ],
    },
  ];

  return {
    settings,
    state: {
      sessions: {
        twitch: {
          platform: "twitch",
          tabId: 42,
          tabManagedByExtension: true,
          campaignId: "tw-marathon",
          rewardId: "tw-marathon-boost",
          startedAt: inHours(-1.4),
          lastCheckedAt: inHours(-0.05),
          offlineChecks: 0,
          playbackChecks: 8,
          errorChecks: 0,
          status: "watching",
          message: "Farming eligible Twitch drop",
          channel: {
            platform: "twitch",
            username: "rivalspilot",
            displayName: "RivalsPilot",
            url: "https://www.twitch.tv/rivalspilot",
            campaignId: "tw-marathon",
            categoryId: "marathon legends",
            categoryName: "Marathon Legends",
            isAclMatch: true,
            viewerCount: 18420,
            live: true,
          },
        },
        kick: {
          platform: "kick",
          tabId: 43,
          tabManagedByExtension: true,
          campaignId: "kick-arena",
          rewardId: "kick-arena-token",
          startedAt: inHours(-0.8),
          lastCheckedAt: inHours(-0.04),
          offlineChecks: 0,
          playbackChecks: 5,
          errorChecks: 0,
          status: "watching",
          message: "Farming eligible Kick drop",
          channel: {
            platform: "kick",
            username: "greenroomgg",
            displayName: "GreenRoomGG",
            url: "https://kick.com/greenroomgg",
            campaignId: "kick-arena",
            categoryId: "arena clash",
            categoryName: "Arena Clash",
            isAclMatch: true,
            viewerCount: 9340,
            live: true,
          },
        },
      },
      campaigns: {
        twitch: twitchCampaigns,
        kick: kickCampaigns,
      },
      diagnostics: {
        twitch: {
          platform: "twitch",
          checkedAt: new Date(now - 45_000).toISOString(),
          ok: true,
          campaignCount: twitchCampaigns.length,
          eligibleCampaignCount: 2,
          candidateCount: 8,
          message: "Mock screenshot data",
        },
        kick: {
          platform: "kick",
          checkedAt: new Date(now - 50_000).toISOString(),
          ok: true,
          campaignCount: kickCampaigns.length,
          eligibleCampaignCount: 1,
          candidateCount: 3,
          message: "Mock screenshot data",
        },
      },
      events: [
        { id: "ev-1", at: new Date(now - 18_000).toISOString(), platform: "twitch", level: "info", message: "Watching RivalsPilot · farming Marathon Legends Launch Drops" },
        { id: "ev-2", at: new Date(now - 96_000).toISOString(), platform: "twitch", level: "info", message: "Claimed reward Founder Badge from Marathon Legends Launch Drops" },
        { id: "ev-3", at: new Date(now - 142_000).toISOString(), platform: "twitch", level: "warn", message: "Spellforge Creator Drops skipped — account not linked" },
        { id: "ev-4", at: new Date(now - 210_000).toISOString(), platform: "twitch", level: "info", message: "Switched channel to RivalsPilot (18.4K viewers) for higher priority drop" },
        { id: "ev-5", at: new Date(now - 264_000).toISOString(), level: "info", message: "Scheduler tick complete · 2 eligible campaigns across Twitch and Kick" },
        { id: "ev-6", at: new Date(now - 318_000).toISOString(), platform: "twitch", level: "info", message: "Refocused farming tab to advance an ad countdown" },
      ],
      lastTickAt: new Date(now - 45_000).toISOString(),
    },
  };
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
  const [platform, setPlatform] = useState<Platform>(SCREENSHOT_MODE ? SCREENSHOT_VARIANT.platform : "twitch");
  const [tab, setTab] = useState<PopupTab>(SCREENSHOT_MODE && SCREENSHOT_VARIANT.view === "watchQueue" ? "watchQueue" : "drops");
  const [settingsOpen, setSettingsOpen] = useState(SCREENSHOT_MODE && SCREENSHOT_VARIANT.view === "settings");
  const [activityOpen, setActivityOpen] = useState(SCREENSHOT_MODE && SCREENSHOT_VARIANT.view === "activity");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAutomation, setPendingAutomation] = useState<Partial<Record<Platform, boolean>>>({});

  useEffect(() => {
    void Promise.all([
      send<RuntimeSnapshot>({ type: "getSnapshot" }),
      SCREENSHOT_MODE
        ? Promise.resolve({ [SELECTED_PLATFORM_KEY]: SCREENSHOT_VARIANT.platform })
        : browser.storage.local.get(SELECTED_PLATFORM_KEY),
    ]).then(([nextSnapshot, stored]) => {
      const savedPlatform = stored[SELECTED_PLATFORM_KEY];
      if (isPlatform(savedPlatform)) setPlatform(savedPlatform);
      setSnapshot({ ...nextSnapshot, settings: mergeSettings(nextSnapshot.settings) });
    });
  }, []);

  // Keep the snapshot (and its Activity log) live while the popup is open, so
  // background scheduler ticks are reflected without needing a manual refresh.
  useEffect(() => {
    if (SCREENSHOT_MODE) return;
    const interval = setInterval(() => {
      void send<RuntimeSnapshot>({ type: "getSnapshot" }).then((nextSnapshot) => {
        // Keep the locally-held settings rather than the refreshed ones so an
        // in-flight edit is never clobbered mid-typing. The tradeoff: a setting
        // changed by the background (e.g. startup auto-pausing `running`) is not
        // reflected until the popup is reopened.
        setSnapshot((current) => current ? { ...nextSnapshot, settings: current.settings } : { ...nextSnapshot, settings: mergeSettings(nextSnapshot.settings) });
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  function selectPlatform(nextPlatform: Platform): void {
    setPlatform(nextPlatform);
    if (!SCREENSHOT_MODE) void browser.storage.local.set({ [SELECTED_PLATFORM_KEY]: nextPlatform });
  }

  async function updateSettings(patch: Partial<ExtensionSettings>, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void> {
    if (!snapshot) return;
    const nextSettings = mergeSettings({ ...snapshot.settings, ...patch });
    setSnapshot({ ...snapshot, settings: nextSettings });
    const nextSnapshot = await send<RuntimeSnapshot>({
      type: "saveSettings",
      settings: nextSettings,
      tickAfterSave: options?.tickAfterSave,
      tickAfterSavePlatforms: options?.tickAfterSavePlatforms,
    });
    setSnapshot({ ...nextSnapshot, settings: mergeSettings({ ...nextSnapshot.settings, ...nextSettings }) });
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

  const settings = mergeSettings(snapshot.settings);
  const excludedIds = new Set(settings.excludedCampaignIds);
  const rawCampaigns = sortCampaignsForPopup(snapshot.state.campaigns[platform].filter((campaign) => isCampaignVisible(campaign, settings, excludedIds)), settings);
  const session = snapshot.state.sessions[platform];
  const sessionChannel = channelViewFromSession(session);
  const campaigns = rawCampaigns.map((campaign, index) => campaignViewFromCampaign(campaign, index, session, excludedIds.has(campaign.id)));
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
        <header className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/logo-ring.svg" alt="Stream Autopilot" width={36} height={36} className="h-9 w-9 rounded-xl shadow-sm" style={{ boxShadow: "0 4px 14px -4px var(--accent-glow)" }} />
            <div className="min-w-0 leading-tight">
              <div className="font-display truncate text-[15px] font-bold tracking-normal text-zinc-900 dark:text-zinc-50">Stream Autopilot</div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: enabled ? "var(--accent)" : "#a1a1aa" }} />
                {settingsOpen ? "Settings" : activityOpen ? "Activity" : `${enabled ? "Active" : "Paused"} · ${PLATFORMS[platform].label}`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Refresh schedule" onClick={() => void refreshNow()} disabled={refreshing}>
              <RotateCcw size={16} className={cn(refreshing && "animate-spin")} />
            </IconButton>
            <IconButton
              label={activityOpen ? "Close activity" : "Open activity"}
              active={activityOpen}
              onClick={() => { setActivityOpen((value) => !value); setSettingsOpen(false); }}
            >
              {activityOpen ? <X size={16} /> : <Clock3 size={16} />}
            </IconButton>
            <IconButton
              label={settingsOpen ? "Close settings" : "Open settings"}
              active={settingsOpen}
              onClick={() => { setSettingsOpen((value) => !value); setActivityOpen(false); }}
            >
              {settingsOpen ? <X size={16} /> : <SettingsIcon size={16} />}
            </IconButton>
          </div>
        </header>
        {!settingsOpen && !activityOpen ? (
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
                <SettingsView games={settingsGames} settings={settings} onSettingsChange={updateSettings} initialPlatform={platform} />
              </motion.div>
            ) : activityOpen ? (
              <motion.div key="activity" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }} transition={{ duration: 0.18 }}>
                <ActivityLog events={snapshot.state.events} platform={platform} lastTickAt={snapshot.state.lastTickAt} enabledLogLevels={settings.enabledLogLevels} />
              </motion.div>
            ) : (
              <motion.div key="main" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }} className="space-y-3">
                <AutomationHero platformLabel={PLATFORMS[platform].label} enabled={enabled} pending={automationPending} farmingTitle={activeCampaign?.title} farmingChannel={farmingChannel} statusMessage={session.message} onChange={setAutomation} />
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
                        onToggleExclude={(id) => {
                          const next = new Set(settings.excludedCampaignIds);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return updateSettings({ excludedCampaignIds: [...next] }, { tickAfterSave: true });
                        }}
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
        </div>
      </div>
      {settingsOpen ? <AttributionFooter version={EXTENSION_VERSION} /> : null}
    </main>
  );
}

function formatEventTime(at: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const EVENT_LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "#6366f1",
  info: "#a1a1aa",
  warn: "#f59e0b",
  error: "#ef4444",
};

const EVENT_LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
};

// Visibility filters shown in the Drops settings section, in display order.
const CAMPAIGN_FILTERS: Array<{ key: CampaignFilterKey; label: string }> = [
  { key: "notLinked", label: "Not linked" },
  { key: "upcoming", label: "Upcoming" },
  { key: "expired", label: "Expired" },
  { key: "excluded", label: "Excluded" },
  { key: "finished", label: "Finished" },
];

function ActivityLog({
  events,
  platform,
  lastTickAt,
  enabledLogLevels,
}: {
  events: EventLogEntry[];
  platform: Platform;
  lastTickAt?: string;
  enabledLogLevels: LogLevel[];
}): React.ReactElement {
  // The display filter defaults to the levels that are actually recorded —
  // disabled levels have no entries anyway — but stays user-toggleable below.
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(() => new Set(enabledLogLevels));
  useEffect(() => {
    setActiveLevels(new Set(enabledLogLevels));
  }, [enabledLogLevels.join(",")]);
  const forPlatform = useMemo(
    () => events.filter((event) => !event.platform || event.platform === platform),
    [events, platform],
  );
  const visible = useMemo(
    () => forPlatform.filter((event) => activeLevels.has(event.level)).slice(-80).reverse(),
    [forPlatform, activeLevels],
  );
  const errorCount = forPlatform.filter((event) => event.level === "error").length;
  const toggleLevel = (level: LogLevel) =>
    setActiveLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
          <Clock3 size={13} className="text-zinc-400" />
          {PLATFORMS[platform].label} activity
          {errorCount > 0 ? (
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: EVENT_LEVEL_COLOR.error }}>
              {errorCount}
            </span>
          ) : null}
        </span>
        <span className="text-[10px] font-medium text-zinc-400">
          {lastTickAt ? `last check ${formatEventTime(lastTickAt)}` : "no checks yet"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-0.5">
        {LOG_LEVELS.map((level) => {
          const active = activeLevels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition ${active
                ? "border-transparent text-white"
                : "border-zinc-200 text-zinc-400 dark:border-zinc-700"}`}
              style={active ? { backgroundColor: EVENT_LEVEL_COLOR[level] } : undefined}
              aria-pressed={active}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "#ffffff" : EVENT_LEVEL_COLOR[level] }} />
              {EVENT_LEVEL_LABEL[level]}
            </button>
          );
        })}
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200/70 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/50">
        {visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[11px] text-zinc-400">No activity recorded yet. Press refresh to run a check.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {visible.map((event) => (
              <li key={event.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] leading-snug">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: EVENT_LEVEL_COLOR[event.level] }} />
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">{formatEventTime(event.at)}</span>
                <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-300">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StoreScreenshot({ variant, children }: { variant: ScreenshotVariant; children: React.ReactNode }): React.ReactElement {
  return (
    <div
      data-platform={variant.platform}
      className="grid h-[800px] w-[1280px] grid-cols-[1fr_460px] overflow-hidden bg-zinc-950 text-white"
    >
      <section className="relative flex min-w-0 flex-col justify-center px-20">
        <div className="pointer-events-none absolute inset-0" style={{ background: variant.accentGradient.replace(/_/g, " ") }} />
        <div className="relative max-w-[590px]">
          <img src="/logo-ring.svg" alt="" width={76} height={76} className="mb-8 h-[76px] w-[76px]" />
          <h1 className="font-display text-[62px] font-bold leading-[0.96] tracking-normal text-white">
            {variant.headline}
          </h1>
          <p className="mt-6 max-w-[520px] text-[22px] leading-snug text-zinc-300">
            {variant.subcopy}
          </p>
          <div className="mt-9 flex gap-3">
            <span className="rounded-lg bg-white px-4 py-2 text-[15px] font-bold text-zinc-950">Twitch</span>
            <span className="rounded-lg bg-[#53fc18] px-4 py-2 text-[15px] font-bold text-[#07140a]">Kick</span>
            <span className="rounded-lg border border-white/18 bg-white/8 px-4 py-2 text-[15px] font-semibold text-zinc-200">Auto-claim ready</span>
          </div>
        </div>
      </section>
      <section className="relative flex items-center justify-start">
        <div className="rounded-[28px] bg-white/10 p-5 shadow-2xl shadow-black/50 ring-1 ring-white/12">
          {children}
        </div>
      </section>
    </div>
  );
}

function AttributionFooter({ version }: { version: string }): React.ReactElement {
  return (
    <footer className="flex h-9 shrink-0 items-center justify-between border-t border-zinc-200/70 bg-white/85 px-3 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-500">
      <span className="text-[10px] font-medium tabular">v{version}</span>
      <nav aria-label="Attribution links" className="flex items-center gap-1.5">
        <a
          href="https://github.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title="jamezrin on GitHub"
          aria-label="jamezrin on GitHub"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <Github size={15} />
        </a>
        <a
          href="https://x.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title="jamezrin on X"
          aria-label="jamezrin on X"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <XLogoIcon />
        </a>
      </nav>
    </footer>
  );
}

function XLogoIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M17.53 3h3.06l-6.68 7.64L21.77 21h-6.16l-4.82-6.3L5.27 21H2.21l7.15-8.17L1.83 3h6.32l4.36 5.76L17.53 3Zm-1.07 16.18h1.7L7.23 4.72H5.41l11.05 14.46Z" />
    </svg>
  );
}

function PlatformSwitcher({ active, automation, onChange }: { active: Platform; automation: Record<Platform, boolean>; onChange(platform: Platform): void }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
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

function AutomationHero({ platformLabel, enabled, pending, onChange, farmingTitle, farmingChannel, statusMessage }: { platformLabel: string; enabled: boolean; pending: boolean; onChange(value: boolean): Promise<void>; farmingTitle?: string; farmingChannel?: FarmingChannelView; statusMessage?: string }) {
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
                  <p className="line-clamp-2 leading-snug" title={statusMessage}>{statusMessage ?? "Waiting for an eligible stream"}</p>
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

function DropsPanel({ campaigns, gameMap, onReorder, onToggleExclude }: { campaigns: CampaignView[]; gameMap: Record<string, GameItem>; onReorder(campaigns: CampaignView[]): void | Promise<void>; onToggleExclude(id: string): void | Promise<void> }) {
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const firstId = campaigns[0]?.id;
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(firstId ? { [firstId]: true } : {});
  const activeCampaign = campaigns.find((campaign) => campaign.id === activeId);
  const activeIndex = campaigns.findIndex((campaign) => campaign.id === activeId);
  const anyFarming = campaigns.some((campaign) => Boolean(campaign.farmingChannel));

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
            <SortableCampaign key={campaign.id} campaign={campaign} index={index} anyFarming={anyFarming} game={gameMap[campaign.gameId] ?? fallbackGame(campaign, index)} expanded={Boolean(expandedIds[campaign.id])} onToggle={() => setExpandedIds((current) => ({ ...current, [campaign.id]: !current[campaign.id] }))} onToggleExclude={onToggleExclude} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeCampaign ? <CampaignCard campaign={activeCampaign} index={activeIndex} anyFarming={anyFarming} game={gameMap[activeCampaign.gameId] ?? fallbackGame(activeCampaign, activeIndex)} expanded={false} onToggle={() => undefined} isOverlay dragHandle={<GripVertical size={16} className="text-zinc-400" />} /> : null}

      </DragOverlay>
    </DndContext>
  );
}

function SortableCampaign(props: { campaign: CampaignView; index: number; anyFarming: boolean; game: GameItem; expanded: boolean; onToggle(): void; onToggleExclude(id: string): void | Promise<void> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.campaign.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CampaignCard {...props} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${props.campaign.title}`} />} />
    </div>
  );
}

function ImageWithFallback({ src, alt, className, fit = "cover", fallback }: { src?: string; alt: string; className?: string; fit?: "cover" | "contain"; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{fallback}</>;
  return <img src={src} alt={alt} loading="lazy" className={cn("h-full w-full", fit === "cover" ? "object-cover" : "object-contain", className)} onError={() => setFailed(true)} />;
}

function CampaignCard({ campaign, index, anyFarming, game, expanded, onToggle, onToggleExclude, dragHandle, isOverlay = false, dimmed = false }: { campaign: CampaignView; index: number; anyFarming: boolean; game: GameItem; expanded: boolean; onToggle(): void; onToggleExclude?(id: string): void | Promise<void>; dragHandle?: React.ReactNode; isOverlay?: boolean; dimmed?: boolean }) {
  const stats = campaignStats(campaign);
  const isFarming = Boolean(campaign.farmingChannel);
  const emphasized = isFarming || (!anyFarming && index === 0);
  const channelLabel = campaign.allowedChannels[0] === "All" ? "All channels" : `${campaign.allowedChannels.length + campaign.moreChannels} channels`;

  return (
    <article className={cn("overflow-hidden rounded-2xl border bg-white transition-shadow dark:bg-zinc-900", emphasized ? "border-transparent" : "border-zinc-200 dark:border-zinc-800", isOverlay ? "shadow-2xl shadow-black/25" : "shadow-sm", dimmed && "opacity-40")} style={emphasized ? { boxShadow: isOverlay ? "0 20px 50px -12px rgba(0,0,0,0.5)" : "0 0 0 1.5px var(--accent-ring), 0 10px 30px -18px var(--accent-glow)" } : undefined}>
      <div className="flex items-stretch">
        <div className="flex w-8 shrink-0 items-center justify-center border-r border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">{dragHandle ?? <GripVertical size={16} className="text-zinc-300 dark:text-zinc-600" />}</div>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 p-2.5 text-left outline-none">
          <div className="relative flex h-10 w-10 shrink-0 items-end overflow-hidden rounded-lg shadow-inner">
            <ImageWithFallback src={campaign.imageUrl} alt={campaign.title} fit="cover" fallback={
              <div className={cn("flex h-full w-full items-end bg-gradient-to-br p-1.5", campaign.tint)}>
                <span className="text-[11px] font-black leading-none tracking-normal text-white drop-shadow">{campaign.thumbnail}</span>
              </div>
            } />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="line-clamp-1 text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{campaign.title}</div>
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
              {isFarming && <Pill tone="accent"><Radio size={9} /> Farming</Pill>}
              {!campaign.linked && <Pill tone="danger"><Link2 size={9} /> Not linked</Pill>}
              {campaign.excluded && <Pill tone="outline"><Ban size={9} /> Excluded</Pill>}
            </div>
            <div className="mt-2"><ProgressBar value={stats.progress} glow={emphasized} /></div>
          </div>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-2.5 p-2.5 pt-0">
                <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 dark:border-zinc-800 dark:bg-zinc-800/40">
                  <div className="flex items-end justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400"><Clock3 size={10} /> Ends in {formatCountdown(campaign.ends)}</div>
                      {stats.complete
                        ? <div className="mt-0.5 truncate text-[11px] font-medium" style={{ color: "var(--accent-text)" }}>Complete</div>
                        : <div className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">Next: <span className="font-medium text-zinc-800 dark:text-zinc-100">{stats.nextReward?.name}</span></div>}
                    </div>
                    {!stats.complete && <div className="shrink-0 text-right text-[10px] tabular text-zinc-500 dark:text-zinc-400">{formatMinutes(stats.remaining)} left</div>}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <MetaStat icon={Clock3} label="Farmed" value={formatHours(stats.totalFarmed)} />
                  <MetaStat icon={RotateCcw} label="Left" value={stats.complete ? "Done" : formatMinutes(stats.remaining)} />
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
                    <Ban size={12} /> {campaign.excluded ? "Include in farming" : "Exclude from farming"}
                  </button>
                )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
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

function SettingsView({ games, settings, onSettingsChange, initialPlatform = "twitch" }: {
  games: Record<Platform, GameItem[]>;
  settings: ExtensionSettings;
  onSettingsChange(patch: Partial<ExtensionSettings>, options?: { tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }): Promise<void>;
  initialPlatform?: Platform;
}) {
  const [platformTab, setPlatformTab] = useState<Platform>(initialPlatform);
  const set = (key: keyof ExtensionSettings) => (value: boolean) => onSettingsChange({ [key]: value } as Partial<ExtensionSettings>);
  const pollIntervalSeconds = Math.round(settings.pollIntervalMinutes * 60);
  const tabPlaybackDisabled = settings.tablessMode;
  const tabPlaybackDisabledReason = "Disabled while tabless low-resource mode is enabled.";
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
  const setPlatformExcludedChannels = (platform: Platform) => (excludedChannels: string[]) => onSettingsChange(
    {
      platform: {
        ...settings.platform,
        [platform]: {
          ...settings.platform[platform],
          excludedChannels,
        },
      },
    },
    { tickAfterSave: true, tickAfterSavePlatforms: [platform] },
  );

  return (
    <div className="space-y-6">
      <SettingsSection title="General settings" description="Applies to Twitch and Kick." icon={SettingsIcon}>
        <SettingRow title="Pause when watching manually" description="Stop farming while you have a stream open and are watching yourself." checked={settings.pauseOnManualWatch} onChange={set("pauseOnManualWatch")} />
        <SettingRow title="Auto-start on launch" description="Begin farming as soon as the extension loads." checked={settings.autoStartDropFarming} onChange={set("autoStartDropFarming")} />
      </SettingsSection>
      <SettingsSection title="Notifications" description="Applies to all enabled platforms." icon={Bell}>
        <SettingRow title="Reward earned" description="Notify when a drop reward is claimable." checked={settings.notifyRewardEarned} onChange={set("notifyRewardEarned")} />
        <SettingRow title="No drops left" description="Notify when all active campaigns are exhausted." checked={settings.notifyNoDropsLeft} onChange={set("notifyNoDropsLeft")} />
      </SettingsSection>
      <SettingsSection title="Drops" description="Shared campaign farming behavior." icon={Gift}>
        <SettingRow title="Auto-claim drops" description="Claim earned drop rewards automatically when they become available." checked={settings.autoClaim} onChange={set("autoClaim")} />
        <SelectSettingRow
          title="Campaign priority"
          description="How campaigns are chosen to farm. Priority list only farms just your prioritized campaigns and games; the others pick among all campaigns."
          value={settings.priorityMode}
          options={[
            { value: "priority_list_only", label: "Priority list only" },
            { value: "ending_soonest", label: "Ending soonest" },
            { value: "lowest_availability", label: "Low availability first" },
          ]}
          onChange={(value) => onSettingsChange({ priorityMode: value }, { tickAfterSave: true })}
        />
        <CampaignFilterSettingRow value={settings.campaignVisibility} onChange={(campaignVisibility) => onSettingsChange({ campaignVisibility })} />
      </SettingsSection>
      <SettingsSection title="Watch Queue" description="Shared fallback queue behavior." icon={Play}>
        <SettingRow title="Only when no drops are active" description="Preserves drop priority automatically." checked={settings.watchQueueFallbackOnly} onChange={set("watchQueueFallbackOnly")} />
      </SettingsSection>
      <SettingsSection title="Platform settings" description="Automation and channels for one provider. Switch between Twitch and Kick." icon={Radio} divided={false}>
        <SettingsPlatformSwitch active={platformTab} onChange={setPlatformTab} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={platformTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} className="space-y-3">
            <PlatformSettingsGroup platform={platformTab} games={games[platformTab]} settings={settings} onEnabledChange={setPlatformEnabled(platformTab)} onGamePriorityChange={setPlatformGamePriority(platformTab)} onExcludedChannelsChange={setPlatformExcludedChannels(platformTab)} />
          </motion.div>
        </AnimatePresence>
      </SettingsSection>
      <SettingsSection title="Farming tabs" description="Controls for video-tab farming. Tab-specific controls are disabled while tabless low-resource mode is enabled." icon={Play}>
        <SettingRow title="Tabless low-resource mode" description="Farm via lightweight watch signals instead of a video tab. Twitch uses watch heartbeats; Kick uses a viewer connection. Falls back to a tab automatically if it stops earning." checked={settings.tablessMode} onChange={(value) => onSettingsChange({ tablessMode: value }, { tickAfterSave: true })} />
        <SettingRow title="Auto-close farming tabs" description="Automatically close when the extension is idle (no drops to farm or no streamers to watch)." checked={settings.autoCloseFinishedDrops} onChange={set("autoCloseFinishedDrops")} />
        <SettingRow title="Mute farming tabs" description="Keep drop and Watch Queue tabs muted while farming." checked={settings.muteFarmingTabs} onChange={set("muteFarmingTabs")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />
        <SettingRow title="Keep farming videos unmuted" description="Keeps page video players unmuted while the browser tab is muted." checked={settings.keepFarmingVideosUnmuted !== false} onChange={set("keepFarmingVideosUnmuted")} disabled={tabPlaybackDisabled} disabledReason={tabPlaybackDisabledReason} />
        <SelectSettingRow
          title="Focus tab during ads"
          description="Ad countdowns freeze in background tabs. Briefly focus the farming tab while an ad plays so it counts down, then restore your previous tab."
          value={settings.adFocusMode ?? "window"}
          options={[
            { value: "none", label: "Off" },
            { value: "tab", label: "Tab only" },
            { value: "window", label: "Tab + window" },
          ]}
          onChange={(value) => onSettingsChange({ adFocusMode: value })}
          disabled={tabPlaybackDisabled}
          disabledReason={tabPlaybackDisabledReason}
        />
      </SettingsSection>
      <SettingsSection title="Advanced" description="Only change these if you know what you are doing — they control low-level scheduler and logging behavior." icon={SlidersHorizontal}>
        <NumberSettingRow title="Scheduler interval" description="How often campaign and streamer status refreshes." value={pollIntervalSeconds} min={30} max={3600} suffix="sec" onChange={(value) => onSettingsChange({ pollIntervalMinutes: value / 60 })} />
        <LogLevelSettingRow value={settings.enabledLogLevels} onChange={(levels) => onSettingsChange({ enabledLogLevels: levels })} />
      </SettingsSection>
    </div>
  );
}

function PlatformSettingsGroup({ platform, games, settings, onEnabledChange, onGamePriorityChange, onExcludedChannelsChange }: {
  platform: Platform;
  games: GameItem[];
  settings: ExtensionSettings;
  onEnabledChange(enabled: boolean): void | Promise<void>;
  onGamePriorityChange(games: GameItem[]): void | Promise<void>;
  onExcludedChannelsChange(channels: string[]): void | Promise<void>;
}) {
  const details = PLATFORMS[platform];
  const platformSettings = settings.platform[platform];
  const queueCount = platformSettings.watchQueueChannels.length;
  const excludedChannels = platformSettings.excludedChannels ?? [];

  return (
    <>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
        <div className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">Enable automation</span>
              <Pill tone={platformSettings.enabled ? "live" : "muted"}>{platformSettings.enabled ? "Enabled" : "Paused"}</Pill>
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Farm drops and watch the queue on {details.label}.</div>
          </div>
          <Toggle checked={platformSettings.enabled} onChange={onEnabledChange} label={`${details.label} platform automation`} />
        </div>
        <div className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">Watch Queue</div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Edit it from the Watch Queue tab after selecting {details.label}.</div>
          </div>
          <Pill tone="outline">{queueCount}/20</Pill>
        </div>
      </div>
      <ChannelListEditor
        title="Excluded drop channels"
        description="Campaign farming will skip these streamers."
        empty="No excluded drop channels."
        channels={excludedChannels}
        onChange={onExcludedChannelsChange}
      />
      <GamePriority games={games} label={`${details.label} game order`} onChange={onGamePriorityChange} />
    </>
  );
}

function SettingsPlatformSwitch({ active, onChange }: { active: Platform; onChange(platform: Platform): void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {Object.entries(PLATFORMS).map(([id, platform]) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id as Platform)}
            className={cn("relative flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}
          >
            {selected && <motion.span layoutId="settings-platform-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
            <span className="relative z-10 flex h-4 w-4 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color }}>
              {platform.mark}
            </span>
            <span className="relative z-10">{platform.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChannelListEditor({ title, description, empty, channels, onChange }: {
  title: string;
  description: string;
  empty: string;
  channels: string[];
  onChange(channels: string[]): void | Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  function addChannel(): void {
    const username = value.trim().replace(/^@+/, "").toLowerCase();
    if (!username || channels.includes(username)) {
      setValue("");
      setAdding(false);
      return;
    }
    void onChange([...channels, username]);
    setValue("");
    setAdding(false);
  }

  function removeChannel(username: string): void {
    void onChange(channels.filter((channel) => channel !== username));
  }

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200/70 p-2.5 dark:border-zinc-800">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400"><Ban size={12} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
        <Pill tone="outline">{channels.length}</Pill>
      </div>
      {channels.length === 0 ? <div className="text-[11px] text-zinc-400">{empty}</div> : (
        <div className="flex flex-wrap gap-1.5">
          {channels.map((channel) => (
            <span key={channel} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              <span className="truncate">{channel}</span>
              <RemoveRowButton label={`Remove ${channel}`} onClick={() => removeChannel(channel)} />
            </span>
          ))}
        </div>
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
    <div className="space-y-2 rounded-xl border border-zinc-200/70 p-2.5 dark:border-zinc-800">
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

function SettingsSection({ title, description, icon: Icon, iconNode, divided = true, children }: { title: string; description?: string; icon?: LucideIcon; iconNode?: React.ReactNode; divided?: boolean; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (SCREENSHOT_MODE) return;
    let mounted = true;
    void browser.storage.local.get(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      if (!mounted) return;
      const collapsed = stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean | undefined> | undefined;
      setExpanded(collapsed?.[title] === false);
    });
    return () => {
      mounted = false;
    };
  }, [title]);

  function toggleExpanded(): void {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (SCREENSHOT_MODE) return;
    void browser.storage.local.get(COLLAPSED_SETTINGS_SECTIONS_KEY).then((stored) => {
      const collapsed = {
        ...((stored[COLLAPSED_SETTINGS_SECTIONS_KEY] as Record<string, boolean> | undefined) ?? {}),
        [title]: !nextExpanded,
      };
      void browser.storage.local.set({ [COLLAPSED_SETTINGS_SECTIONS_KEY]: collapsed });
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

function SettingRow({ title, description, checked, onChange, disabled = false, disabledReason }: {
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
function LogLevelSettingRow({ value, onChange }: { value: LogLevel[]; onChange(levels: LogLevel[]): void | Promise<void> }) {
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
      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">Activity log levels</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        Choose which levels are recorded in the Activity log. Errors are always kept.
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
              {EVENT_LEVEL_LABEL[level]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Controls which campaign states appear in the Drops list. A state with its pill
// turned off is hidden; campaigns in none of these states are always shown.
function CampaignFilterSettingRow({ value, onChange }: { value: Record<CampaignFilterKey, boolean>; onChange(value: Record<CampaignFilterKey, boolean>): void | Promise<void> }) {
  const toggle = (key: CampaignFilterKey) => onChange({ ...value, [key]: !value[key] });
  return (
    <div className="py-2.5">
      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">Visible campaigns</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
        Choose which campaign states show in the Drops list. A campaign with a claimable reward always stays visible.
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
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SelectSettingRow<T extends string>({ title, description, value, options, onChange, disabled = false, disabledReason }: {
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

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange(value: boolean): void | Promise<void>; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => void onChange(!checked)} className={cn("relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]", checked ? "" : "bg-zinc-200 dark:bg-zinc-700", disabled && "cursor-not-allowed opacity-70")} style={checked ? { backgroundColor: "var(--accent)" } : undefined}>
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

function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  if (campaign.endsAt) {
    const endsAt = Date.parse(campaign.endsAt);
    if (!Number.isNaN(endsAt) && endsAt < Date.now()) return true;
  }
  return false;
}

function isCampaignFinished(campaign: DropCampaign): boolean {
  if (campaign.status === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

// The special states a campaign falls into. The lifecycle state is single-valued
// (finished wins over expired wins over upcoming); "notLinked" and "excluded" are
// independent flags that can stack on top of it.
function campaignFilterCategories(campaign: DropCampaign, excludedIds: Set<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (campaign.status === "upcoming") categories.push("upcoming");
  return categories;
}

// A campaign is shown unless it falls into a category the user has toggled off.
// A claimable reward always keeps it visible so it can still be claimed.
function isCampaignVisible(campaign: DropCampaign, settings: ExtensionSettings, excludedIds: Set<string>): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  return campaignFilterCategories(campaign, excludedIds).every((key) => settings.campaignVisibility[key]);
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
  const complete = campaign.rewards.length > 0 && progress >= 100;
  return { totalRequired, totalFarmed, remaining, progress, completed, totalRewards: campaign.rewards.length, nextReward, complete };
}

function campaignViewFromCampaign(campaign: DropCampaign, index: number, session: WatchSession, excluded: boolean): CampaignView {
  const visibleChannels = channelsForView(campaign);
  return {
    id: campaign.id,
    gameId: gameId(campaign),
    title: campaign.name,
    linked: campaign.accountLinked !== false,
    excluded,
    ends: campaign.endsAt ?? campaign.rewards.find((reward) => reward.availableUntil)?.availableUntil ?? "",
    allowedChannels: visibleChannels.channels,
    moreChannels: visibleChannels.more,
    farmingChannel: session.campaignId === campaign.id ? channelViewFromSession(session) : undefined,
    thumbnail: initials(campaign.gameName ?? campaign.name),
    tint: CAMPAIGN_TINTS[index % CAMPAIGN_TINTS.length],
    imageUrl: campaign.gameImageUrl,
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
        // Kick stores reward images as relative paths (drops/reward-image/…png).
        // Resolve to an absolute ext.kick.com URL at render time so already-persisted
        // state renders correctly without waiting for a fresh discovery tick.
        // Idempotent for absolute URLs, so Twitch (already absolute) is unaffected.
        imageUrl: campaign.platform === "kick" ? kickRewardImageUrl(reward.imageUrl) : reward.imageUrl,
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

createRoot(document.getElementById("root")!).render(
  SCREENSHOT_MODE ? (
    <StoreScreenshot variant={SCREENSHOT_VARIANT}>
      <Popup />
    </StoreScreenshot>
  ) : (
    <Popup />
  ),
);
