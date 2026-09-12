import { describe, expect, it, vi } from "vitest";
import { runSchedulerTick } from "@lurkloot/core/scheduler";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
function fixture() {
  const state = structuredClone(DEFAULT_STATE), settings = structuredClone(DEFAULT_SETTINGS);
  state.authHealth.twitch = { status: "healthy" }; settings.platform.twitch.enabled = true;
  settings.tablessMode = false;
  const adapter: PlatformAdapter = { platform: "twitch", supportsTabless: true, checkAuthHealth: async () => ({ status: "healthy" }), refreshCampaigns: async () => [], listCandidateChannels: async () => [], checkChannel: async candidate => ({ live: true, categoryMatches: true, candidate }), claimReward: async () => true, prepareWatchTab: vi.fn(async () => ({ tabId: 1, managedByExtension: true })), stopWatchTab: vi.fn(async () => {}) };
  const target = { id: "nopixel", tablessOnly: true as const, channel: { platform: "twitch" as const, username: "buddha", url: "https://www.twitch.tv/buddha", channelId: "123", live: true } };
  return { state, settings, adapter, target, adapters: { twitch: adapter, kick: { ...adapter, platform: "kick" as const } } };
}
describe("supplemental watch lane", () => {
  it("farms an independent target without a tab or drop campaign and releases it", async () => {
    const s = fixture(); const selectSupplementalWatchTarget = vi.fn(async () => s.target);
    const first = await runSchedulerTick(s.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget });
    expect(first.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless", supplementalWatch: { id: "nopixel", tablessOnly: true }, channel: { channelId: "123" } });
    expect(first.state.sessions.twitch.campaignId).toBeUndefined(); expect(s.adapter.prepareWatchTab).not.toHaveBeenCalled();
    const second = await runSchedulerTick(first.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget: async () => undefined });
    expect(second.state.sessions.twitch.supplementalWatch).toBeUndefined();
  });
  it("does not invoke supplemental discovery while explicitly paused", async () => {
    const s = fixture(); s.state.manualClosePause = { twitch: { platform: "twitch", closedAt: new Date().toISOString() } };
    const selectSupplementalWatchTarget = vi.fn(async () => s.target);
    await runSchedulerTick(s.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget });
    expect(selectSupplementalWatchTarget).not.toHaveBeenCalled();
  });
  it("rejects excluded targets and isolates provider failures", async () => {
    const s = fixture(); s.settings.platform.twitch.excludedChannels = ["buddha"];
    const result = await runSchedulerTick(s.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget: async () => s.target });
    expect(result.state.sessions.twitch.status).toBe("idle");
    const failed = await runSchedulerTick(s.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget: async () => { throw new Error("private provider error"); } });
    expect(failed.state.authHealth.twitch.status).toBe("healthy");
    expect(JSON.stringify(failed.events)).not.toContain("private provider error");
  });
  it("does not turn an ambiguously retained supplemental session into a watch tab", async () => {
    const s = fixture();
    const first = await runSchedulerTick(s.state, s.settings, s.adapters, { platforms: ["twitch"], selectSupplementalWatchTarget: async () => s.target });
    first.state.sessions.twitch.lastHeartbeatOk = true;
    first.state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
    await runSchedulerTick(first.state, s.settings, s.adapters, { platforms: ["twitch"], discovery: { twitch: { campaigns: [], complete: false } }, selectSupplementalWatchTarget: async () => { throw new Error("private"); } });
    expect(s.adapter.prepareWatchTab).not.toHaveBeenCalled();
  });

});
