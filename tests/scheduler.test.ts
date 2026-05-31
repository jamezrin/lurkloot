import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, Platform } from "../src/core/models";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { chooseCampaignDecision, runSchedulerTick, sortCampaigns } from "../src/core/scheduler";
import type { PlatformAdapter } from "../src/platforms/adapter";

const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: `reward-${status}`,
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: status === "locked" ? 0 : 20,
  status,
});

const campaign = (id: string, patch: Partial<DropCampaign> = {}): DropCampaign => ({
  id,
  platform: "twitch",
  name: id,
  status: "active",
  rewards: [reward()],
  endsAt: "2026-06-01T00:00:00.000Z",
  ...patch,
});

const channel = (username: string, patch: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
  platform: "twitch",
  username,
  displayName: username,
  url: `https://www.twitch.tv/${username}`,
  ...patch,
});

function settings(patch: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    running: true,
    ...patch,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, ...patch.platform?.twitch },
      kick: { ...DEFAULT_SETTINGS.platform.kick, ...patch.platform?.kick },
    },
  };
}

function adapter(platform: Platform, campaigns: DropCampaign[], candidates: ChannelCandidate[]): PlatformAdapter {
  return {
    platform,
    discoverCampaigns: vi.fn(async () => campaigns),
    readProgress: vi.fn(async (value) => value),
    listCandidateChannels: vi.fn(async () => candidates),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: 42, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

describe("scheduler campaign selection", () => {
  it("uses explicit priority before ending soonest", () => {
    const first = campaign("first", { endsAt: "2026-06-01T00:00:00.000Z" });
    const second = campaign("second", { endsAt: "2026-07-01T00:00:00.000Z" });

    const sorted = sortCampaigns([first, second], settings({
      campaignPriorities: { second: 5 },
    }));

    expect(sorted.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("uses game priority after explicit campaign priority", () => {
    const first = campaign("first", { gameName: "First Game", endsAt: "2026-06-01T00:00:00.000Z" });
    const second = campaign("second", { gameName: "Second Game", endsAt: "2026-07-01T00:00:00.000Z" });

    const sorted = sortCampaigns([first, second], settings({
      gamePriority: ["second game"],
    }));

    expect(sorted.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("does not select campaigns whose only unclaimed reward is outside its earn and claim windows", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("expired-reward", {
        rewards: [{
          ...reward("claimable"),
          claimUntil: "2020-01-01T00:00:00.000Z",
          availableUntil: "2020-01-01T00:00:00.000Z",
        }],
      })],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
  });

  it("does not watch campaigns whose only unclaimed rewards are already claimable", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("claim-only", { rewards: [reward("claimable")] })],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("keeps upcoming campaigns visible but does not select them for farming", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("future", {
        status: "upcoming",
        eligibility: "upcoming",
        startsAt: "2999-01-01T00:00:00.000Z",
        rewards: [{
          ...reward("locked"),
          availableFrom: "2999-01-01T00:00:00.000Z",
          availableUntil: "2999-01-02T00:00:00.000Z",
        }],
      })],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision).toMatchObject({
      action: "idle",
      reason: "only upcoming campaigns are available and no fallback streamers",
    });
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("prefers ACL candidates over general category streams", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [
          channel("general", { isAclMatch: false, viewerCount: 5000 }),
          channel("allowed", { isAclMatch: true, viewerCount: 1 }),
        ]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.channel?.username).toBe("allowed");
  });

  it("skips offline and category-mismatched campaign candidates before watching", async () => {
    const offline = channel("offline", { isAclMatch: true });
    const wrongGame = channel("wrong-game", { isAclMatch: true });
    const valid = channel("valid", { isAclMatch: false });
    const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({
      live: candidate.username !== "offline",
      categoryMatches: candidate.username !== "wrong-game",
      candidate,
    }));

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [offline, wrongGame, valid]),
        checkChannel,
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel?.username).toBe("valid");
    expect(checkChannel).toHaveBeenCalledTimes(3);
  });

  it("starts fallback streamer mode when campaigns are empty", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, fallbackStreamers: ["fallback"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel?.url).toBe("https://kick.com/fallback");
  });

  it("keeps live-check metadata on fallback streamer decisions", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, fallbackStreamers: ["fallback"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({
          live: true,
          categoryMatches: true,
          candidate: {
            ...candidate,
            displayName: "Fallback",
            categoryName: "Game",
            viewerCount: 1234,
            title: "Live now",
          },
        })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel).toMatchObject({
      username: "fallback",
      displayName: "Fallback",
      categoryName: "Game",
      viewerCount: 1234,
      title: "Live now",
    });
  });

  it("tries later fallback streamers when earlier fallback channels are offline", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, fallbackStreamers: ["offline", "live"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({
          live: candidate.username === "live",
          categoryMatches: true,
          candidate,
        })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel?.username).toBe("live");
  });

});

describe("scheduler tick", () => {
  it("switches after offline retry threshold", async () => {
    const first = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({
      live: candidate.username !== "old",
      categoryMatches: true,
      candidate,
    }));

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: first, offlineChecks: 2, tabId: 7 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ offlineRetryLimit: 3, platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("new");
    expect(result.state.sessions.twitch.offlineChecks).toBe(0);
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "new", live: true }),
      expect.objectContaining({ tabId: 7 }),
      { muted: true, closeManagedTabs: true },
    );
    expect(twitch.readProgress).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ channel: first }));
  });

  it("switches on category mismatch", async () => {
    const old = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({
      live: true,
      categoryMatches: candidate.username !== "old",
      candidate,
    }));

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: old, offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("new");
  });

  it("switches to a higher-priority fallback streamer after the queue is reordered", async () => {
    const toonyx = channel("toonyx", { url: "https://www.twitch.tv/toonyx" });
    const twitch = adapter("twitch", [], []);
    // No campaigns -> fallback mode. Both fallbacks are live; "xqc" is now first.
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({ live: true, categoryMatches: true, candidate }));

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: toonyx, offlineChecks: 0, tabId: 7 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: ["xqc", "toonyx"] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("xqc");
  });

  it("keeps the current channel when the same campaign has another valid candidate", async () => {
    const old = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("old");
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "old" }),
      expect.objectContaining({ tabId: 7 }),
      { muted: true, closeManagedTabs: true },
    );
  });

  it("keeps playback telemetry for healthy watch tabs", async () => {
    const old = channel("old");
    const twitch = adapter("twitch", [campaign("drops")], [channel("new")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            playbackChecks: 2,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 1,
              playingVideoCount: 1,
              blockedPlaybackCount: 0,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.playbackChecks).toBe(0);
    expect(result.state.sessions.twitch.playback?.playingVideoCount).toBe(1);
  });

  it("refreshes viewer metadata while keeping the current watch tab", async () => {
    const old = channel("old", { viewerCount: 10, title: "Old title" });
    const twitch = adapter("twitch", [campaign("drops")], [channel("new")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({
      live: true,
      categoryMatches: true,
      candidate: {
        ...old,
        categoryName: "Updated game",
        viewerCount: 1234,
        title: "Updated title",
      },
    });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 1,
              playingVideoCount: 1,
              blockedPlaybackCount: 0,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel).toMatchObject({
      username: "old",
      categoryName: "Updated game",
      viewerCount: 1234,
      title: "Updated title",
    });
  });

  it("reloads the watch tab after repeated playback failures", async () => {
    const old = channel("old");
    const twitch = adapter("twitch", [campaign("drops")], [old]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            playbackChecks: 2,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 1,
              playingVideoCount: 0,
              blockedPlaybackCount: 1,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({
        offlineRetryLimit: 3,
        platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.message).toBe("watch tab playback did not become active");
    expect(result.state.sessions.twitch.playback).toBeUndefined();
    expect(result.state.sessions.twitch.playbackChecks).toBe(3);
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "old" }),
      expect.objectContaining({ tabId: 7 }),
      { muted: true, closeManagedTabs: true },
    );
    expect(result.state.events.some((event) => event.message === "watch tab playback did not become active")).toBe(true);
  });

  it("switches from a campaign watch tab to fallback when the campaign becomes ineligible", async () => {
    const old = channel("old");
    const fallback = channel("fallback", { platform: "twitch", url: "https://www.twitch.tv/fallback" });
    const twitch = adapter("twitch", [campaign("done", { status: "completed" })], []);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: fallback });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "done",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: ["fallback"] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.campaignId).toBeUndefined();
    expect(result.state.sessions.twitch.channel?.username).toBe("fallback");
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "fallback" }),
      expect.objectContaining({ tabId: 7 }),
      { muted: true, closeManagedTabs: true },
    );
  });

  it("claims ready rewards before watching", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).toHaveBeenCalledWith(ready, ready.rewards[0]);
  });

  it("passes mute-tab setting to prepared watch tabs", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);

    await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({
        muteFarmingTabs: false,
        platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "allowed" }),
      expect.any(Object),
      { muted: false, closeManagedTabs: true },
    );
  });

  it("does not claim rewards after their claim window has expired", async () => {
    const ready = campaign("drops", { rewards: [{ ...reward("claimable"), claimUntil: "2020-01-01T00:00:00.000Z" }] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).not.toHaveBeenCalled();
  });

  it("does not open a watch tab for claimable-only campaigns when auto-claim is disabled", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({
        autoClaim: false,
        platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
  });

  it("opens no watch tab when automation is enabled without eligible campaigns or live fallback", async () => {
    const twitch = adapter("twitch", [], []);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
    expect(result.state.managedWatchTabs?.twitch).toBeUndefined();
  });

  it("opens exactly one managed watch tab when only one platform has an eligible target", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const kick = adapter("kick", [], []);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: true, fallbackStreamers: [] } } }),
      { twitch, kick },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(Object.keys(result.state.managedWatchTabs ?? {})).toEqual(["twitch"]);
  });

  it("opens one managed watch tab per platform when both platforms have eligible targets", async () => {
    const twitch = adapter("twitch", [campaign("twitch-drops")], [channel("twitch-allowed")]);
    const kickCandidate = { ...channel("kick-allowed"), platform: "kick" as const, url: "https://kick.com/kick-allowed" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);
    vi.mocked(kick.prepareWatchTab).mockResolvedValue({ tabId: 84, managedByExtension: true });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: true, fallbackStreamers: [] } } }),
      { twitch, kick },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(kick.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.managedWatchTabs).toMatchObject({
      twitch: { platform: "twitch", tabId: 42 },
      kick: { platform: "kick", tabId: 84 },
    });
  });

  it("only evaluates requested platforms during a targeted tick", async () => {
    const twitch = adapter("twitch", [campaign("twitch-drops")], [channel("twitch-allowed")]);
    const kickCandidate = { ...channel("kick-allowed"), platform: "kick" as const, url: "https://kick.com/kick-allowed" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);
    vi.mocked(kick.prepareWatchTab).mockResolvedValue({ tabId: 84, managedByExtension: true });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("current"), offlineChecks: 0, tabId: 42, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [campaign("existing")], kick: [] },
        managedWatchTabs: {
          twitch: { platform: "twitch", tabId: 42, channelUrl: "https://www.twitch.tv/current", ownedByExtension: true },
        },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: true, fallbackStreamers: [] } } }),
      { twitch, kick },
      { platforms: ["kick"] },
    );

    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(result.state.campaigns.twitch).toEqual([campaign("existing")]);
    expect(kick.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.sessions.kick.status).toBe("watching");
  });

  it("passes the existing managed tab into repeated ticks instead of creating an untracked tab", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const initialState = {
      sessions: {
        twitch: { platform: "twitch" as const, status: "idle" as const, offlineChecks: 0 },
        kick: { platform: "kick" as const, status: "idle" as const, offlineChecks: 0 },
      },
      campaigns: { twitch: [], kick: [] },
      events: [],
    };
    const tickSettings = settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } });

    const first = await runSchedulerTick(initialState, tickSettings, { twitch, kick: adapter("kick", [], []) });
    await runSchedulerTick(first.state, tickSettings, { twitch, kick: adapter("kick", [], []) });

    expect(twitch.prepareWatchTab).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ username: "allowed" }),
      expect.objectContaining({ tabId: 42 }),
      expect.objectContaining({
        managedTab: expect.objectContaining({ platform: "twitch", tabId: 42 }),
      }),
    );
  });

  it("stops the previous watch tab when automation is disabled", async () => {
    const twitch = adapter("twitch", [], []);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("old"), offlineChecks: 0, tabId: 7, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ running: false }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, tabManagedByExtension: true }), { closeManagedTabs: true });
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
    expect(result.state.sessions.twitch.channel).toBeUndefined();
  });

  it("stops the previous watch tab when no eligible campaigns or fallback remain", async () => {
    const twitch = adapter("twitch", [], []);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("old"), offlineChecks: 0, tabId: 7, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), { closeManagedTabs: true });
    expect(result.state.sessions.twitch.status).toBe("idle");
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
  });

  it("marks claimed rewards and emits scheduler events", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
    expect(result.state.events.some((event) => event.message.includes("Claimed Reward"))).toBe(true);
  });

  it("isolates adapter failures per platform", async () => {
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch unavailable"));
    const kickCandidate = { ...channel("kicklive"), platform: "kick" as const, url: "https://kick.com/kicklive" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings(),
      { twitch, kick },
    );

    expect(result.state.sessions.twitch.status).toBe("error");
    expect(result.state.sessions.twitch.errorChecks).toBe(1);
    expect(result.state.sessions.twitch.retryAfter).toBeDefined();
    expect(result.state.sessions.kick.status).toBe("watching");
    expect(result.state.events.some((event) => event.platform === "twitch" && event.level === "error")).toBe(true);
  });

  it("uses Permawatch fallback when drop discovery fails and fallback streamers exist", async () => {
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch drops unavailable"));
    vi.mocked(twitch.checkChannel).mockResolvedValue({
      live: true,
      categoryMatches: true,
      candidate: channel("fallback"),
    });

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: ["fallback"] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.readProgress).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "fallback", live: true }),
      expect.any(Object),
      { muted: true, closeManagedTabs: true },
    );
    expect(result.state.sessions.twitch).toMatchObject({
      status: "watching",
      channel: expect.objectContaining({ username: "fallback" }),
      errorChecks: 0,
      retryAfter: undefined,
    });
    expect(result.state.events.some((event) => event.level === "warn" && event.message.includes("checking Permawatch fallback"))).toBe(true);
  });

  it("backs off failed platforms until their retry time", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const retryAfter = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "error",
            offlineChecks: 0,
            errorChecks: 2,
            retryAfter,
            message: "Twitch unavailable",
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.retryAfter).toBe(retryAfter);
    expect(result.state.events.some((event) => event.message.includes("waiting until"))).toBe(true);
  });

  it("clears platform backoff after a successful retry", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: {
            platform: "twitch",
            status: "error",
            offlineChecks: 0,
            errorChecks: 2,
            retryAfter: "2020-01-01T00:00:00.000Z",
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.discoverCampaigns).toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(result.state.sessions.twitch.errorChecks).toBe(0);
    expect(result.state.sessions.twitch.retryAfter).toBeUndefined();
  });

  it("claims channel points for active watch sessions when supported", async () => {
    const twitch = {
      ...adapter("twitch", [campaign("drops")], [channel("allowed")]),
      claimChannelPoints: vi.fn(async () => true),
    };

    const result = await runSchedulerTick(
      {
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        events: [],
      },
      settings({ platform: { twitch: { enabled: true, fallbackStreamers: [] }, kick: { enabled: false, fallbackStreamers: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimChannelPoints).toHaveBeenCalledWith(expect.objectContaining({ username: "allowed" }));
    expect(result.state.events.some((event) => event.message.includes("Claimed channel points"))).toBe(true);
  });
});
