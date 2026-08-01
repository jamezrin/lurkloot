import { describe, expect, it, vi } from "vitest";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { mergePlatformState } from "@lurkloot/core/background/platformState";
import { mergeSchedulerState } from "@lurkloot/core/defaults";

function discoverySnapshot(
  overrides: Record<string, unknown> = {},
  entryOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    userId: "user-id",
    entries: [{
      dropID: "campaign",
      campaign: { id: "campaign", name: "Campaign", timeBasedDrops: [] },
      freshUntil: "2026-08-01T12:05:00.000Z",
      retainedUntil: "2026-08-01T12:30:00.000Z",
      ...entryOverrides,
    }],
    ...overrides,
  };
}

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

  it("replaces Twitch discovery only with the Twitch platform slice", () => {
    const destination = state("destination", "2026-07-29T11:00:00.000Z") as SchedulerState & {
      twitchDiscovery?: unknown;
    };
    const source = state("source", "2026-07-29T12:00:00.000Z") as SchedulerState & {
      twitchDiscovery?: unknown;
    };
    destination.twitchDiscovery = discoverySnapshot({ userId: "destination-user" }) as unknown as SchedulerState["twitchDiscovery"];
    source.twitchDiscovery = discoverySnapshot({ userId: "source-user" }) as unknown as SchedulerState["twitchDiscovery"];

    expect((mergePlatformState(destination, source, "twitch") as SchedulerState & { twitchDiscovery?: unknown })
      .twitchDiscovery).toEqual(source.twitchDiscovery);
    expect((mergePlatformState(destination, source, "kick") as SchedulerState & { twitchDiscovery?: unknown })
      .twitchDiscovery).toEqual(destination.twitchDiscovery);
  });
});

describe("mergeSchedulerState Twitch discovery", () => {
  it("keeps a valid versioned fresh snapshot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-01T12:00:00.000Z");
      const snapshot = discoverySnapshot() as unknown as NonNullable<SchedulerState["twitchDiscovery"]>;

      const merged = mergeSchedulerState({ twitchDiscovery: snapshot });

      expect((merged as SchedulerState & { twitchDiscovery?: unknown }).twitchDiscovery).toEqual(snapshot);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["unknown version", discoverySnapshot({ version: 2 })],
    ["missing identity", discoverySnapshot({ userId: "" })],
    ["expired entry", discoverySnapshot({}, { freshUntil: "2026-08-01T12:00:00.000Z" })],
    ["mismatched campaign identity", discoverySnapshot({}, { campaign: { id: "other" } })],
    ["malformed campaign payload", discoverySnapshot({}, { campaign: { id: "campaign", name: "Campaign" } })],
    ["duplicate campaign identity", discoverySnapshot({
      entries: [
        (discoverySnapshot().entries as unknown[])[0],
        (discoverySnapshot().entries as unknown[])[0],
      ],
    })],
    ["oversized entry set", discoverySnapshot({
      entries: Array.from({ length: 129 }, (_, index) => ({
        dropID: `campaign-${index}`,
        campaign: { id: `campaign-${index}`, name: `Campaign ${index}`, timeBasedDrops: [] },
        freshUntil: "2026-08-01T12:05:00.000Z",
        retainedUntil: "2026-08-01T12:30:00.000Z",
      })),
    })],
  ])("discards a snapshot with %s", (_label, snapshot) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-08-01T12:00:00.000Z");

      const merged = mergeSchedulerState({ twitchDiscovery: snapshot } as unknown as Partial<SchedulerState>);

      expect((merged as SchedulerState & { twitchDiscovery?: unknown }).twitchDiscovery).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
