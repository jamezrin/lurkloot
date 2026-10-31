import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseCampaignDecision } from "@lurkloot/core/scheduler";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type {
  ChannelCandidate,
  DropCampaign,
  DropReward,
  ExtensionSettings,
  SchedulerState,
} from "@lurkloot/shared/models";
import { runSchedulerTick, type SchedulerMockAdapter } from "./helpers/schedulerTick";

// Scheduling of Twitch reward campaigns (#904): campaigns that earn in any of
// several categories and whose groups earn once per window.

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const NEXT_WINDOW = "2026-11-01T00:00:00.000Z";

const pokemon = { id: "490655", name: "Pokémon GO" };
const chatting = { id: "509658", name: "Just Chatting" };

function groupReward(patch: Partial<DropReward> = {}): DropReward {
  return {
    id: "g1",
    name: "Poke Ball",
    requiredMinutes: 20,
    watchedMinutes: 0,
    requirement: "watch",
    isWatchBased: true,
    status: "locked",
    claimId: "viewer#night-out#g1",
    claimKey: "viewer#night-out#g1#1",
    repeat: { grantCount: 1, times: 3 },
    benefits: [{ id: "ball", name: "Poke Ball", distributionType: "BADGE" }],
    ...patch,
  };
}

function rewardCampaign(reward: DropReward = groupReward()): DropCampaign {
  return {
    id: "night-out",
    platform: "twitch",
    name: "Pokémon Night Out Campaign",
    brand: "Pokemon",
    categories: [pokemon, chatting],
    sitewide: true,
    status: "active",
    eligibility: "eligible",
    accountLinked: true,
    endsAt: "2026-11-23T22:59:59.999Z",
    allowedChannels: [],
    isGeneralDrop: true,
    rewards: [reward],
  };
}

const channel = (username: string, categoryId: string): ChannelCandidate => ({
  platform: "twitch",
  username,
  displayName: username,
  url: `https://www.twitch.tv/${username}`,
  categoryId,
  live: true,
});

function settings(patch: Partial<ExtensionSettings["platform"]["twitch"]> = {}) {
  return {
    ...DEFAULT_SETTINGS,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, ...patch },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
    },
  } as ExtensionSettings;
}

function adapter(campaigns: () => DropCampaign[]): SchedulerMockAdapter {
  return {
    platform: "twitch",
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    refreshCampaigns: vi.fn(async () => campaigns()),
    listCandidateChannels: vi.fn(async () => [channel("trainer", pokemon.id)]),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: 42, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

const idle: SchedulerState = {
  authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
  sessions: {
    twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
    kick: { platform: "kick", status: "idle", offlineChecks: 0 },
  },
  campaigns: { twitch: [], kick: [] },
};

describe("reward campaign scheduling (#904)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks for channels only in the categories the settings allow", async () => {
    const twitch = adapter(() => [rewardCampaign()]);
    const decision = await chooseCampaignDecision(
      "twitch",
      [rewardCampaign()],
      settings({ blockedCategories: [chatting] }),
      twitch,
    );
    expect(decision).toMatchObject({ action: "watch", campaign: { id: "night-out" } });
    expect(vi.mocked(twitch.listCandidateChannels).mock.calls[0]?.[0].categories).toEqual([
      pokemon,
    ]);
    // The decision keeps the campaign as discovered.
    expect(decision.campaign?.categories).toEqual([pokemon, chatting]);
  });

  it("opens nothing while a grant waits for its next window, then farms it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const cooling = rewardCampaign(
      groupReward({ status: "in_progress", availableFrom: NEXT_WINDOW }),
    );
    const twitch = adapter(() => [cooling]);
    let state = idle;
    // Eleven hours of one-minute ticks before the window opens.
    for (let tick = 0; tick < 11 * 60; tick += 1) {
      vi.setSystemTime(T0 + tick * 60_000);
      state = (
        await runSchedulerTick(
          state,
          settings(),
          { twitch, kick: adapter(() => []) },
          {
            platforms: ["twitch"],
          },
        )
      ).state;
      expect(state.sessions.twitch.status).not.toBe("watching");
    }
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(state.criticalHealth?.twitch?.managedTabOpens.length ?? 0).toBe(0);

    vi.setSystemTime(Date.parse(NEXT_WINDOW) + 60_000);
    state = (
      await runSchedulerTick(
        state,
        settings(),
        { twitch, kick: adapter(() => []) },
        {
          platforms: ["twitch"],
        },
      )
    ).state;
    expect(state.sessions.twitch).toMatchObject({ status: "watching", campaignId: "night-out" });
  });

  it("never opens a tab for a group whose progress is unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const unknown = rewardCampaign(
      groupReward({ requirement: "action", isWatchBased: false, status: "locked" }),
    );
    unknown.eligibility = "no_rewards";
    const twitch = adapter(() => [unknown]);
    let state = idle;
    for (let tick = 0; tick < 6 * 60; tick += 1) {
      vi.setSystemTime(T0 + tick * 60_000);
      state = (
        await runSchedulerTick(
          state,
          settings(),
          { twitch, kick: adapter(() => []) },
          {
            platforms: ["twitch"],
          },
        )
      ).state;
    }
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(twitch.listCandidateChannels).not.toHaveBeenCalled();
  });
});
