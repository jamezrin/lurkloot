import { describe, expect, it } from "vitest";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { EffectExecutor, driveEffects, perform } from "@lurkloot/core/effectExecutor";
import {
  decidePlatformTick,
  startSchedulerTick,
  type SchedulerEffect,
  type SchedulerEffectType,
  type SchedulerEffects,
  type SchedulerTickInput,
} from "@lurkloot/core/scheduler";
import { selectionAdapterFromDiscoverySnapshot, type DiscoverySnapshot } from "@lurkloot/core/discoverySnapshot";
import { createTickEffectExecutor } from "@lurkloot/core/background/tickEffects";
import { DEFAULT_STATE } from "../src/core/storage";

// The scheduler tick decides from plain inputs and names its side effects
// (#599). These tests drive it with canned effect results: no adapter, no port.

const reward = (id: string, patch: Partial<DropReward> = {}): DropReward => ({
  id,
  name: id,
  requiredMinutes: 60,
  watchedMinutes: 20,
  status: "in_progress",
  ...patch,
});

const campaign = (id: string, rewards: DropReward[]): DropCampaign => ({
  id,
  platform: "twitch",
  name: id,
  status: "active",
  rewards,
  endsAt: "2099-01-01T00:00:00.000Z",
});

const channel = (username: string): ChannelCandidate => ({
  platform: "twitch",
  username,
  displayName: username,
  url: `https://www.twitch.tv/${username}`,
  live: true,
});

function snapshot(campaigns: DropCampaign[], candidate: ChannelCandidate): DiscoverySnapshot {
  return {
    platform: "twitch",
    revision: 1,
    observedAt: Date.now(),
    complete: true,
    idleCandidates: [],
    followedChannels: [],
    metrics: { campaigns: campaigns.length, candidates: 1, cacheHits: 0, cacheMisses: 1, batchRequests: 1, singleFallbacks: 0 },
    campaigns: campaigns.map((entry) => ({
      campaign: entry,
      candidates: [{ candidate, live: true, categoryMatches: true, eligible: true as const, observedAt: Date.now() }],
    })),
  };
}

function settings(patch: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    tablessMode: false,
    ...patch,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, autoClaimChannelPoints: true },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
    },
  };
}

const state: SchedulerState = {
  ...DEFAULT_STATE,
  authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
};

function input(campaigns: DropCampaign[], candidate: ChannelCandidate, patch: Partial<SchedulerTickInput> = {}): SchedulerTickInput {
  const discovered = snapshot(campaigns, candidate);
  return {
    state,
    settings: settings(),
    platforms: ["twitch"],
    discovery: { twitch: { campaigns, complete: true } },
    selectionViews: { twitch: selectionAdapterFromDiscoverySnapshot(discovered, state.sessions.twitch) },
    capabilities: { twitch: { supportsTabless: true, claimChallenges: false, claimChannelPoints: true } },
    ...patch,
  };
}

type CannedResults = { [K in SchedulerEffectType]?: (effect: SchedulerEffects[K]["effect"]) => SchedulerEffects[K]["result"] };

// Runs the Twitch tick, answering each effect from `results`, and returns the
// effects in the order the tick named them.
async function decide(tickInput: SchedulerTickInput, results: CannedResults = {}) {
  const tick = startSchedulerTick(tickInput);
  const effects: SchedulerEffect[] = [];
  await driveEffects(decidePlatformTick(tick, "twitch", tickInput), async (effect) => {
    effects.push(effect);
    const answer = results[effect.type] as ((effect: SchedulerEffect) => unknown) | undefined;
    if (answer) return answer(effect);
    if (effect.type === "claimRewards") return { campaigns: effect.campaigns, events: [] };
    if (effect.type === "openWatchTab") return { tabId: 7, managedByExtension: true };
    if (effect.type === "releasePageContexts") return effect.contexts;
    if (effect.type === "claimChannelPoints") return false;
    return undefined;
  });
  return { tick, effects };
}

describe("effect executor", () => {
  type TestEffects = { ping: { effect: { type: "ping"; value: number }; result: number } };

  it("gives every effect type exactly one handler", async () => {
    const executor = new EffectExecutor<TestEffects, undefined>().register("ping", ({ value }) => value + 1);
    expect(() => executor.register("ping", ({ value }) => value)).toThrow('Effect "ping" already has a handler');
    await expect(executor.run({ type: "ping", value: 1 }, undefined)).resolves.toBe(2);
  });

  it("rejects an effect nobody handles", async () => {
    const executor = new EffectExecutor<TestEffects, undefined>();
    await expect(executor.run({ type: "ping", value: 1 }, undefined)).rejects.toThrow('Effect "ping" has no handler');
  });

  it("resumes the deciding code with the handler's result, or throws its error at the yield", async () => {
    async function* decideTwice() {
      const first = yield* perform<TestEffects, "ping">({ type: "ping", value: 1 });
      try {
        yield* perform<TestEffects, "ping">({ type: "ping", value: -1 });
        return "unreachable";
      } catch (error) {
        return `${first} then ${(error as Error).message}`;
      }
    }
    const result = await driveEffects(decideTwice(), async (effect) => {
      if (effect.value < 0) throw new Error("refused");
      return effect.value * 10;
    });
    expect(result).toBe("10 then refused");
  });

  it("starts no effect once the signal aborts, and still closes the deciding code", async () => {
    const abort = new AbortController();
    const ran: number[] = [];
    let closed = false;
    async function* decideTwice() {
      try {
        yield* perform<TestEffects, "ping">({ type: "ping", value: 1 });
        yield* perform<TestEffects, "ping">({ type: "ping", value: 2 });
      } finally {
        closed = true;
      }
    }
    const driving = driveEffects(decideTwice(), async (effect) => {
      ran.push(effect.value);
      abort.abort(new Error("reset"));
      return 0;
    }, abort.signal);

    await expect(driving).rejects.toThrow("reset");
    expect(ran).toEqual([1]);
    expect(closed).toBe(true);
  });

  it("registers one interim handler for every scheduler effect type", () => {
    const executor = createTickEffectExecutor();
    const types: SchedulerEffectType[] = [
      "stopWatchTab", "releasePageContexts", "claimChallenges", "claimRewards",
      "selectSupplementalTarget", "openWatchTab", "claimChannelPoints",
    ];
    for (const type of types) expect(executor.has(type)).toBe(true);
    expect(() => executor.register("claimRewards", async ({ campaigns }) => ({ campaigns, events: [] }))).toThrow();
  });
});

describe("scheduler tick decisions from plain inputs", () => {
  it("claims, then opens the watch tab, then claims channel points", async () => {
    const drops = campaign("drops", [reward("first")]);
    const creator = channel("creator");
    const { tick, effects } = await decide(input([drops], creator));

    expect(effects.map((effect) => effect.type)).toEqual(["claimRewards", "openWatchTab", "claimChannelPoints"]);
    expect(effects[1]).toMatchObject({ type: "openWatchTab", channel: expect.objectContaining({ username: "creator" }) });
    expect(tick.state.sessions.twitch).toMatchObject({
      status: "watching",
      campaignId: "drops",
      rewardId: "first",
      watchMode: "tab",
      tabId: 7,
      tabManagedByExtension: true,
    });
    expect(tick.state.managedWatchTabs?.twitch).toMatchObject({ tabId: 7, ownedByExtension: true });
  });

  it("decides on the campaigns its claims produced", async () => {
    // The second reward needs the first claimed. The claim result satisfies
    // that, so this same tick selects the second reward.
    const first = reward("first", { status: "claimable", watchedMinutes: 60 });
    const second = reward("second", { watchedMinutes: 0, status: "locked", preconditionRewardIds: ["first"], preconditionsMet: false });
    const drops = campaign("drops", [first, second]);
    const { tick } = await decide(input([drops], channel("creator")), {
      claimRewards: ({ campaigns }) => ({
        campaigns: campaigns.map((entry) => ({
          ...entry,
          rewards: entry.rewards.map((candidate) => candidate.id === "first"
            ? { ...candidate, status: "claimed" as const }
            : { ...candidate, preconditionsMet: true }),
        })),
        events: [],
      }),
    });

    expect(tick.state.sessions.twitch).toMatchObject({ status: "watching", rewardId: "second" });
    expect(tick.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
  });

  it("closes the tab it just opened when the selection went stale meanwhile", async () => {
    const creator = channel("creator");
    const { tick, effects } = await decide(
      input([campaign("drops", [reward("first")])], creator, { selectionIsCurrent: { twitch: () => false } }),
    );

    // The selection is checked before any tab effect and is already stale.
    expect(effects.map((effect) => effect.type)).toEqual(["claimRewards"]);
    expect(tick.state.sessions.twitch.status).not.toBe("watching");

    let current = true;
    const late = await decide(
      input([campaign("drops", [reward("first")])], creator, { selectionIsCurrent: { twitch: () => current } }),
      { openWatchTab: () => {
        current = false;
        return { tabId: 9, managedByExtension: true };
      } },
    );
    expect(late.effects.map((effect) => effect.type)).toEqual(["claimRewards", "openWatchTab", "stopWatchTab"]);
    expect(late.effects[2]).toMatchObject({ session: { tabId: 9, tabManagedByExtension: true } });
    expect(late.tick.state.managedWatchTabs?.twitch).toBeUndefined();
  });

  it("stops the tab and releases the page context for a disabled platform", async () => {
    const tickInput = input([], channel("creator"), {
      settings: { ...settings(), platform: { ...settings().platform, twitch: { ...settings().platform.twitch, enabled: false } } },
    });
    const { tick, effects } = await decide(tickInput);

    expect(effects.map((effect) => effect.type)).toEqual(["stopWatchTab", "releasePageContexts"]);
    expect(effects[1]).toMatchObject({ reason: "automation_disabled" });
    expect(tick.state.sessions.twitch).toMatchObject({ status: "paused", reasonCode: "automation_disabled" });
  });

  it("turns an effect's error into the platform error session", async () => {
    const { tick } = await decide(input([campaign("drops", [reward("first")])], channel("creator")), {
      openWatchTab: () => {
        throw new Error("tab refused");
      },
    });

    expect(tick.state.sessions.twitch).toMatchObject({ status: "error", reasonCode: "platform_error", errorChecks: 1, message: "tab refused" });
  });
});
