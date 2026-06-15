import type { CategorySearchResult, PlaybackControl, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropCampaign, SupportedLocale } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import type { PopupAdapter } from "./types";

function handleDemoMessage(message: RuntimeMessage): RuntimeSnapshot | PlaybackControl | CategorySearchResult {
  switch (message.type) {
    case "getSnapshot":
    case "tickNow":
      return demoSnapshot();
    case "searchCategories":
      return {
        categories: [
          { id: "marathon legends", name: "Marathon Legends" },
          { id: "starfall arena", name: "Starfall Arena" },
          { id: "spellforge", name: "Spellforge" },
        ].filter((category) => category.name.toLowerCase().includes(message.query.toLowerCase())),
      };
    case "saveSettings":
      return { ...demoSnapshot(), settings: applySettingsPatch(demoSnapshot().settings, message.settingsPatch) };
    case "setAutomation":
      return {
        ...demoSnapshot(),
        settings: mergeSettings({
          ...demoSnapshot().settings,
          running: message.enabled,
          platform: {
            ...demoSnapshot().settings.platform,
            [message.platform]: {
              ...demoSnapshot().settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "setRunning":
      return { ...demoSnapshot(), settings: mergeSettings({ ...demoSnapshot().settings, running: message.running }) };
    case "setPlatformEnabled":
      return {
        ...demoSnapshot(),
        settings: mergeSettings({
          ...demoSnapshot().settings,
          platform: {
            ...demoSnapshot().settings.platform,
            [message.platform]: {
              ...demoSnapshot().settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "claimReward":
    case "playbackTelemetry":
      return demoSnapshot();
    case "getPlaybackControl":
      return { managed: true, keepVideosUnmuted: true };
  }
}

export function createDemoPopupAdapter(options?: {
  locale?: SupportedLocale;
  version?: string;
}): PopupAdapter {
  const store: Record<string, unknown> = {};
  return {
    version: options?.version ?? "1.0.0",
    send: async <T,>(message: RuntimeMessage) => handleDemoMessage(message) as T,
    getStorage: async (keys?: string | string[]) => {
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      return { ...store };
    },
    setStorage: async (values: Record<string, unknown>) => {
      Object.assign(store, values);
    },
    connectSettingsSession: () => () => undefined,
    getMessage: () => "",
    getUiLanguage: () => options?.locale ?? "en",
  };
}

function demoSnapshot(): RuntimeSnapshot {
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
        farmAllCategories: false,
        categories: [
          { id: "marathon legends", name: "Marathon Legends" },
          { id: "starfall arena", name: "Starfall Arena" },
          { id: "spellforge", name: "Spellforge" },
        ],
      },
      kick: {
        enabled: true,
        watchQueueChannels: ["greenroomgg", "pixelboost"],
        excludedChannels: [],
        farmAllCategories: true,
        categories: [],
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
