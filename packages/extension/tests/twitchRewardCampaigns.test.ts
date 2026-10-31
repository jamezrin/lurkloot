import { afterEach, describe, expect, it, vi } from "vitest";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import {
  farmableRewardCampaignIds,
  parseTwitchRewardCampaign,
  rewardGroupState,
  type TwitchDropsCampaign,
  type TwitchRewardGroup,
  type TwitchRewardGroupSelf,
} from "@lurkloot/core/twitch/rewardCampaigns";
import { twitchStreamCategoryMatches } from "@lurkloot/core/twitch/parser";
import { preserveClaimedRewards } from "@lurkloot/core/scheduler";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import {
  campaignForWatching,
  campaignPassesCategoryFilter,
  categoryListIndex,
  isCampaignCategoryBlocked,
} from "@lurkloot/shared/categories";
import { isBadgeReward } from "@lurkloot/shared/rewards";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { DropCampaign, ExtensionSettings } from "@lurkloot/shared/models";
import { jsonFetcher, twitchAdapter } from "./helpers/adapters";

// Twitch reward campaigns (#904). The shapes below follow a HAR of Twitch's
// drops page (2026-10-31) and the drops tray's channelDropCampaignsProgress
// selection in Twitch's web bundle; ids are shortened and the viewer id is
// made up.

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const USER = "viewer-1";

const POKEMON_GO = { id: "490655", displayName: "Pokémon GO" };
const JUST_CHATTING = { id: "509658", displayName: "Just Chatting" };

function watchGroup(id: string, patch: Partial<TwitchRewardGroup> = {}): TwitchRewardGroup {
  return {
    id,
    name: `Group ${id}`,
    track: null,
    lane: null,
    progressCriteria: {
      requirementType: "WATCH",
      requirements: { minutesWatched: 20 },
      repeatableConfig: { repeatableTimes: 3, shouldCompleteAllRepeatsToEarn: false },
      channels: [],
      categories: [POKEMON_GO, JUST_CHATTING],
    },
    rewards: [
      {
        id: `${id}-reward`,
        name: "Pokémon Night Out Themed Poke Ball",
        thumbnailURL: "https://static-cdn.jtvnw.net/ball.png",
        distributionType: "POOL",
        pool: {
          rewards: [
            { id: "gastly", name: "Gastly", dropDetail: { badge: { id: "Z2FzdGx5OzE7" } } },
          ],
        },
      },
    ],
    ...patch,
  };
}

function nightOut(groups: TwitchRewardGroup[] = [watchGroup("g1")]): TwitchDropsCampaign {
  return {
    id: "night-out",
    name: "Pokémon Night Out Campaign",
    status: "ACTIVE",
    brandName: "Pokemon",
    detailsURL: "https://help.twitch.tv/s/article/pokemon-chat-badges",
    imageURL: "https://static-cdn.jtvnw.net/campaign.png",
    startAt: "2026-10-16T17:00:00Z",
    endAt: "2026-11-23T22:59:59.999Z",
    rewardGroups: groups,
  };
}

function inProgress(minutes: number, patch: Partial<TwitchRewardGroupSelf> = {}) {
  return {
    status: "IN_PROGRESS",
    currentMinutesWatched: minutes,
    grantCount: 0,
    nextEligibleAt: null,
    currentWindow: { startedAt: "2026-10-31T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z" },
    ...patch,
  } satisfies TwitchRewardGroupSelf;
}

function parse(
  campaign: TwitchDropsCampaign,
  progress: Record<string, TwitchRewardGroupSelf>,
  equipped: Record<string, string> = {},
): DropCampaign {
  const parsed = parseTwitchRewardCampaign({
    campaign,
    progress: new Map(Object.entries(progress)),
    equippedLanes: new Map(Object.entries(equipped)),
    userId: USER,
    now: NOW,
  });
  if (!parsed) throw new Error("campaign did not parse");
  return parsed;
}

function settings(patch: Partial<ExtensionSettings["platform"]["twitch"]> = {}) {
  return {
    ...DEFAULT_SETTINGS,
    platform: {
      ...DEFAULT_SETTINGS.platform,
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, ...patch },
    },
  } as ExtensionSettings;
}

describe("twitch reward campaign parsing (#904)", () => {
  it("lists only sitewide campaigns earned by watching", () => {
    expect(
      farmableRewardCampaignIds([
        { id: "first-partners", isSitewide: true, unlockRequirements: { minuteWatchedGoal: 20 } },
        {
          id: "apple-tv",
          isSitewide: true,
          unlockRequirements: { subsGoal: 1, minuteWatchedGoal: 0 },
        },
        { id: "channel-only", isSitewide: false, unlockRequirements: { minuteWatchedGoal: 20 } },
      ]),
    ).toEqual(["first-partners"]);
  });

  it("farms a group as a watch reward in any of its categories", () => {
    const campaign = parse(nightOut(), { g1: inProgress(5) });
    expect(campaign).toMatchObject({
      id: "night-out",
      platform: "twitch",
      sitewide: true,
      brand: "Pokemon",
      categories: [
        { id: "490655", name: "Pokémon GO" },
        { id: "509658", name: "Just Chatting" },
      ],
      status: "active",
      eligibility: "eligible",
    });
    expect(campaign.categoryId).toBeUndefined();
    expect(campaign.gameName).toBeUndefined();
    const [reward] = campaign.rewards;
    expect(reward).toMatchObject({
      id: "g1",
      requirement: "watch",
      requiredMinutes: 20,
      watchedMinutes: 5,
      status: "in_progress",
      claimId: `${USER}#night-out#g1`,
      claimKey: `${USER}#night-out#g1#0`,
      repeat: { grantCount: 0, times: 3 },
    });
    // A ball that only ever holds badges is a badge reward.
    expect(isBadgeReward(reward!)).toBe(true);
    expect(evaluateCampaignFarming(campaign, settings(), { now: NOW })).toEqual({ farmable: true });
  });

  it("never farms a group whose progress no drops tray answered for", () => {
    const campaign = parse(nightOut(), {});
    expect(campaign.rewards[0]).toMatchObject({ requirement: "action", isWatchBased: false });
    expect(evaluateCampaignFarming(campaign, settings(), { now: NOW }).farmable).toBe(false);
  });

  it("waits for the next window once today's grant is in", () => {
    const self = inProgress(0, { grantCount: 1, nextEligibleAt: "2026-11-01T00:00:00Z" });
    const campaign = parse(nightOut(), { g1: self });
    expect(campaign.rewards[0]).toMatchObject({
      status: "in_progress",
      availableFrom: "2026-11-01T00:00:00Z",
      claimKey: `${USER}#night-out#g1#1`,
    });
    expect(evaluateCampaignFarming(campaign, settings(), { now: NOW })).toMatchObject({
      farmable: false,
      code: "reward_not_started",
    });
    expect(
      evaluateCampaignFarming(campaign, settings(), {
        now: Date.parse("2026-11-01T00:00:01Z"),
      }),
    ).toEqual({ farmable: true });
  });

  it("stops counting minutes from a window that has ended", () => {
    const state = rewardGroupState(
      watchGroup("g1"),
      inProgress(15, {
        currentWindow: { startedAt: "2026-10-30T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z" },
      }),
      NOW,
    );
    expect(state).toMatchObject({ status: "locked", watchedMinutes: 0 });
  });

  it("claims as Twitch's tray does, and only after every grant when the group pays at the end", () => {
    expect(
      rewardGroupState(watchGroup("g1"), inProgress(20, { status: "CLAIMABLE" }), NOW),
    ).toMatchObject({ status: "claimable" });
    const completeAll = watchGroup("g1", {
      progressCriteria: {
        ...watchGroup("g1").progressCriteria,
        repeatableConfig: { repeatableTimes: 3, shouldCompleteAllRepeatsToEarn: true },
      },
    });
    expect(
      rewardGroupState(completeAll, inProgress(20, { status: "CLAIMABLE", grantCount: 1 }), NOW)
        .status,
    ).not.toBe("claimable");
    expect(
      rewardGroupState(completeAll, inProgress(20, { status: "CLAIMABLE", grantCount: 3 }), NOW)
        .status,
    ).toBe("claimable");
    for (const status of ["CLAIMED", "FULFILLED", "EXPIRED"]) {
      expect(rewardGroupState(watchGroup("g1"), inProgress(0, { status }), NOW).status).toBe(
        "claimed",
      );
    }
    expect(rewardGroupState(watchGroup("g1"), inProgress(0, { grantCount: 3 }), NOW).status).toBe(
      "claimed",
    );
  });

  it("earns only the equipped lane of a track and offers the others to pick", () => {
    const haunter = watchGroup("haunter", { name: "Haunter", track: "pokemon#t", lane: "gastly" });
    const ivysaur = watchGroup("ivysaur", {
      name: "Ivysaur",
      track: "pokemon#t",
      lane: "bulbasaur",
    });
    const progress = { haunter: inProgress(0), ivysaur: inProgress(0) };

    const none = parse(nightOut([haunter, ivysaur]), progress);
    expect(none.rewards.map((reward) => reward.requirement)).toEqual(["action", "action"]);
    expect(none.laneChoices).toEqual([
      {
        track: "pokemon#t",
        lanes: [
          expect.objectContaining({ lane: "gastly", name: "Haunter", equipped: false }),
          expect.objectContaining({ lane: "bulbasaur", name: "Ivysaur", equipped: false }),
        ],
      },
    ]);

    const equipped = parse(nightOut([haunter, ivysaur]), progress, { "pokemon#t": "bulbasaur" });
    expect(equipped.rewards.map((reward) => [reward.id, reward.requirement])).toEqual([
      ["haunter", "action"],
      ["ivysaur", "watch"],
    ]);
    expect(equipped.laneChoices?.[0]?.lanes.map((lane) => lane.equipped)).toEqual([false, true]);
  });

  it("does not farm a group limited to channels it can only name by id", () => {
    const group = watchGroup("g1", {
      progressCriteria: { ...watchGroup("g1").progressCriteria, channels: [{ id: "123" }] },
    });
    expect(parse(nightOut([group]), { g1: inProgress(0) }).rewards[0]?.requirement).toBe("action");
  });

  it("does not farm a group in a status it does not know", () => {
    const campaign = parse(nightOut(), { g1: inProgress(5, { status: "PAUSED" }) });
    expect(campaign.rewards[0]).toMatchObject({ requirement: "action" });
    expect(evaluateCampaignFarming(campaign, settings(), { now: NOW }).farmable).toBe(false);
  });

  it("gates nothing on a track that has a single lane", () => {
    const ball = watchGroup("g1", { track: "balls#t", lane: "duskball" });
    const campaign = parse(nightOut([ball]), { g1: inProgress(0) });
    expect(campaign.rewards[0]).toMatchObject({ requirement: "watch" });
    expect(campaign.laneChoices).toBeUndefined();
  });

  it("lists a campaign waiting for a lane under Action required, not as empty", () => {
    const haunter = watchGroup("haunter", { name: "Haunter", track: "pokemon#t", lane: "gastly" });
    const ivysaur = watchGroup("ivysaur", {
      name: "Ivysaur",
      track: "pokemon#t",
      lane: "bulbasaur",
    });
    const campaign = parse(nightOut([haunter, ivysaur]), {
      haunter: inProgress(0),
      ivysaur: inProgress(0),
    });
    expect(campaign.eligibility).toBe("eligible");
    expect(evaluateCampaignFarming(campaign, settings(), { now: NOW })).toMatchObject({
      farmable: false,
      code: "action_required",
    });
  });

  it("keeps a claim of one grant from marking the next one claimed", () => {
    const claimedToday = parse(nightOut(), { g1: inProgress(20, { status: "CLAIMABLE" }) });
    const recorded = {
      ...claimedToday,
      rewards: claimedToday.rewards.map((reward) => ({ ...reward, status: "claimed" as const })),
    };
    // The next refresh: Twitch moved on to grant 1, cooling down until tomorrow.
    const tomorrow = parse(nightOut(), {
      g1: inProgress(0, { grantCount: 1, nextEligibleAt: "2026-11-01T00:00:00Z" }),
    });
    const [kept] = preserveClaimedRewards([tomorrow], [recorded]);
    expect(kept?.rewards[0]?.status).toBe("in_progress");

    // A refresh that still reports the claimed grant keeps it claimed.
    const lagging = parse(nightOut(), { g1: inProgress(20, { status: "CLAIMABLE" }) });
    const [held] = preserveClaimedRewards([lagging], [recorded]);
    expect(held?.rewards[0]?.status).toBe("claimed");
  });
});

describe("multi-category campaigns (#904)", () => {
  const campaign = parse(nightOut(), { g1: inProgress(0) });
  const pokemon = { id: "490655", name: "Pokémon GO" };
  const chatting = { id: "509658", name: "Just Chatting" };

  it("matches a stream in any of its categories and nowhere else", () => {
    expect(twitchStreamCategoryMatches("490655", campaign)).toBe(true);
    expect(twitchStreamCategoryMatches("509658", campaign)).toBe(true);
    expect(twitchStreamCategoryMatches("21779", campaign)).toBe(false);
    expect(twitchStreamCategoryMatches(undefined, campaign)).toBe(false);
  });

  it("passes a category filter through any one of its categories", () => {
    expect(categoryListIndex(campaign, [{ id: "x", name: "Other" }, chatting])).toBe(1);
    expect(
      campaignPassesCategoryFilter(campaign, { categoryMode: "include", categories: [pokemon] }),
    ).toBe(true);
    expect(
      campaignPassesCategoryFilter(campaign, {
        categoryMode: "include",
        categories: [{ id: "x", name: "Other" }],
      }),
    ).toBe(false);
  });

  it("is blocked only when every category is, and is watched in the rest", () => {
    expect(isCampaignCategoryBlocked(campaign, { blockedCategories: [chatting] })).toBe(false);
    expect(isCampaignCategoryBlocked(campaign, { blockedCategories: [chatting, pokemon] })).toBe(
      true,
    );
    expect(
      campaignForWatching(campaign, {
        categoryMode: "all",
        categories: [],
        blockedCategories: [chatting],
      }).categories,
    ).toEqual([pokemon]);
    expect(
      campaignForWatching(campaign, { categoryMode: "include", categories: [chatting] }).categories,
    ).toEqual([chatting]);
  });
});

describe("twitch adapter reward campaigns (#904)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function directory(login: string, id: string) {
    return {
      data: {
        game: {
          streams: {
            edges: [
              {
                node: {
                  id: `${login}-broadcast`,
                  viewersCount: 100,
                  broadcaster: { id, login, displayName: login },
                },
              },
            ],
          },
        },
      },
    };
  }

  function rewardFetcher(
    options: {
      progress?: (channelID: string) => unknown;
      claimStatus?: string | null;
      laneError?: string | null;
      listing?: () => unknown;
    } = {},
  ) {
    const operations: string[] = [];
    const variables: Record<string, unknown>[] = [];
    const handle = (body: Record<string, unknown>): unknown => {
      const op = String(body.operationName);
      operations.push(op);
      variables.push((body.variables ?? {}) as Record<string, unknown>);
      switch (op) {
        case "Inventory":
          return {
            data: { currentUser: { id: USER, inventory: { dropCampaignsInProgress: [] } } },
          };
        case "ViewerDropsDashboard":
          return { data: { currentUser: { id: USER, login: "viewer", dropCampaigns: [] } } };
        case "RewardCampaignsAvailable":
          if (options.listing) return options.listing();
          return {
            data: {
              rewardCampaignsAvailableToUser: [
                {
                  id: "night-out",
                  isSitewide: true,
                  game: null,
                  unlockRequirements: { minuteWatchedGoal: 20, subsGoal: 0 },
                },
              ],
            },
          };
        case "RewardCampaignDetails":
          return { data: { dropsCampaign: nightOut() } };
        case "GameSlugs": {
          const id = String((body.variables as { g0?: string }).g0);
          return { data: { g0: { id, slug: `slug-${id}` } } };
        }
        case "DirectoryPage_Game":
          return directory("trainer", "777");
        case "RewardCampaignProgress": {
          const channelID = String((body.variables as { channelID?: string }).channelID);
          return (
            options.progress?.(channelID) ?? {
              data: {
                channelDropCampaignsProgress: [
                  { id: "night-out", rewardGroups: [{ id: "g1", self: inProgress(7) }] },
                ],
              },
            }
          );
        }
        case "DropsPage_ClaimDropRewards":
          return { data: { claimDropRewards: { status: options.claimStatus ?? null } } };
        case "VideoPlayerStreamInfoOverlayChannel":
          return { data: { user: null } };
        case "SetRewardTrackSelection":
          return { data: { setTrackSelection: { error: options.laneError ?? null } } };
        default:
          throw new Error(`Unexpected operation ${op}`);
      }
    };
    const fetcher = jsonFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as
        | Record<string, unknown>
        | Record<string, unknown>[];
      return Array.isArray(body) ? body.map(handle) : handle(body);
    });
    return { fetcher, operations, variables };
  }

  it("discovers a reward campaign with progress read from a live channel's drops tray", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { fetcher, operations, variables } = rewardFetcher();
    const discoveryState = new TwitchDiscoveryState();
    const campaigns = await twitchAdapter(fetcher, undefined, {
      discoveryState,
    }).refreshCampaigns();

    const campaign = campaigns.find((item) => item.id === "night-out");
    expect(campaign).toMatchObject({ sitewide: true, eligibility: "eligible" });
    expect(campaign?.rewards[0]).toMatchObject({ watchedMinutes: 7, requirement: "watch" });
    // The probe channel came from the first category's directory.
    const probe = operations.indexOf("RewardCampaignProgress");
    expect(variables[probe]).toEqual({ channelID: "777" });

    // A minute later nothing about the reward campaign is requested again.
    operations.length = 0;
    vi.setSystemTime(NOW + 60_000);
    await twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns();
    expect(operations).not.toContain("RewardCampaignsAvailable");
    expect(operations).not.toContain("RewardCampaignDetails");
    expect(operations).not.toContain("RewardCampaignProgress");
  });

  it("reads the farmed campaign's progress from the watched channel on every refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { fetcher, operations, variables } = rewardFetcher({
      progress: (channelID) =>
        channelID === "watched-id"
          ? {
              data: {
                channelDropCampaignsProgress: [
                  { id: "night-out", rewardGroups: [{ id: "g1", self: inProgress(12) }] },
                ],
              },
            }
          : undefined,
    });
    const discoveryState = new TwitchDiscoveryState();
    const session = {
      platform: "twitch" as const,
      status: "watching" as const,
      offlineChecks: 0,
      campaignId: "night-out",
      channel: {
        platform: "twitch" as const,
        username: "watched",
        url: "https://www.twitch.tv/watched",
        channelId: "watched-id",
      },
    };
    const first = await twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns(
      session,
    );
    expect(first.find((item) => item.id === "night-out")?.rewards[0]?.watchedMinutes).toBe(12);
    const progressReads = () =>
      operations.flatMap((op, index) =>
        op === "RewardCampaignProgress" ? [variables[index]] : [],
      );
    // The watched channel answered, so no probe channel was needed.
    expect(progressReads()).toEqual([{ channelID: "watched-id" }]);

    // Still read fresh a minute later, while the other caches hold.
    vi.setSystemTime(NOW + 60_000);
    await twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns(session);
    expect(progressReads()).toEqual([{ channelID: "watched-id" }, { channelID: "watched-id" }]);
  });

  it("claims a reward group with the tray's success statuses", async () => {
    const campaign = parse(nightOut(), { g1: inProgress(20, { status: "CLAIMABLE" }) });
    const reward = campaign.rewards[0]!;
    for (const claimStatus of ["LIMITED", null]) {
      const { fetcher, variables, operations } = rewardFetcher({ claimStatus });
      await expect(twitchAdapter(fetcher).claimReward(campaign, reward)).resolves.toBe(true);
      expect(variables[operations.indexOf("DropsPage_ClaimDropRewards")]).toEqual({
        input: { dropInstanceID: `${USER}#night-out#g1` },
      });
    }
    const { fetcher } = rewardFetcher({ claimStatus: "NOT_ELIGIBLE" });
    await expect(twitchAdapter(fetcher).claimReward(campaign, reward)).rejects.toThrow(
      /status=NOT_ELIGIBLE/,
    );
  });

  it("equips a lane the campaign offers and reports Twitch's refusal", async () => {
    const campaign = parse(
      nightOut([
        watchGroup("haunter", { track: "pokemon#t", lane: "gastly" }),
        watchGroup("ivysaur", { track: "pokemon#t", lane: "bulbasaur" }),
      ]),
      { haunter: inProgress(0), ivysaur: inProgress(0) },
    );
    const { fetcher, operations, variables } = rewardFetcher();
    await twitchAdapter(fetcher).selectRewardLane(campaign, "pokemon#t", "gastly");
    expect(variables[operations.indexOf("SetRewardTrackSelection")]).toEqual({
      input: { track: "pokemon#t", lane: "gastly" },
    });

    await expect(
      twitchAdapter(rewardFetcher().fetcher).selectRewardLane(campaign, "pokemon#t", "other"),
    ).rejects.toThrow(/no lane other/);
    await expect(
      twitchAdapter(rewardFetcher({ laneError: "NOT_OWNED" }).fetcher).selectRewardLane(
        campaign,
        "pokemon#t",
        "gastly",
      ),
    ).rejects.toThrow(/NOT_OWNED/);
  });

  it("probes a campaign no drops tray lists once per freshness window, not every tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetcher, operations } = rewardFetcher({
      progress: () => ({ data: { channelDropCampaignsProgress: [] } }),
    });
    const discoveryState = new TwitchDiscoveryState();
    for (let minute = 0; minute < 10; minute += 1) {
      vi.setSystemTime(NOW + minute * 60_000);
      const campaigns = await twitchAdapter(fetcher, undefined, {
        discoveryState,
      }).refreshCampaigns();
      expect(campaigns.find((item) => item.id === "night-out")?.rewards[0]?.requirement).toBe(
        "action",
      );
    }
    const count = (op: string) => operations.filter((item) => item === op).length;
    // Minutes 0, 3, 6 and 9, two categories each.
    expect(count("RewardCampaignProgress")).toBe(8);
    expect(count("GameSlugs")).toBeLessThanOrEqual(2);
  });

  it("counts a campaign the tray lists as answered even where a group has no progress", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { fetcher, operations } = rewardFetcher({
      progress: () => ({
        data: {
          channelDropCampaignsProgress: [
            { id: "night-out", rewardGroups: [{ id: "g1", self: null }] },
          ],
        },
      }),
    });
    const discoveryState = new TwitchDiscoveryState();
    await twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns();
    vi.setSystemTime(NOW + 60_000);
    await twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns();
    expect(operations.filter((op) => op === "RewardCampaignProgress")).toHaveLength(1);
  });

  it("retries a failing listing once per window and keeps the drop refresh working", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetcher, operations } = rewardFetcher({
      listing: () => {
        throw new Error("listing exploded");
      },
    });
    const discoveryState = new TwitchDiscoveryState();
    for (let minute = 0; minute < 10; minute += 1) {
      vi.setSystemTime(NOW + minute * 60_000);
      await expect(
        twitchAdapter(fetcher, undefined, { discoveryState }).refreshCampaigns(),
      ).resolves.toEqual([]);
    }
    expect(operations.filter((op) => op === "RewardCampaignsAvailable")).toHaveLength(2);
  });
});
