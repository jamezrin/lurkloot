import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialAvailability } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import type { ChannelCandidate, ChannelCheck, DropCampaign, EngineSettings, Platform, PlatformAuthHealth, SchedulerState } from "@lurkloot/shared/models";
import type { PlatformAdapter, PreparedWatchTab } from "@lurkloot/core/adapter";
import type { EventEmitter } from "@lurkloot/shared/events";
import { createTransport } from "../src/transport";
import type { TransportHandle } from "../src/transport";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { runLoop } from "../src/runtime/run";
import { createLogger } from "../src/logger";
import { runCliBaselineCell } from "./helpers/tickBaseline";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { saveState } from "../src/storage";

function reportBaseline(result: unknown): void {
  if (process.env.LURKLOOT_TICK_BASELINE === "1") {
    console.log(`TICK_BASELINE ${JSON.stringify(result)}`);
  }
}

// A benign adapter whose only interesting behaviour is checkAuthHealth. Every
// data method returns an empty result so an unhealthy (suspended) tick never
// throws while we assert on the persisted auth health.
function fakeAdapter(platform: Platform, health: PlatformAuthHealth): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => health,
    refreshCampaigns: async () => [],
    listCandidateChannels: async () => [],
    checkChannel: async (candidate: ChannelCandidate): Promise<ChannelCheck> => ({ live: false, categoryMatches: false, candidate }),
    claimReward: async () => false,
    prepareWatchTab: async (): Promise<PreparedWatchTab> => ({ tabId: 0, managedByExtension: false }),
    stopWatchTab: async () => {},
  };
}

// Reuses a real HTTP transport purely for its resolved compatibility (a
// synchronous construction, no network), then swaps in fake adapters so ticks
// stay deterministic and offline.
async function fakeTransport(health: Record<Platform, PlatformAuthHealth>): Promise<TransportHandle> {
  const real = await createTransport("http", {}, "/tmp/lurkloot-run-compat", { twitch: true, kick: true });
  const build = (_emit: EventEmitter, settings: EngineSettings) => {
    const { compatibility, warnings } = real.createAdapters(() => {}, settings);
    return {
      adapters: {
        twitch: fakeAdapter("twitch", health.twitch),
        kick: fakeAdapter("kick", health.kick),
      } as Record<Platform, PlatformAdapter>,
      compatibility,
      warnings,
    };
  };
  const buildOne = (platform: Platform, emit: EventEmitter, settings: EngineSettings) => {
    const { adapters, ...resolution } = build(emit, settings);
    return { adapter: adapters[platform], ...resolution };
  };
  const initial = build(() => {}, DEFAULT_CLI_SETTINGS as unknown as EngineSettings);
  return {
    adapters: initial.adapters,
    createAdapter: buildOne,
    createAdapters: build,
    dispose: async () => { await real.dispose(); },
  };
}

const HEALTHY: PlatformAuthHealth = { status: "healthy", message: { key: "authHealthy" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function readAuthHealth(statePath: string): Promise<SchedulerState["authHealth"]> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
  return state.authHealth;
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lurkloot-run-")); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function runOnce(health: Record<Platform, PlatformAuthHealth>, availability: (platform: Platform) => CredentialAvailability): Promise<string> {
  const statePath = join(dir, "state.json");
  await runLoop({
    settings: DEFAULT_CLI_SETTINGS,
    statePath,
    transport: await fakeTransport(health),
    logger: createLogger("error"),
    once: true,
    checkCredentialAvailability: async (platform) => availability(platform),
  });
  return statePath;
}

describe("runLoop authentication health reporting", () => {
  it("records missing credentials without invoking the live probe", async () => {
    // If the probe ran it would report the adapter's healthy status; the missing
    // gate must win, proving credential availability precedes the probe.
    const statePath = await runOnce(
      { twitch: HEALTHY, kick: HEALTHY },
      (platform) => (platform === "twitch" ? { status: "missing" } : { status: "available" }),
    );
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.twitch).toMatchObject({ status: "missing_credentials", reasonCode: "credentials_missing" });
    expect(authHealth.kick.status).toBe("healthy");
  });

  it("reports rejected credentials from the live probe when a credential is available", async () => {
    const rejected: PlatformAuthHealth = { status: "invalid_credentials", reasonCode: "credentials_rejected", message: { key: "authInvalidCredentials" } };
    const statePath = await runOnce({ twitch: rejected, kick: HEALTHY }, () => ({ status: "available" }));
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.twitch).toMatchObject({ status: "invalid_credentials", reasonCode: "credentials_rejected" });
  });

  it("reports a transient probe failure as unavailable", async () => {
    const transient: PlatformAuthHealth = { status: "unavailable", reasonCode: "network_unavailable", message: { key: "authNetworkUnavailable" } };
    const statePath = await runOnce({ twitch: HEALTHY, kick: transient }, () => ({ status: "available" }));
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.kick).toMatchObject({ status: "unavailable", reasonCode: "network_unavailable" });
  });

  it("surfaces an unavailable credential lookup ahead of the probe", async () => {
    const statePath = await runOnce(
      { twitch: HEALTHY, kick: HEALTHY },
      (platform) => (platform === "kick" ? { status: "unavailable" } : { status: "available" }),
    );
    const authHealth = await readAuthHealth(statePath);
    expect(authHealth.kick).toMatchObject({ status: "unavailable", reasonCode: "credential_lookup_failed" });
  });
});

describe("CLI scheduler tick baseline", () => {
  it.each(["twitch", "kick"] as const)("measures an idle %s one-shot tick", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const result = await runCliBaselineCell(dir, platform, "idle");
    reportBaseline(result);

    expect(result).toEqual({
      host: "cli",
      platform,
      scenario: "idle",
      counts: {
        adapterOperations: 2,
        campaignDiscovery: 1,
        candidateListings: 0,
        channelChecks: 0,
        adapterConstructions: 2,
        watcherReconciliations: 0,
      },
      durationsMs: {
        discovery: 30,
        selection: 0,
        watcher: 0,
        persistence: 0,
        total: 30,
      },
    });
  });

  it.each(["twitch", "kick"] as const)("matches retained %s core work with the extension host", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "stable");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      adapterOperations: 3,
      campaignDiscovery: 1,
      candidateListings: 0,
      channelChecks: 1,
      adapterConstructions: 2,
      watcherReconciliations: 1,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 10,
      watcher: 5,
      persistence: 0,
      total: 45,
    });
  });

  it.each(["twitch", "kick"] as const)("attributes slow %s work with the same controlled clock", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "slow");
    reportBaseline(result);

    expect(result.durationsMs).toEqual({
      discovery: 300,
      selection: 200,
      watcher: 5,
      persistence: 0,
      total: 505,
    });
  });

  it.each([
    ["twitch", "switch"],
    ["kick", "switch"],
    ["twitch", "higherPriorityUnavailable"],
    ["kick", "higherPriorityUnavailable"],
  ] as const)("measures %s/%s selection work", async (platform, scenario) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, scenario);
    reportBaseline(result);

    expect(result.outcomeCampaignId).toBe(`${platform}-campaign`);

    expect(result.counts).toMatchObject({
      adapterOperations: scenario === "higherPriorityUnavailable" ? 7 : 4,
      campaignDiscovery: 1,
      candidateListings: scenario === "higherPriorityUnavailable" ? 2 : 1,
      channelChecks: scenario === "higherPriorityUnavailable" ? 3 : 1,
      adapterConstructions: 2,
      watcherReconciliations: 1,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: scenario === "higherPriorityUnavailable" ? 50 : 20,
      watcher: 5,
      persistence: 0,
      total: scenario === "higherPriorityUnavailable" ? 85 : 55,
    });
  });

  it.each(["twitch", "kick"] as const)("measures a failed %s response", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");

    const result = await runCliBaselineCell(dir, platform, "failed");
    reportBaseline(result);

    expect(result.counts).toMatchObject({
      adapterOperations: 2,
      campaignDiscovery: 1,
      candidateListings: 0,
      channelChecks: 0,
    });
    expect(result.durationsMs).toEqual({
      discovery: 30,
      selection: 0,
      watcher: 0,
      persistence: 0,
      total: 30,
    });
  });
});

describe("runLoop disabled platform cleanup", () => {
  it("clears a persisted watch when its platform was disabled between runs", async () => {
    const statePath = join(dir, "state.json");
    await saveState(statePath, {
      ...structuredClone(DEFAULT_STATE),
      campaigns: {
        ...DEFAULT_STATE.campaigns,
        kick: [{
          id: "stale-kick-campaign",
          platform: "kick",
          name: "Stale Kick campaign",
          status: "active",
          rewards: [{
            id: "stale-kick-reward",
            name: "Stale reward",
            requiredMinutes: 60,
            watchedMinutes: 10,
            status: "in_progress",
          }],
        }],
      },
      sessions: {
        ...DEFAULT_STATE.sessions,
        kick: {
          platform: "kick",
          status: "watching",
          offlineChecks: 0,
          campaignId: "stale-kick-campaign",
          rewardId: "stale-kick-reward",
          channel: { platform: "kick", username: "stale", url: "https://kick.com/stale" },
          watchMode: "tabless",
        },
      },
    });
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      platform: {
        twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
      },
    };

    await runLoop({
      settings,
      statePath,
      transport: await fakeTransport({ twitch: HEALTHY, kick: HEALTHY }),
      logger: createLogger("error"),
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
    expect(state.campaigns.kick).toEqual([]);
    expect(state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "platform_disabled",
    });
    expect(state.sessions.kick.channel).toBeUndefined();
  });
});

describe("runLoop interval baseline", () => {
  it("serializes provider work but queues each elapsed interval", async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred<DropCampaign[]>();
    let refreshCalls = 0;
    const twitch = fakeAdapter("twitch", HEALTHY);
    twitch.refreshCampaigns = vi.fn(async () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? [] : pendingRefresh.promise;
    });
    const kick = fakeAdapter("kick", HEALTHY);
    const transport: TransportHandle = {
      adapters: { twitch, kick },
      createAdapter: (platform) => ({
        adapter: platform === "twitch" ? twitch : kick,
        ...resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, { host: "cli", twitchIdentity: "web" }),
      }),
      createAdapters: () => ({
        adapters: { twitch, kick },
        ...resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, { host: "cli", twitchIdentity: "web" }),
      }),
      dispose: vi.fn(async () => undefined),
    };
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      pollIntervalMinutes: 1,
      platform: {
        twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
      },
    };

    const running = runLoop({
      settings,
      statePath: join(dir, "interval-state.json"),
      transport,
      logger: createLogger("error"),
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls).toBe(2);

    pendingRefresh.resolve([]);
    await vi.waitFor(() => expect(refreshCalls).toBe(3));
    process.emit("SIGTERM");
    await running;
  });
});
