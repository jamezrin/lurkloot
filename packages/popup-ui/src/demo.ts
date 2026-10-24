import type {
  ActivityPage,
  CategorySearchResult,
  DiagnosticsExport,
  PlaybackControl,
  RuntimeMessage,
  RuntimeSnapshot,
} from "@lurkloot/shared/messages";
import type { ActivityEvent, StoredEngineEvent } from "@lurkloot/shared/events";
import type {
  DropCampaign,
  Platform,
  SupportedLocale,
  TwitchExtensionSummary,
} from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import type { PopupAdapter } from "./types";
import { openHttpsLink } from "./links";

export type DemoScenario = "default" | "tour";

function handleDemoMessage(
  message: RuntimeMessage,
  scenario: DemoScenario,
):
  | RuntimeSnapshot
  | PlaybackControl
  | CategorySearchResult
  | ActivityPage
  | DiagnosticsExport
  | undefined {
  switch (message.type) {
    case "getSnapshot":
    case "tickNow":
      return demoSnapshot(scenario);
    case "searchCategories":
      return {
        categories: [
          { id: "marathon legends", name: "Marathon Legends" },
          { id: "starfall arena", name: "Starfall Arena" },
          { id: "spellforge", name: "Spellforge" },
        ].filter((category) => category.name.toLowerCase().includes(message.query.toLowerCase())),
      };
    case "saveSettings":
      return {
        ...demoSnapshot(scenario),
        settings: applySettingsPatch(demoSnapshot(scenario).settings, message.settingsPatch),
      };
    case "setAutomation":
      return {
        ...demoSnapshot(scenario),
        settings: mergeSettings({
          ...demoSnapshot(scenario).settings,
          platform: {
            ...demoSnapshot(scenario).settings.platform,
            [message.platform]: {
              ...demoSnapshot(scenario).settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "setPlatformEnabled":
      return {
        ...demoSnapshot(scenario),
        settings: mergeSettings({
          ...demoSnapshot(scenario).settings,
          platform: {
            ...demoSnapshot(scenario).settings.platform,
            [message.platform]: {
              ...demoSnapshot(scenario).settings.platform[message.platform],
              enabled: message.enabled,
            },
          },
        }),
      };
    case "claimReward":
    case "playbackTelemetry":
    case "clearActivity":
    // The demo host never offers credential export (no exportCredentials hook),
    // so this is unreachable — return a snapshot to keep the switch exhaustive.
    case "exportCliCredentials":
      return demoSnapshot(scenario);
    case "getActivity":
      return {
        events: scenario === "tour" ? tourActivity(message.platform, message.category) : [],
        nextCursor: undefined,
      };
    case "exportDiagnostics":
      return { events: [] };
    case "getPlaybackControl":
      return { managed: true, keepVideosUnmuted: true };
  }
}

export function createDemoPopupAdapter(options?: {
  locale?: SupportedLocale;
  version?: string;
  // "tour" layers the onboarding tour's data onto the default demo; omitting it
  // keeps the landing site, screenshots and promo artwork exactly as they were.
  scenario?: DemoScenario;
}): PopupAdapter {
  const scenario = options?.scenario ?? "default";
  const store: Record<string, unknown> = {};
  return {
    version: options?.version ?? "1.0.0",
    send: async <T>(message: RuntimeMessage) => handleDemoMessage(message, scenario) as T,
    getStorage: async (keys?: string | string[]) => {
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      return { ...store };
    },
    setStorage: async (values: Record<string, unknown>) => {
      Object.assign(store, values);
    },
    getMessage: () => "",
    getUiLanguage: () => options?.locale ?? "en",
    openLink: (url) =>
      openHttpsLink(url, (safeUrl) => window.open(safeUrl, "_blank", "noopener,noreferrer")),
  };
}

function demoSnapshot(scenario: DemoScenario): RuntimeSnapshot {
  const snapshot = defaultDemoSnapshot();
  return scenario === "tour" ? tourSnapshot(snapshot) : snapshot;
}

function defaultDemoSnapshot(): RuntimeSnapshot {
  const now = Date.now();
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    platform: {
      twitch: {
        enabled: true,
        watchSourcePriority: [...DEFAULT_SETTINGS.platform.twitch.watchSourcePriority],
        idleWatchlistChannels: ["rivalspilot", "lootforge", "nightrunlive"],
        excludedChannels: ["spoilerboss"],
        strictCampaignAvailability: false,
        channelPointsPushClaim: true,
        idleWatchlistStreakChannels: [],
        categoryMode: "include",
        rewardFilter: defaultRewardFilter("twitch"),
        farmPinnedOnly: false,
        unlinkedCampaigns: "include",
        categories: [
          { id: "marathon legends", name: "Marathon Legends" },
          { id: "starfall arena", name: "Starfall Arena" },
          { id: "spellforge", name: "Spellforge" },
          { id: "pixel parade", name: "Pixel Parade" },
        ],
        // Starfall Arena is a favourite: its campaigns rank above the strategy
        // without being pinned, which is what the demo is meant to show.
        favouriteCategories: [{ id: "starfall arena", name: "Starfall Arena" }],
        blockedCategories: [],
        autoClaimChannelPoints: true,
      },
      kick: {
        enabled: true,
        watchSourcePriority: [...DEFAULT_SETTINGS.platform.kick.watchSourcePriority],
        idleWatchlistChannels: ["greenroomgg", "pixelboost"],
        excludedChannels: [],
        categoryMode: "all",
        rewardFilter: defaultRewardFilter("kick"),
        farmPinnedOnly: false,
        unlinkedCampaigns: "include",
        categories: [{ id: "just chatting", name: "Just Chatting" }],
        favouriteCategories: [],
        // Exercises the denylist alongside Twitch's allowlist: Kick farms every
        // category except this one.
        blockedCategories: [{ id: "just chatting", name: "Just Chatting" }],
        autoClaimChallenges: true,
      },
    },
    campaignPins: ["tw-marathon"],
  });

  const twitchCampaigns: DropCampaign[] = [
    {
      id: "tw-marathon",
      platform: "twitch",
      name: "Marathon Legends Launch Drops",
      gameName: "Marathon Legends",
      slug: "marathon-legends",
      categoryId: "marathon legends",
      startsAt: inHours(-18),
      endsAt: inHours(31),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 3,
      allowedChannels: ["RivalsPilot", "DropHunter", "LootForge", "NightRunLive", "ArenaDesk"],
      rewards: [
        {
          id: "tw-marathon-badge",
          name: "Founder Badge",
          benefits: [
            { id: "tw-marathon-badge-benefit", name: "Founder Badge", distributionType: "BADGE" },
          ],
          requiredMinutes: 30,
          watchedMinutes: 30,
          status: "claimed",
        },
        {
          id: "tw-marathon-boost",
          name: "Signal Booster",
          requiredMinutes: 60,
          watchedMinutes: 44,
          status: "in_progress",
          isCurrentReward: true,
        },
        {
          id: "tw-marathon-skin",
          name: "Chrome Runner Skin",
          requiredMinutes: 120,
          watchedMinutes: 0,
          status: "locked",
        },
        {
          id: "tw-marathon-charm",
          name: "Orbit Charm",
          requiredMinutes: 180,
          watchedMinutes: 0,
          status: "locked",
        },
        {
          id: "tw-marathon-emote",
          name: "Runner Emote",
          benefits: [
            { id: "tw-marathon-emote-benefit", name: "Runner Emote", distributionType: "EMOTE" },
          ],
          requiredMinutes: 240,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    },
    {
      id: "tw-starfall",
      platform: "twitch",
      name: "Starfall Arena Weekend",
      gameName: "Starfall Arena",
      slug: "starfall-arena",
      categoryId: "starfall arena",
      startsAt: inHours(-6),
      endsAt: inHours(54),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 2,
      isGeneralDrop: true,
      rewards: [
        {
          id: "tw-starfall-crate",
          name: "Meteor Crate",
          requiredMinutes: 45,
          watchedMinutes: 18,
          status: "in_progress",
        },
        {
          id: "tw-starfall-emote",
          name: "Victory Emote",
          requiredMinutes: 90,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    },
    {
      id: "tw-spellforge",
      platform: "twitch",
      name: "Spellforge Creator Drops",
      gameName: "Spellforge",
      slug: "spellforge",
      categoryId: "spellforge",
      startsAt: inHours(-3),
      endsAt: inHours(78),
      status: "active",
      accountLinked: false,
      eligibility: "account_not_linked",
      priority: 1,
      allowedChannels: ["ManaCraft", "ArcaneHQ"],
      rewards: [
        {
          id: "tw-spellforge-card",
          name: "Arcane Card Back",
          requiredMinutes: 60,
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    },
    // Badges across requirements, so the Queue's "Has badge" tab has a campaign
    // to farm: a watch badge, an item, and a badge sharing a reward with one.
    {
      id: "tw-pixel-parade",
      platform: "twitch",
      name: "Pixel Parade Community Badges",
      gameName: "Pixel Parade",
      slug: "pixel-parade",
      categoryId: "pixel parade",
      startsAt: inHours(-30),
      endsAt: inHours(140),
      status: "active",
      accountLinked: true,
      eligibility: "eligible",
      priority: 1,
      isGeneralDrop: true,
      rewards: [
        {
          id: "tw-pixel-parade-watch-badge",
          name: "Parade Badge",
          benefits: [
            { id: "tw-pixel-parade-badge", name: "Parade Badge", distributionType: "BADGE" },
          ],
          requiredMinutes: 120,
          watchedMinutes: 35,
          status: "in_progress",
        },
        {
          id: "tw-pixel-parade-spray",
          name: "Confetti Spray",
          benefits: [
            {
              id: "tw-pixel-parade-spray",
              name: "Confetti Spray",
              distributionType: "DIRECT_ENTITLEMENT",
            },
          ],
          requiredMinutes: 60,
          watchedMinutes: 35,
          status: "in_progress",
        },
        {
          // One reward, two benefits: the badge is not the first of them.
          id: "tw-pixel-parade-supporter",
          name: "Float Skin",
          benefits: [
            {
              id: "tw-pixel-parade-float",
              name: "Float Skin",
              distributionType: "DIRECT_ENTITLEMENT",
            },
            {
              id: "tw-pixel-parade-supporter-badge",
              name: "Supporter Badge",
              distributionType: "BADGE",
            },
          ],
          requiredMinutes: 30,
          requiredSubs: 1,
          requirement: "subscription",
          watchedMinutes: 0,
          status: "locked",
        },
      ],
    },
    // One of each ended state, so Completed is a populated view in the demo and
    // in the store screenshots rather than an empty shell.
    {
      id: "tw-marathon-season1",
      platform: "twitch",
      name: "Marathon Legends Season 1",
      gameName: "Marathon Legends",
      slug: "marathon-legends",
      categoryId: "marathon legends",
      startsAt: inHours(-320),
      endsAt: inHours(-96),
      status: "completed",
      accountLinked: true,
      rewards: [
        {
          id: "tw-marathon-season1-banner",
          name: "Season 1 Banner",
          requiredMinutes: 60,
          watchedMinutes: 60,
          status: "claimed",
        },
        {
          id: "tw-marathon-season1-charm",
          name: "Relay Charm",
          requiredMinutes: 120,
          watchedMinutes: 120,
          status: "claimed",
        },
      ],
    },
    {
      id: "tw-starfall-preseason",
      platform: "twitch",
      name: "Starfall Arena Preseason",
      gameName: "Starfall Arena",
      slug: "starfall-arena",
      categoryId: "starfall arena",
      startsAt: inHours(-260),
      endsAt: inHours(-48),
      status: "expired",
      accountLinked: true,
      rewards: [
        {
          id: "tw-starfall-preseason-skin",
          name: "Comet Skin",
          requiredMinutes: 180,
          watchedMinutes: 45,
          status: "locked",
        },
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
        {
          id: "kick-arena-spray",
          name: "Neon Spray",
          requiredMinutes: 30,
          watchedMinutes: 30,
          status: "claimed",
        },
        {
          id: "kick-arena-token",
          name: "Drop Token",
          requiredMinutes: 90,
          watchedMinutes: 22,
          status: "in_progress",
        },
      ],
    },
  ];

  return {
    settings,
    state: {
      authHealth: {
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      },
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
      accountProgress: {
        kick: {
          lastCheckedAt: new Date(now - 120_000).toISOString(),
          fetchedAt: new Date(now - 120_000).toISOString(),
          progress: {
            platform: "kick",
            level: 34,
            progressXp: 5120,
            xpToNextLevel: 3080,
            streakDays: 12,
          },
        },
      },
      lastTickAt: new Date(now - 45_000).toISOString(),
    },
  };
}

// The tour reads the same data as the default demo, plus what its steps point at:
// the Queue shows every tier (pin, favourite, then the unlinked campaign farmed
// last), the Extensions step shows both providers, and Tips stay out of the way.
function tourSnapshot(base: RuntimeSnapshot): RuntimeSnapshot {
  const now = Date.now();
  const updatedAt = new Date(now - 30_000).toISOString();
  const twitchExtensions: Record<"nopixel" | "fortnite", TwitchExtensionSummary> = {
    nopixel: {
      status: "farming",
      reasonCode: "watchtime",
      progress: [{ key: "daily-pack", earned: 2, required: 3 }],
      pending: [{ key: "giveaway", state: "open" }],
      channel: { username: "rivalspilot", displayName: "RivalsPilot" },
      updatedAt,
    },
    fortnite: {
      status: "farming",
      reasonCode: "collecting",
      progress: [{ key: "rewards", earned: 1, required: 4 }],
      pending: [{ key: "takeover", state: "open" }],
      channel: { username: "lootforge", displayName: "LootForge" },
      updatedAt,
    },
  };
  return {
    ...base,
    settings: {
      ...base.settings,
      showTips: false,
      twitchExtensions: {
        nopixel: { ...base.settings.twitchExtensions.nopixel, enabled: true },
        fortnite: { ...base.settings.twitchExtensions.fortnite, enabled: true },
      },
      platform: {
        ...base.settings.platform,
        twitch: { ...base.settings.platform.twitch, unlinkedCampaigns: "last" },
      },
    },
    state: { ...base.state, twitchExtensions },
  };
}

function tourActivity(platform: Platform | undefined, category: string): StoredEngineEvent[] {
  if (category !== "activity") return [];
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const event = (id: string, minutesAgo: number, body: ActivityEvent): StoredEngineEvent => ({
    ...body,
    id: `tour-${id}`,
    at: at(minutesAgo),
  });
  const twitchReward = {
    campaignId: "tw-marathon",
    campaignName: "Marathon Legends Launch Drops",
  };
  const kickReward = { campaignId: "kick-arena", campaignName: "Arena Clash Creator Rewards" };
  const events: StoredEngineEvent[] = [
    event("tw-started", 84, {
      category: "activity",
      code: "farming_started",
      level: "info",
      platform: "twitch",
      data: {
        ...twitchReward,
        rewardId: "tw-marathon-boost",
        rewardName: "Signal Booster",
        channel: "rivalspilot",
      },
    }),
    event("tw-claimed", 190, {
      category: "activity",
      code: "reward_claimed",
      level: "info",
      platform: "twitch",
      data: {
        ...twitchReward,
        rewardId: "tw-marathon-badge",
        rewardName: "Founder Badge",
        method: "automatic",
      },
    }),
    event("tw-stopped", 205, {
      category: "activity",
      code: "farming_stopped",
      level: "info",
      platform: "twitch",
      data: {
        ...twitchReward,
        rewardId: "tw-marathon-badge",
        rewardName: "Founder Badge",
        reason: "watch_requirement_completed",
      },
    }),
    event("kick-started", 48, {
      category: "activity",
      code: "farming_started",
      level: "info",
      platform: "kick",
      data: {
        ...kickReward,
        rewardId: "kick-arena-token",
        rewardName: "Drop Token",
        channel: "greenroomgg",
      },
    }),
    event("kick-claimed", 120, {
      category: "activity",
      code: "reward_claimed",
      level: "info",
      platform: "kick",
      data: {
        ...kickReward,
        rewardId: "kick-arena-spray",
        rewardName: "Neon Spray",
        method: "automatic",
      },
    }),
    event("kick-challenge", 150, {
      category: "activity",
      code: "challenge_claimed",
      level: "info",
      platform: "kick",
      data: { challengeId: "tour-daily", rarity: "Rare", recurrence: "Daily" },
    }),
  ];
  return events
    .filter((entry) => !platform || ("platform" in entry && entry.platform === platform))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
