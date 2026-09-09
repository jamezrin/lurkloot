import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDiscoverySnapshot } from "@lurkloot/core/discoverySnapshot";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";

const NOW = Date.parse("2026-09-09T10:00:00Z");
const reward: DropReward = { id: "reward", name: "Reward", requiredMinutes: 60, watchedMinutes: 0, status: "locked", requirement: "watch", isWatchBased: true };
function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return { id: "campaign", platform: "kick", name: "Campaign", status: "active", categoryId: "13", rewards: [{ ...reward }], ...overrides };
}
function candidate(username = "streamer", overrides: Partial<ChannelCandidate> = {}): ChannelCandidate {
  return { platform: "kick", username, url: `https://kick.com/${username}`, ...overrides };
}
afterEach(() => vi.useRealTimers());

describe("Kick static discovery gate", () => {
  const cases: Array<[string, Partial<DropCampaign>, (settings: ExtensionSettings) => void]> = [
    ["completed", { status: "completed" }, () => {}],
    ["expired", { endsAt: "2026-09-09T09:59:00Z" }, () => {}],
    ["upcoming", { status: "upcoming" }, () => {}],
    ["excluded", {}, (settings) => { settings.excludedCampaignIds = ["campaign"]; }],
    ["infeasible", { endsAt: "2026-09-09T10:30:00Z" }, () => {}],
    ["unlinked disabled", { accountLinked: false }, (settings) => { settings.farmingEligibility.farmUnlinkedCampaigns = false; }],
    ["subscription disabled", { rewards: [{ ...reward, requirement: "subscribe", requiredSubs: 1, isWatchBased: false }] }, (settings) => { settings.farmingEligibility.farmSubscriptionCampaigns = false; }],
    ["category excluded", {}, (settings) => { settings.platform.kick.categoryMode = "exclude"; settings.platform.kick.categories = [{ id: "13", name: "Rust" }]; }],
    ["priority not selected", {}, (settings) => { settings.priorityMode = "priority_list_only"; }],
    ["no rewards", { rewards: [] }, () => {}],
    ["claimed", { rewards: [{ ...reward, status: "claimed" }] }, () => {}],
    ["prerequisites unmet", { rewards: [{ ...reward, preconditionsMet: false }] }, () => {}],
    ["reward not started", { rewards: [{ ...reward, availableFrom: "2026-09-09T11:00:00Z" }] }, () => {}],
    ["reward window ended", { rewards: [{ ...reward, availableUntil: "2026-09-09T09:00:00Z" }] }, () => {}],
  ];
  it.each(cases)("keeps %s inventory without channel enumeration", async (_name, overrides, configure) => {
    const settings = mergeSettings(undefined);
    configure(settings);
    const source = campaign(overrides);
    const listCandidateChannels = vi.fn(async () => [candidate()]);
    const checkChannel = vi.fn(async (channel: ChannelCandidate) => ({ candidate: channel, live: true, categoryMatches: true }));
    const result = await collectDiscoverySnapshot({ platform: "kick", refreshCampaigns: async () => [source], listCandidateChannels, checkChannel },
      undefined, new AbortController().signal, () => NOW, false, [], undefined, settings);
    expect(result.campaigns).toEqual([{ campaign: source, candidates: [] }]);
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(checkChannel).not.toHaveBeenCalled();
    expect(result.metrics.skippedBeforeChannelWork).toBe(1);
  });

  it.each([
    ["ordinary", {}],
    ["unlinked allowed", { accountLinked: false }],
    ["claimable", { rewards: [{ ...reward, status: "claimable", watchedMinutes: 60 }] }],
    ["uncertain campaign eligibility", { eligibility: "waiting_for_subscription" }],
  ] as Array<[string, Partial<DropCampaign>]>)("still checks %s campaigns", async (_name, overrides) => {
    const source = campaign(overrides);
    const result = await collectDiscoverySnapshot({ platform: "kick", refreshCampaigns: async () => [source], listCandidateChannels: async () => [candidate()],
      checkChannel: async (channel) => ({ candidate: channel, live: true, categoryMatches: true }) },
    undefined, new AbortController().signal, () => NOW, false, [], undefined, mergeSettings(undefined));
    expect(result.campaigns[0]?.candidates).toHaveLength(1);
    expect(result.metrics.skippedBeforeChannelWork).toBe(0);
  });
});
