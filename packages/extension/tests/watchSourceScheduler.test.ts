import { describe, expect, it, vi } from "vitest";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import { runSchedulerTick } from "./helpers/schedulerTick";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { DropCampaign, Platform, SchedulerState, SupplementalWatchTarget } from "@lurkloot/shared/models";

function setup(platform: Platform = "twitch") {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.platform[platform].enabled = true;
  settings.platform[platform].idleWatchlistChannels = ["idlefirst", "idlesecond"];
  const state = structuredClone(DEFAULT_STATE);
  state.authHealth[platform] = { status: "healthy" };
  const channel = (username: string) => ({ platform, username, url: `${platform === "twitch" ? "https://www.twitch.tv" : "https://kick.com"}/${username}`, channelId: username, live: true, isAclMatch: true });
  const campaign: DropCampaign = { id: "drop", platform, name: "Drop", categoryId: "game", gameName: "Game", status: "active", startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), accountLinked: true, eligibility: "eligible", priority: 1, rewards: [{ id: "reward", name: "Reward", requiredMinutes: 60, watchedMinutes: 10, status: "in_progress" }] };
  const adapter: PlatformAdapter = { platform, supportsTabless: true, checkAuthHealth: async () => ({ status: "healthy" }), refreshCampaigns: async () => [campaign], listCandidateChannels: async () => [channel("dropper")], checkChannel: async candidate => ({ live: true, categoryMatches: true, candidate }), claimReward: async () => true, prepareWatchTab: vi.fn(async () => ({ tabId: 1, managedByExtension: true })), stopWatchTab: vi.fn(async () => {}) };
  const adapters = { twitch: { ...adapter, platform: "twitch" as const }, kick: { ...adapter, platform: "kick" as const }, [platform]: adapter };
  const target = (id: string): SupplementalWatchTarget => ({ id, tablessOnly: true, channel: channel(id) });
  const tick = (current = state, selector?: (platform: Platform, selectedState: SchedulerState, signal?: AbortSignal, source?: string) => Promise<SupplementalWatchTarget | undefined>) => runSchedulerTick(current, settings, adapters, { platforms: [platform], selectSupplementalWatchTarget: selector });
  return { settings, state, adapter, campaign, target, tick };
}

describe("watch-source scheduler policy", () => {
  it.each(["twitch", "kick"] as const)("selects Idle first on %s and preserves watchlist channel order", async platform => {
    const s = setup(platform);
    s.settings.platform[platform].watchSourcePriority = platform === "twitch" ? ["idle_watchlist", "drops", "nopixel", "fortnite"] : ["idle_watchlist", "drops"];
    const result = await s.tick();
    expect(result.state.sessions[platform]).toMatchObject({ status: "watching", channel: { username: "idlefirst" } });
    expect(result.state.sessions[platform].campaignId).toBeUndefined();
  });

  it.each(["nopixel", "fortnite"] as const)("selects %s ahead of eligible drops", async source => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = [source, "drops", source === "nopixel" ? "fortnite" : "nopixel", "idle_watchlist"];
    const result = await s.tick(s.state, async (_platform, _state, _signal, requested) => requested === source ? s.target(source) : undefined);
    expect(result.state.sessions.twitch).toMatchObject({ supplementalWatch: { id: source }, channel: { username: source }, watchMode: "tabless" });
    expect(result.state.sessions.twitch.campaignId).toBeUndefined();
  });

  it("skips an unavailable provider and routes each source independently", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["fortnite", "nopixel", "drops", "idle_watchlist"];
    const result = await s.tick(s.state, async (_platform, _state, _signal, source) => source === "nopixel" ? s.target("nopixel") : undefined);
    expect(result.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
  });

  it.each(["twitch", "kick"] as const)("applies active source reordering on %s without losing drop progress", async platform => {
    const s = setup(platform);
    const drops = await s.tick();
    expect(drops.state.sessions[platform].campaignId).toBe("drop");
    s.settings.platform[platform].watchSourcePriority = platform === "twitch" ? ["idle_watchlist", "drops", "nopixel", "fortnite"] : ["idle_watchlist", "drops"];
    const idle = await s.tick(drops.state);
    expect(idle.state.sessions[platform].channel?.username).toBe("idlefirst");
    s.settings.platform[platform].watchSourcePriority = platform === "twitch" ? ["drops", "nopixel", "fortnite", "idle_watchlist"] : ["drops", "idle_watchlist"];
    const resumed = await s.tick(idle.state);
    expect(resumed.state.sessions[platform].campaignId).toBe("drop");
    expect(resumed.state.campaigns[platform][0].rewards[0].watchedMinutes).toBe(10);
  });

  it("preempts a retained in-progress drop when a higher source becomes eligible", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["nopixel", "drops", "fortnite", "idle_watchlist"];
    const drops = await s.tick(s.state, async () => undefined);
    const next = await s.tick(drops.state, async (_platform, _state, _signal, source) => source === "nopixel" ? s.target("nopixel") : undefined);
    expect(next.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
  });

  it.each((["twitch", "kick"] as const).flatMap(platform => [
    // "replacement" ends sooner, so it ranks first and takes over.
    { platform, idleLive: false, explicitPriority: false, expectedCampaign: "replacement", expectedChannel: "replacement" },
    { platform, idleLive: false, explicitPriority: true, expectedCampaign: "replacement", expectedChannel: "replacement" },
    { platform, idleLive: true, explicitPriority: false, expectedCampaign: undefined, expectedChannel: "idlefirst" },
  ]))("preserves within-source retention with Idle-first snapshots on $platform (Idle live: $idleLive, explicit campaign priority: $explicitPriority)", async ({ platform, idleLive, explicitPriority, expectedCampaign, expectedChannel }) => {
    const s = setup(platform);
    const active = await s.tick();
    s.settings.platform[platform].watchSourcePriority = platform === "twitch" ? ["idle_watchlist", "drops", "nopixel", "fortnite"] : ["idle_watchlist", "drops"];
    const replacement: DropCampaign = {
      ...s.campaign,
      id: "replacement",
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      rewards: [{ ...s.campaign.rewards[0], id: "replacement-reward", requiredMinutes: 5, watchedMinutes: 0, status: "locked" }],
    };
    if (explicitPriority) s.settings.campaignPins = ["replacement"];
    const snapshot = {
      platform,
      revision: 1,
      observedAt: Date.now(),
      complete: true as const,
      campaigns: [s.campaign, replacement].map(campaign => ({
        campaign,
        candidates: [{ candidate: s.target(campaign.id === "drop" ? "dropper" : "replacement").channel, live: true, categoryMatches: true, eligible: true as const, observedAt: Date.now() }],
      })),
      idleCandidates: s.settings.platform[platform].idleWatchlistChannels.map(username => ({ candidate: s.target(username).channel, live: idleLive, categoryMatches: true, eligible: "unknown" as const, observedAt: Date.now() })),
      followedChannels: [],
      metrics: { campaigns: 2, candidates: 4, cacheHits: 0, cacheMisses: 4, batchRequests: 1, singleFallbacks: 0 },
    };
    const prepared = await selectWatchTargetFromSnapshot({ snapshot, previous: active.state.sessions[platform], previousCampaigns: active.state.campaigns[platform], settings: s.settings });
    expect(prepared.decision.campaign?.id).toBe(expectedCampaign);
    expect(prepared.decision.channel?.username).toBe(expectedChannel);
    s.adapter.refreshCampaigns = async () => [s.campaign, replacement];
    s.adapter.checkChannel = async candidate => ({ live: !candidate.username.startsWith("idle") || idleLive, categoryMatches: true, candidate });
    const result = await runSchedulerTick(active.state, s.settings, { twitch: { ...s.adapter, platform: "twitch" }, kick: { ...s.adapter, platform: "kick" }, [platform]: s.adapter }, { platforms: [platform], selections: { [platform]: prepared } });
    expect(result.state.sessions[platform].campaignId).toBe(expectedCampaign);
    expect(result.state.sessions[platform].channel?.username).toBe(expectedChannel);
    expect(result.state.campaigns[platform].find(campaign => campaign.id === "drop")?.rewards[0].watchedMinutes).toBe(10);
  });

  it("rejects an excluded or wrong-source provider and yields to drops", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["fortnite", "nopixel", "drops", "idle_watchlist"];
    const mismatch = await s.tick(s.state, async () => s.target("nopixel"));
    expect(mismatch.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
    s.settings.platform.twitch.excludedChannels = ["nopixel"];
    const excluded = await s.tick(s.state, async () => s.target("nopixel"));
    expect(excluded.state.sessions.twitch.campaignId).toBe("drop");
  });

  it("does not use a provider on a host without tabless support", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["fortnite", "drops", "nopixel", "idle_watchlist"];
    s.adapter.supportsTabless = false;
    const result = await s.tick(s.state, async () => s.target("fortnite"));
    expect(result.state.sessions.twitch.campaignId).toBe("drop");
  });

  it("isolates a failed higher-priority provider and continues with drops", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["fortnite", "drops", "nopixel", "idle_watchlist"];
    const result = await s.tick(s.state, async () => { throw new Error("private vendor body"); });
    expect(result.state.sessions.twitch.campaignId).toBe("drop");
    expect(JSON.stringify(result.events)).not.toContain("private vendor body");
  });

  it("keeps provider discovery available when drop discovery fails without a watchlist", async () => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = ["fortnite", "drops", "nopixel", "idle_watchlist"];
    s.settings.platform.twitch.idleWatchlistChannels = [];
    s.adapter.refreshCampaigns = async () => { throw new Error("Drop discovery unavailable"); };
    const result = await s.tick(s.state, async (_platform, _state, _signal, source) => source === "fortnite" ? s.target("fortnite") : undefined);
    expect(result.state.sessions.twitch.supplementalWatch?.id).toBe("fortnite");
  });

  it.each(["nopixel", "fortnite"] as const)("selects %s first without querying a failing lower Drops source", async source => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = [source, "drops", source === "nopixel" ? "fortnite" : "nopixel", "idle_watchlist"];
    s.adapter.listCandidateChannels = async () => { throw new Error("Lower source unavailable"); };
    const result = await s.tick(s.state, async (_platform, _state, _signal, requested) => requested === source ? s.target(source) : undefined);
    expect(result.state.sessions.twitch.supplementalWatch?.id).toBe(source);
    expect(result.state.sessions.twitch.status).toBe("watching");
  });

  it("yields a failing Drops source to a lower eligible provider", async () => {
    const s = setup();
    s.adapter.listCandidateChannels = async () => { throw new Error("Drops unavailable"); };
    const result = await s.tick(s.state, async (_platform, _state, _signal, source) => source === "nopixel" ? s.target("nopixel") : undefined);
    expect(result.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
  });

  it.each(["twitch", "kick"] as const)("yields a failing Idle-first source to eligible Drops on %s", async platform => {
    const s = setup(platform);
    s.settings.platform[platform].watchSourcePriority = platform === "twitch" ? ["idle_watchlist", "drops", "nopixel", "fortnite"] : ["idle_watchlist", "drops"];
    s.adapter.checkChannel = async candidate => {
      if (candidate.username.startsWith("idle")) throw new Error("Idle channel lookup unavailable");
      return { live: true, categoryMatches: true, candidate };
    };
    const result = await s.tick();
    expect(result.state.sessions[platform]).toMatchObject({ status: "watching", campaignId: "drop", channel: { username: "dropper" } });
  });

  it.each(["nopixel", "fortnite"] as const)("selects higher %s without probing a failing lower Idle source", async source => {
    const s = setup();
    s.settings.platform.twitch.watchSourcePriority = [source, "idle_watchlist", "drops", source === "nopixel" ? "fortnite" : "nopixel"];
    s.adapter.checkChannel = async () => { throw new Error("Lower channel health unavailable"); };
    const result = await s.tick(s.state, async (_platform, _state, _signal, requested) => requested === source ? s.target(source) : undefined);
    expect(result.state.sessions.twitch).toMatchObject({ status: "watching", supplementalWatch: { id: source } });
  });

  it.each(["twitch", "kick"] as const)("revalidates removed Idle channels during incomplete discovery on %s", async platform => {
    const s = setup(platform);
    s.adapter.refreshCampaigns = async () => [];
    const idle = await s.tick();
    idle.state.sessions[platform].lastHeartbeatOk = true;
    idle.state.sessions[platform].lastHeartbeatAt = new Date().toISOString();
    s.settings.platform[platform].idleWatchlistChannels = ["idlesecond"];
    const result = await runSchedulerTick(idle.state, s.settings, { twitch: { ...s.adapter, platform: "twitch" }, kick: { ...s.adapter, platform: "kick" }, [platform]: s.adapter }, { platforms: [platform], discovery: { [platform]: { campaigns: [], complete: false } } });
    expect(result.state.sessions[platform].channel?.username).toBe("idlesecond");
  });

  it.each(["twitch", "kick"] as const)("revalidates Idle channel order during incomplete discovery on %s", async platform => {
    const s = setup(platform);
    s.adapter.refreshCampaigns = async () => [];
    const idle = await s.tick();
    idle.state.sessions[platform].lastHeartbeatOk = true;
    idle.state.sessions[platform].lastHeartbeatAt = new Date().toISOString();
    s.settings.platform[platform].idleWatchlistChannels = ["idlesecond", "idlefirst"];
    const result = await runSchedulerTick(idle.state, s.settings, { twitch: { ...s.adapter, platform: "twitch" }, kick: { ...s.adapter, platform: "kick" }, [platform]: s.adapter }, { platforms: [platform], discovery: { [platform]: { campaigns: [], complete: false } } });
    expect(result.state.sessions[platform].channel?.username).toBe("idlesecond");
  });

  it.each(["twitch", "kick"] as const)("lets newly discovered higher Drops preempt healthy Idle during incomplete discovery on %s", async platform => {
    const s = setup(platform);
    s.adapter.refreshCampaigns = async () => [];
    const idle = await s.tick();
    idle.state.sessions[platform].lastHeartbeatOk = true;
    idle.state.sessions[platform].lastHeartbeatAt = new Date().toISOString();
    const result = await runSchedulerTick(idle.state, s.settings, { twitch: { ...s.adapter, platform: "twitch" }, kick: { ...s.adapter, platform: "kick" }, [platform]: s.adapter }, { platforms: [platform], discovery: { [platform]: { campaigns: [s.campaign], complete: false } } });
    expect(result.state.sessions[platform]).toMatchObject({ status: "watching", campaignId: "drop", channel: { username: "dropper" } });
  });

  it("applies Idle-first even when incomplete discovery would retain a healthy drop", async () => {
    const s = setup();
    const drops = await s.tick();
    drops.state.sessions.twitch.lastHeartbeatOk = true;
    drops.state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
    s.settings.platform.twitch.watchSourcePriority = ["idle_watchlist", "drops", "nopixel", "fortnite"];
    const result = await runSchedulerTick(drops.state, s.settings, { twitch: s.adapter, kick: { ...s.adapter, platform: "kick" } }, { platforms: ["twitch"], discovery: { twitch: { campaigns: [], complete: false } } });
    expect(result.state.sessions.twitch.channel?.username).toBe("idlefirst");
  });

  it.each(["channel", "campaign"] as const)("honors a new %s exclusion during incomplete discovery", async exclusion => {
    const s = setup();
    const drops = await s.tick();
    drops.state.sessions.twitch.lastHeartbeatOk = true;
    drops.state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
    if (exclusion === "channel") s.settings.platform.twitch.excludedChannels = ["dropper"];
    else s.settings.excludedCampaignIds = ["drop"];
    const result = await runSchedulerTick(drops.state, s.settings, { twitch: s.adapter, kick: { ...s.adapter, platform: "kick" } }, { platforms: ["twitch"], discovery: { twitch: { campaigns: [], complete: false } } });
    expect(result.state.sessions.twitch.campaignId).toBeUndefined();
    expect(result.state.sessions.twitch.channel?.username).toBe("idlefirst");
  });
});

// A settings save throws away the discovery refresh in flight. The tick that
// follows knows the campaigns but no channels, so Drops cannot be decided; a
// lower source used to take over and was undone by the next full refresh.
describe("watch-source policy while discovery was discarded", () => {
  function discardedTick(s: ReturnType<typeof setup>, current: SchedulerState, selector: (platform: Platform, selectedState: SchedulerState, signal?: AbortSignal, source?: string) => Promise<SupplementalWatchTarget | undefined>) {
    const adapter: PlatformAdapter = { ...s.adapter, listCandidateChannels: async () => [], checkChannel: async candidate => ({ live: false, categoryMatches: false, candidate }) };
    return runSchedulerTick(current, s.settings, { twitch: adapter, kick: { ...adapter, platform: "kick" } }, {
      platforms: ["twitch"],
      selectSupplementalWatchTarget: selector,
      discovery: { twitch: { campaigns: current.campaigns.twitch, complete: false, discarded: true } },
    });
  }
  const healthy = (state: SchedulerState): SchedulerState => ({
    ...state,
    sessions: { ...state.sessions, twitch: { ...state.sessions.twitch, lastHeartbeatOk: true, lastHeartbeatAt: new Date().toISOString() } },
  });
  const nopixelLive = (s: ReturnType<typeof setup>) => async (_platform: Platform, _state: SchedulerState, _signal?: AbortSignal, source?: string) =>
    source === "nopixel" ? s.target("nopixel") : undefined;

  it("keeps a healthy drop watch instead of starting a lower source", async () => {
    const s = setup();
    s.settings.platform.twitch.idleWatchlistChannels = [];
    const drops = await s.tick(s.state, async () => undefined);
    expect(drops.state.sessions.twitch.campaignId).toBe("drop");

    const next = await discardedTick(s, healthy(drops.state), nopixelLive(s));

    expect(next.state.sessions.twitch).toMatchObject({ status: "watching", campaignId: "drop" });
    expect(next.state.sessions.twitch.supplementalWatch).toBeUndefined();
  });

  it("waits rather than switching to a lower source when the save made the campaign ineligible", async () => {
    const s = setup();
    s.settings.platform.twitch.idleWatchlistChannels = [];
    const drops = await s.tick(s.state, async () => undefined);
    s.settings.excludedCampaignIds = ["drop"];

    const next = await discardedTick(s, healthy(drops.state), nopixelLive(s));

    expect(next.state.sessions.twitch.supplementalWatch).toBeUndefined();
    expect(next.state.sessions.twitch.campaignId).toBeUndefined();
    expect(next.events.map((event) => event.message)).toEqual(expect.arrayContaining([
      "Not keeping current watch while discovery is incomplete: its campaign is no longer eligible under the current settings",
    ]));
  });

  // Turning automation off mid-tick throws the refresh away too, often right
  // after a watch was armed and before its first heartbeat.
  it("keeps a drop watch that has not had its first heartbeat yet", async () => {
    const s = setup();
    s.settings.platform.twitch.idleWatchlistChannels = [];
    const drops = await s.tick(s.state, async () => undefined);
    expect(drops.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();

    const next = await discardedTick(s, drops.state, nopixelLive(s));

    expect(next.state.sessions.twitch).toMatchObject({ status: "watching", campaignId: "drop" });
    expect(next.state.sessions.twitch.supplementalWatch).toBeUndefined();
  });

  // Kick has no Twitch extensions; the source below Drops is the Idle
  // Watchlist, and a discarded refresh must not hand the watch to it either.
  it("keeps a Kick drop watch instead of starting the Idle Watchlist", async () => {
    const s = setup("kick");
    s.settings.platform.kick.watchSourcePriority = ["drops", "idle_watchlist"];
    // A campaign ranked above the current one, with no channel live for it:
    // the current watch is then not the top of the ranking, so keeping it
    // takes the discarded-discovery hold rather than the plain fast path.
    const sooner: DropCampaign = { ...s.campaign, id: "sooner", endsAt: new Date(Date.now() + 3_600_000).toISOString() };
    s.adapter.refreshCampaigns = async () => [s.campaign, sooner];
    const listAll = s.adapter.listCandidateChannels;
    s.adapter.listCandidateChannels = async (campaign, options) => campaign.id === "sooner" ? [] : listAll(campaign, options);
    const drops = await s.tick();
    expect(drops.state.sessions.kick.campaignId).toBe("drop");
    const adapter: PlatformAdapter = {
      ...s.adapter,
      listCandidateChannels: async () => [],
      // Only the watchlist channels are live, as they would be to a lower source.
      checkChannel: async (candidate) => ({ live: candidate.username.startsWith("idle"), categoryMatches: true, candidate }),
    };

    const next = await runSchedulerTick(drops.state, s.settings, { twitch: { ...adapter, platform: "twitch" }, kick: adapter }, {
      platforms: ["kick"],
      discovery: { kick: { campaigns: drops.state.campaigns.kick, complete: false, discarded: true } },
    });

    expect(next.state.sessions.kick).toMatchObject({ status: "watching", campaignId: "drop" });
  });

  it("keeps a supplemental watch it was already on", async () => {
    const s = setup();
    s.settings.platform.twitch.idleWatchlistChannels = [];
    s.settings.excludedCampaignIds = ["drop"];
    const nopixel = await s.tick(s.state, nopixelLive(s));
    expect(nopixel.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");

    const next = await discardedTick(s, healthy(nopixel.state), nopixelLive(s));

    expect(next.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
  });
});
