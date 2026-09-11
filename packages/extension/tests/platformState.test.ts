import { describe, expect, it } from "vitest";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { mergePlatformState, schedulerStateEquivalent } from "@lurkloot/core/background/platformState";

function state(label: string, lastTickAt: string): SchedulerState {
  const session = (platform: Platform) => ({
    platform,
    status: "idle" as const,
    offlineChecks: 0,
    message: `${label}-${platform}`,
  });
  return {
    sessions: {
      twitch: session("twitch"),
      kick: session("kick"),
    },
    authHealth: {
      twitch: { status: "healthy" },
      kick: { status: "healthy" },
    },
    campaigns: {
      twitch: [],
      kick: [],
    },
    managedWatchTabs: {
      twitch: {
        platform: "twitch",
        tabId: label === "source" ? 11 : 10,
        channelUrl: `https://www.twitch.tv/${label}`,
        ownedByExtension: true,
      },
      kick: {
        platform: "kick",
        tabId: label === "source" ? 21 : 20,
        channelUrl: `https://kick.com/${label}`,
        ownedByExtension: true,
      },
    },
    deadlineInfeasibleRewardIds: {
      twitch: [`${label}-twitch`],
      kick: [`${label}-kick`],
    },
    campaignSearchBackoffs: {
      twitch: { campaignId: `${label}-twitch`, retryAt: "2099-01-01T00:00:00.000Z", fingerprint: label },
      kick: { campaignId: `${label}-kick`, retryAt: "2099-01-01T00:00:00.000Z", fingerprint: label },
    },
    installedAt: `${label}-installed`,
    lastTickAt,
  };
}

describe("mergePlatformState", () => {
  it("replaces only the owned platform slice and preserves the newest tick time", () => {
    const destination = state("destination", "2026-07-29T12:00:00.000Z");
    const source = state("source", "2026-07-29T11:00:00.000Z");

    const merged = mergePlatformState(destination, source, "twitch");

    expect(merged.sessions.twitch).toEqual(source.sessions.twitch);
    expect(merged.sessions.kick).toEqual(destination.sessions.kick);
    expect(merged.managedWatchTabs?.twitch).toEqual(source.managedWatchTabs?.twitch);
    expect(merged.managedWatchTabs?.kick).toEqual(destination.managedWatchTabs?.kick);
    expect(merged.deadlineInfeasibleRewardIds?.twitch).toEqual(
      source.deadlineInfeasibleRewardIds?.twitch,
    );
    expect(merged.deadlineInfeasibleRewardIds?.kick).toEqual(
      destination.deadlineInfeasibleRewardIds?.kick,
    );
    expect(merged.campaignSearchBackoffs?.twitch).toEqual(source.campaignSearchBackoffs?.twitch);
    expect(merged.campaignSearchBackoffs?.kick).toEqual(destination.campaignSearchBackoffs?.kick);
    expect(merged.installedAt).toBe(destination.installedAt);
    expect(merged.lastTickAt).toBe("2026-07-29T12:00:00.000Z");
  });

  it("deletes absent optional entries only for the owned platform", () => {
    const destination = state("destination", "2026-07-29T11:00:00.000Z");
    const source = state("source", "2026-07-29T12:00:00.000Z");
    delete source.managedWatchTabs?.twitch;
    delete source.deadlineInfeasibleRewardIds?.twitch;

    const merged = mergePlatformState(destination, source, "twitch");

    expect(merged.managedWatchTabs?.twitch).toBeUndefined();
    expect(merged.managedWatchTabs?.kick).toEqual(destination.managedWatchTabs?.kick);
    expect(merged.deadlineInfeasibleRewardIds?.twitch).toBeUndefined();
    expect(merged.deadlineInfeasibleRewardIds?.kick).toEqual(
      destination.deadlineInfeasibleRewardIds?.kick,
    );
    expect(merged.lastTickAt).toBe("2026-07-29T12:00:00.000Z");
  });
});

describe("schedulerStateEquivalent", () => {
  it("ignores lastTickAt, which every tick restamps regardless of what it decided", () => {
    expect(schedulerStateEquivalent(
      state("same", "2026-07-29T12:00:00.000Z"),
      state("same", "2026-07-29T12:30:00.000Z"),
    )).toBe(true);
  });

  it("reports a difference in any field that is not lastTickAt", () => {
    expect(schedulerStateEquivalent(
      state("before", "2026-07-29T12:00:00.000Z"),
      state("after", "2026-07-29T12:00:00.000Z"),
    )).toBe(false);
  });

  it("treats an explicit undefined as equal to an absent key", () => {
    // The scheduler's disabled branch sets channel/campaignId/rewardId to
    // undefined explicitly, while a state round-tripped through storage simply
    // lacks those keys. Without this the guard would never fire.
    const stored = state("idle", "2026-07-29T12:00:00.000Z");
    const rebuilt = state("idle", "2026-07-29T12:00:00.000Z");
    rebuilt.sessions.twitch = {
      ...rebuilt.sessions.twitch,
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
    };
    expect(schedulerStateEquivalent(stored, rebuilt)).toBe(true);
  });

  it("does not treat a present value as equal to an absent key", () => {
    const stored = state("idle", "2026-07-29T12:00:00.000Z");
    const rebuilt = state("idle", "2026-07-29T12:00:00.000Z");
    rebuilt.sessions.twitch = { ...rebuilt.sessions.twitch, campaignId: "campaign-1" };
    expect(schedulerStateEquivalent(stored, rebuilt)).toBe(false);
  });

  it("compares nested arrays by position rather than by reference", () => {
    const left = state("idle", "2026-07-29T12:00:00.000Z");
    const right = state("idle", "2026-07-29T12:00:00.000Z");
    left.campaigns = { twitch: [], kick: [] };
    right.campaigns = { twitch: [], kick: [] };
    expect(schedulerStateEquivalent(left, right)).toBe(true);
    right.deadlineInfeasibleRewardIds = { twitch: ["reward-1"] };
    expect(schedulerStateEquivalent(left, right)).toBe(false);
  });
});
