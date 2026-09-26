import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { DropCampaign, SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { twitchAdapter } from "../helpers/adapters";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import {
  allDiagnostics,
  campaign,
  channel,
  deferred,
  farming,
  harness,
  reward,
  twitchCampaignDetails,
  twitchDashboard,
  twitchInventory,
  twitchOperation,
} from "../helpers/backgroundController";

// Discovery lanes and snapshot selection.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A settings save drops the snapshot and throws away the refresh in flight.
  // The tick used to decide as if nothing had been discovered, which handed
  // the watch to a lower source until the save's follow-up tick switched back.
  it("tells the scheduler when a settings save threw its discovery refresh away", async () => {
    const env = harness();
    const gate = deferred<void>();
    let calls = 0;
    vi.mocked(env.kick.refreshCampaigns).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return [campaign("kick")];
    });

    const tick = env.rawController.tick(["kick"]);
    await vi.waitFor(() => expect(calls).toBe(1));
    await env.rawController.handleMessage({ type: "saveSettings", settingsPatch: { platform: { kick: { excludedChannels: ["someone"] } } }, tickAfterSave: true, tickAfterSavePlatforms: ["kick"] });
    gate.resolve();
    await tick;

    const messages = allDiagnostics(env).filter((event) => event.platform === "kick").map((event) => event.message);
    expect(messages.find((message) => message.startsWith("Discovery refresh finished"))).toContain("discarded=stale_generation");
    expect(messages).toContain("Campaign decision: idle (Waiting for campaign discovery after a settings change)");
    expect(messages.some((message) => message.includes("No campaigns discovered"))).toBe(false);

    // The save's own follow-up tick refreshes again and decides.
    await env.rawController.settleBackgroundWork();
    expect(env.state.sessions.kick).toMatchObject({ status: "watching", campaignId: campaign("kick").id });
  });

  it("attributes Kick discovery duration, skipped inventory and unique channel checks", async () => {
    const env = harness();
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([
      campaign("kick"),
      { ...campaign("kick"), id: "expired", status: "expired" },
    ]);
    env.kick.checkChannels = async (requests) => ({
      checks: requests.map(({ channel: candidate }) => ({ candidate, live: true, categoryMatches: true })),
      uniqueChannelChecks: 1,
    });
    await env.controller.tick(["kick"]);
    const diagnostic = allDiagnostics(env).find((event) => event.platform === "kick" && event.message.startsWith("Discovery refresh finished"));
    expect(diagnostic?.message).toMatch(/finished in \d+ms/);
    expect(diagnostic?.message).toContain("campaigns=2");
    expect(diagnostic?.message).toContain("skipped before channel work=1");
    expect(diagnostic?.message).toContain("unique channel checks=1");
    expect(env.state.campaigns.kick).toHaveLength(2);
  });

  it("labels unavailable discovery counters after failure instead of reporting zero work", async () => {
    const env = harness();
    vi.mocked(env.kick.checkChannel).mockRejectedValue(new Error("channel unavailable"));
    await env.controller.tick(["kick"]);
    const diagnostic = allDiagnostics(env).find((event) => event.platform === "kick" && event.message.startsWith("Discovery refresh finished"));
    expect(env.kick.listCandidateChannels).toHaveBeenCalled();
    expect(diagnostic?.message).toContain("work metrics=unavailable");
    expect(diagnostic?.message).not.toContain("campaigns=0");
    expect(diagnostic?.message).not.toContain("candidates=0");
  });

  it("retains Twitch discovery when each controller tick constructs a fresh adapter", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    });
    let dashboardFails = false;
    let detailsFail = false;
    const discoveryState = new TwitchDiscoveryState();
    const fetcher: PageFetcher = {
      fetchJson: vi.fn(async (_url: string, init?: RequestInit): Promise<unknown> => {
        const operation = twitchOperation(init);
        if (operation === "CurrentUser") return { data: { currentUser: { id: "user-id" } } };
        if (operation === "Inventory") return twitchInventory();
        if (operation === "ViewerDropsDashboard") {
          if (dashboardFails) throw new Error("service unavailable");
          return twitchDashboard(["retained"]);
        }
        if (operation === "DropCampaignDetails") {
          if (detailsFail) throw new Error("service unavailable");
          return twitchCampaignDetails("retained");
        }
        if (operation === "DirectoryPage_Game") return { data: { game: { streams: { edges: [] } } } };
        throw new Error(`Unexpected Twitch operation ${operation}`);
      }) as PageFetcher["fetchJson"],
    };
    vi.mocked(env.deps.createAdapter).mockImplementation((_platform, emit, settings) => ({
      adapter: twitchAdapter(fetcher, undefined, undefined, { discoveryState }, emit),
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));

    await env.controller.tick();
    expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);

    dashboardFails = true;
    detailsFail = true;
    await env.controller.tick();

    // Each controller tick owns one adapter per requested platform. The disabled
    // Kick adapter is still needed by the combined scheduler reconciliation.
    expect(env.deps.createAdapter).toHaveBeenCalledTimes(4);
    expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["retained"]);
  });

  it("reconstructs a tick adapter when settings change before commit", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(discovery.promise);

    const ticking = env.controller.tick(["kick"]);
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    await env.deps.saveSettings({ ...env.settings, preferKnownChannels: !env.settings.preferKnownChannels });
    discovery.resolve([campaign("kick")]);
    await ticking;

    expect(env.deps.createAdapter).toHaveBeenCalledTimes(2);
    expect(env.deps.createAdapter.mock.calls[0]![2].preferKnownChannels)
      .not.toBe(env.deps.createAdapter.mock.calls[1]![2].preferKnownChannels);
  });

  it("skips redundant target evaluation when a new discovery revision is materially unchanged", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      rewards: [{ ...reward("in_progress"), isWatchBased: false }],
    }]);

    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["twitch"]);

    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: expect.stringMatching(/^Snapshot selection skipped \(trigger=unknown, revision=\d+, age=\d+ms, material=false\)$/),
    }));
  });

  it("coalesces concurrent snapshot selection requests to one pending evaluation", async () => {
    const selectionStarted = deferred<void>();
    const allowSelection = deferred<void>();
    let blockSelection = false;
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (...args) => {
        if (blockSelection) {
          selectionStarted.resolve();
          await allowSelection.promise;
        }
        return selectWatchTargetFromSnapshot(...args);
      },
    });
    await env.controller.tick(["twitch"]);
    const selectWatchTarget = env.deps.selectWatchTarget!;
    selectWatchTarget.mockClear();

    blockSelection = true;
    const first = env.controller.tick(["twitch"], "manual_tick");
    await selectionStarted.promise;
    const second = env.controller.tick(["twitch"], "manual_tick");
    const third = env.controller.tick(["twitch"], "manual_tick");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    allowSelection.resolve();
    await Promise.all([first, second, third]);

    expect(selectWatchTarget).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: "Coalesced scheduler triggers (count=2, reasons=manual_tick:2)",
    }));
  });

  it("passes persisted backoff state and bypasses it for explicit selection triggers", async () => {
    const inputs: Array<{ previousBackoff?: unknown; bypassBackoff?: boolean }> = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (input) => {
        inputs.push(input as typeof input & { previousBackoff?: unknown; bypassBackoff?: boolean });
        const result = await selectWatchTargetFromSnapshot(input);
        return {
          ...result,
          backoff: { campaignId: "higher", retryAt: "2099-01-01T00:00:00.000Z", fingerprint: "material" },
        };
      },
    });
    env.state.campaignSearchBackoffs = {
      twitch: { campaignId: "higher", retryAt: "2099-01-01T00:00:00.000Z", fingerprint: "material" },
    };

    await env.controller.tick(["twitch"], "alarm");
    await env.controller.tick(["twitch"], "manual_tick");

    expect(inputs[0]).toMatchObject({
      previousBackoff: { campaignId: "higher", fingerprint: "material" },
      bypassBackoff: false,
    });
    expect(inputs.at(-1)).toMatchObject({ bypassBackoff: true });
    expect(env.state.campaignSearchBackoffs?.twitch).toMatchObject({ campaignId: "higher" });
  });

  it("skips backed-off Twitch candidate discovery across controller restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-08T04:00:00.000Z");
    const higher = { ...campaign("twitch"), id: "higher" };
    const current = { ...campaign("twitch"), id: "current" };
    const currentChannel = channel("twitch");
    const configured = farming({ ...DEFAULT_SETTINGS, campaignPins: ["higher"] });
    const initialState: SchedulerState = {
      ...structuredClone(DEFAULT_STATE),
      campaigns: { ...DEFAULT_STATE.campaigns, twitch: [higher, current] },
      sessions: {
        ...DEFAULT_STATE.sessions,
        twitch: {
          platform: "twitch",
          status: "watching",
          channel: currentChannel,
          campaignId: current.id,
          rewardId: current.rewards[0]?.id,
          offlineChecks: 0,
          watchMode: "tab",
          playback: {
            platform: "twitch",
            videoCount: 1,
            playingVideoCount: 1,
            mutedVideoCount: 1,
            unmutedVideoCount: 0,
            blockedPlaybackCount: 0,
            documentHidden: false,
            checkedAt: new Date().toISOString(),
          },
        },
      },
    };
    const configure = (env: ReturnType<typeof harness>) => {
      env.twitch.refreshCampaigns = vi.fn(async () => [higher, current]);
      env.twitch.listCandidateChannels = vi.fn(async (selected) => [
        selected.id === current.id ? currentChannel : { ...currentChannel, username: "higher", url: "https://www.twitch.tv/higher" },
      ]);
      env.twitch.checkChannel = vi.fn(async (candidate, options) => ({
        live: true,
        categoryMatches: true,
        campaignMatches: options?.campaign?.id === higher.id ? false : true,
        candidate,
      }));
    };
    const first = harness(configured, { initialState });
    configure(first);
    await first.controller.tick(["twitch"], "alarm");
    expect(first.twitch.listCandidateChannels).toHaveBeenCalledTimes(2);
    expect(first.state.campaignSearchBackoffs?.twitch?.campaignId).toBe("higher");

    const restarted = harness(configured, { initialState: structuredClone(first.state) });
    configure(restarted);
    await restarted.controller.tick(["twitch"], "startup");

    expect(vi.mocked(restarted.twitch.listCandidateChannels).mock.calls.map(([item]) => item.id)).toEqual(["current"]);
    expect(restarted.twitch.listCandidateChannels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "current" }),
      expect.anything(),
    );
    expect(allDiagnostics(restarted)).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/^Skipped authoritative negative campaign search for higher \(\d+ms remaining\)$/),
    }));

    await restarted.controller.tick(["twitch"], "manual_tick");
    expect(vi.mocked(restarted.twitch.listCandidateChannels).mock.calls.map(([item]) => item.id)).toEqual([
      "current",
      "higher",
      "current",
    ]);
  });
});
