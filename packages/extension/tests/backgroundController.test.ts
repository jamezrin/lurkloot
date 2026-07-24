import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALARM_NAME, createBackgroundController, type CredentialAvailability } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import { applySettingsPatch, DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";
import type { PageFetcher, PlatformAdapter } from "@lurkloot/core/adapter";
import { KickAdapter, KickClaimState } from "@lurkloot/core/kick";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import type { StopPageContextTabs } from "@lurkloot/core/scheduler";
import { forgetManagedPageContextTabs, recordManagedPageContextFallback, registerManagedPageContextTabs } from "@lurkloot/core/tabs";

const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: 10,
  status,
});

const campaign = (platform: Platform, rewardStatus: DropReward["status"] = "in_progress"): DropCampaign => ({
  id: `${platform}-campaign`,
  platform,
  name: `${platform} campaign`,
  status: "active",
  rewards: [reward(rewardStatus)],
});

const channel = (platform: Platform): ChannelCandidate => ({
  platform,
  username: `${platform}-creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch-creator" : "https://kick.com/kick-creator",
});

function asSnapshot(value: unknown): RuntimeSnapshot {
  return value as RuntimeSnapshot;
}

function adapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    discoverCampaigns: vi.fn(async () => [campaign(platform)]),
    readProgress: vi.fn(async (campaigns) => campaigns),
    listCandidateChannels: vi.fn(async () => [channel(platform)]),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: platform === "twitch" ? 10 : 20, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

function harness(
  settings: ExtensionSettings = { ...DEFAULT_SETTINGS, running: true },
  overrides: {
    saveState?: (state: SchedulerState) => Promise<void>;
    reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
    stopPageContextTabs?: StopPageContextTabs;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;
  } = {},
) {
  let currentSettings = settings;
  let currentState: SchedulerState = {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
  const twitch = adapter("twitch");
  const kick = adapter("kick");
  const reportEvents = vi.fn<(events: readonly EngineEvent[]) => Promise<void>>(async () => undefined);
  const deps = {
    loadSettings: vi.fn(async () => currentSettings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      currentSettings = next;
    }),
    loadState: vi.fn(async () => currentState),
    saveState: vi.fn(overrides.saveState ?? (async (next: SchedulerState) => {
      currentState = next;
    })),
    createAlarm: vi.fn(async () => undefined),
    createNotification: vi.fn(async () => undefined),
    closeManagedTabs: vi.fn(async () => undefined),
    applyAdFocus: vi.fn<(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter) => Promise<void>>(async () => undefined),
    // Host-owned tab policy + settings-patch application (see background.ts).
    loadTabPlaybackPolicy: vi.fn(async () => ({ keepVideosUnmuted: currentSettings.keepFarmingVideosUnmuted !== false })),
    applySettingsPatch: vi.fn((current: ExtensionSettings, patch) => applySettingsPatch(current, patch)),
    createAdapters: vi.fn((_emit: EventEmitter, nextSettings: ExtensionSettings) => ({
      adapters: { twitch, kick },
      ...resolveCompatibility(nextSettings.compatibility, { host: "extension", twitchIdentity: "web" }),
    })),
    reportEvents: vi.fn(overrides.reportEvents ?? reportEvents),
    stopPageContextTabs: vi.fn(overrides.stopPageContextTabs ?? forgetManagedPageContextTabs),
    wait: overrides.wait,
    ...(overrides.checkCredentialAvailability
      ? { checkCredentialAvailability: vi.fn(overrides.checkCredentialAvailability) }
      : {}),
  };

  return {
    controller: createBackgroundController(deps),
    deps,
    get settings() {
      return currentSettings;
    },
    get state() {
      return currentState;
    },
    twitch,
    kick,
    reportEvents: deps.reportEvents,
  };
}

describe("background controller", () => {
  it("reports missing credentials without calling the platform probe", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
      checkCredentialAvailability: async () => ({ status: "missing" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.twitch).toEqual(expect.objectContaining({
      status: "missing_credentials",
      reasonCode: "credentials_missing",
    }));
  });

  it("reports credential lookup failure without calling the platform probe", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
      checkCredentialAvailability: async () => ({ status: "unavailable" }),
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(expect.objectContaining({
      status: "unavailable",
      reasonCode: "credential_lookup_failed",
    }));
  });

  it("continues to the authenticated probe when credentials are available", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
  });

  it("blocks startup account work when credentials are missing without disabling the platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => ({ status: "missing" }),
    });

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "missing_credentials",
      reasonCode: "credentials_missing",
    });
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "authentication_unhealthy",
    });
  });

  it("automatically resumes a platform after a healthy authentication recheck", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:00:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      })
      .mockResolvedValueOnce({
        status: "healthy",
        checkedAt: "2026-07-22T12:01:00.000Z",
        message: { key: "authHealthy" },
      });

    await env.controller.tickAndHandOff(["twitch"]);
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.discoverCampaigns).toHaveBeenCalledOnce();
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
      event.category === "activity" && event.code === "auth_health_changed"
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ to: "invalid_credentials" }) }),
      expect.objectContaining({ data: expect.objectContaining({ to: "healthy" }) }),
    ]));
  });

  it("publishes authentication transitions when diagnostic logging is disabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, diagnosticLogging: false });
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      platform: "kick",
      data: expect.objectContaining({ to: "blocked" }),
    }));
  });

  it("does not strand the popup on \"checking\" when the credential probe throws", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }, {
      checkCredentialAvailability: async () => {
        throw new Error("cookie read failed");
      },
    });

    await env.controller.tickAndHandOff(["twitch"]);

    // A transient failure reading the session cookies must not roll the whole
    // tick back and leave auth health pinned on its prior "checking" value —
    // that is what keeps the popup stuck on "Checking your signed-in session…".
    expect(env.state.authHealth.twitch.status).not.toBe("checking");
    expect(env.state.authHealth.twitch).toMatchObject({ status: "unavailable" });
  });

  it("reports authentication as the reason farming stopped after logout", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" })
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:01:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      });

    await env.controller.tickAndHandOff(["twitch"]);
    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      platform: "twitch",
      data: expect.objectContaining({ reason: "authentication_unhealthy" }),
    }));
  });

  it("recovers Twitch authentication health after login without changing enabled settings", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true }, {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    vi.mocked(env.twitch.checkAuthHealth)
      .mockResolvedValueOnce({
        status: "invalid_credentials",
        checkedAt: "2026-07-22T12:00:00.000Z",
        reasonCode: "credentials_rejected",
        message: { key: "authInvalidCredentials" },
      })
      .mockResolvedValueOnce({
        status: "healthy",
        checkedAt: "2026-07-22T12:05:00.000Z",
        message: { key: "authHealthy" },
      });

    await env.controller.checkAuthHealth("twitch");
    await env.controller.invalidateAuthHealth("twitch");
    await env.controller.checkAuthHealth("twitch");

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-22T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(true);
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2);
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
  });

  it("invalidates only the requested authentication health and reports the transition once", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" });
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "missing_credentials",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "credentials_missing",
    });
    await env.controller.checkAuthHealth("twitch");
    await env.controller.checkAuthHealth("kick");
    const previousKickHealth = env.state.authHealth.kick;
    env.reportEvents.mockClear();

    await env.controller.invalidateAuthHealth("twitch");

    expect(env.state.authHealth.twitch).toEqual({ status: "checking" });
    expect(env.state.authHealth.kick).toEqual(previousKickHealth);
    expect(env.reportEvents).toHaveBeenCalledWith([{
      category: "activity",
      code: "auth_health_changed",
      level: "info",
      platform: "twitch",
      data: { from: "healthy", to: "checking" },
    }]);

    env.reportEvents.mockClear();
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("checks and persists authentication health for only the requested platform", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(expect.objectContaining({
      status: "blocked",
      reasonCode: "security_policy_blocked",
    }));
    expect(env.reportEvents).toHaveBeenCalledWith([{
      category: "activity",
      code: "auth_health_changed",
      level: "error",
      platform: "kick",
      data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
    }]);
  });

  it("stores timestamp-only auth refreshes without repeating activity", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    vi.mocked(env.kick.checkAuthHealth)
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:00:00.000Z" })
      .mockResolvedValueOnce({ status: "healthy", checkedAt: "2026-07-22T12:05:00.000Z" });

    await env.controller.checkAuthHealth("kick");
    env.reportEvents.mockClear();
    await env.controller.checkAuthHealth("kick");

    expect(env.state.authHealth.kick.checkedAt).toBe("2026-07-22T12:05:00.000Z");
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("strips hostile adapter fields before auth state and events are persisted", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({
      status: "healthy",
      checkedAt: "2026-07-22T12:00:00.000Z",
      token: "do-not-store",
      headers: { authorization: "Bearer do-not-store" },
    } as never);

    await env.controller.checkAuthHealth("twitch");

    expect(JSON.stringify(env.state.authHealth.twitch)).not.toContain("do-not-store");
    expect(JSON.stringify(env.reportEvents.mock.calls)).not.toContain("do-not-store");
  });

  it("reports the effective compatibility profile and capability once per enabled platform", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.tick();
    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
    expect(published).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "kick",
      compatibilityProfile: "kick-2026-07",
      compatibilityCapability: "kick-claim-v2",
      compatibilityCapabilities: ["kick-claim-v2"],
    }));
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityProfile" in event
      && event.platform === "twitch"
    )).toHaveLength(1);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityProfile" in event
      && event.platform === "kick"
    )).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain("auth-token");
  });

  it("reports enabled compatibility selections on startup while farming is paused", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
  });

  it("reports compatibility again only when the effective selection changes", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.tick();
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-gql-v1" } } },
      tickAfterSave: true,
    });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && "compatibilityCapability" in event
      && event.compatibilityCapability === "twitch-heartbeat-gql-v1"
    )).toHaveLength(1);
  });

  it("emits credential-safe resolver warnings without echoing persisted selections", async () => {
    const hostileSelection = "unknown-auth-token=secret-cookie";
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: hostileSelection,
        },
      },
    });

    await env.controller.handleStartup();

    const serialized = JSON.stringify(env.reportEvents.mock.calls.flatMap(([events]) => events));
    expect(serialized).not.toContain(hostileSelection);
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "Unknown Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
  });

  it("uses profile metadata for profile resolver warnings", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, profile: "unknown-profile" },
      },
    });

    await env.controller.handleStartup();

    const warning = env.reportEvents.mock.calls.flatMap(([events]) => events).find((event) =>
      event.category === "diagnostic" && event.platform === "twitch" && event.level === "warn");
    expect(warning).toEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      compatibilityProfile: "twitch-2026-07",
    }));
    expect(warning).not.toHaveProperty("compatibilityCapability");
    expect(warning).not.toHaveProperty("compatibilityVersion");
  });

  it("preserves compatibility diagnostics when a scheduler tick fails", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.twitch.discoverCampaigns = vi.fn(async () => { throw new Error("discovery failed"); });

    await env.controller.tick();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
    }));
  });

  it("does not emit resolver warnings for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, heartbeatTransport: "invalid-secret" },
      },
    });

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) =>
      event.category === "diagnostic" && event.platform === "twitch" && event.level === "warn"
    )).toEqual([]);
  });

  it("emits a fresh warning when a different invalid selection resolves identically", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, heartbeatTransport: "first-secret" },
      },
    });

    await env.controller.handleStartup();
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { compatibility: { twitch: { heartbeatTransport: "second-secret" } } },
      tickAfterSave: true,
    });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) =>
      event.category === "diagnostic"
      && event.platform === "twitch"
      && event.level === "warn"
      && event.message === "Unknown Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1"
    )).toHaveLength(2);
    expect(JSON.stringify(published)).not.toContain("first-secret");
    expect(JSON.stringify(published)).not.toContain("second-secret");
  });

  it("emits a fixed host-incompatible warning with only the safe fallback identifier", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: "twitch-heartbeat-trowel-v1",
        },
      },
    });

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "Host-incompatible Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1",
    }));
  });

  it("saves operational state before publishing the ordered batch", async () => {
    const calls: string[] = [];
    const env = harness({ ...DEFAULT_SETTINGS, running: true }, {
      saveState: async () => { calls.push("state"); },
      reportEvents: async () => { calls.push("events"); },
    });

    await env.controller.tick();

    expect(calls).toEqual(["state", "events"]);
  });

  it("does not publish tick events when the corresponding state save fails", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true }, {
      saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
    });

    await expect(env.controller.tick()).rejects.toThrow("storage unavailable");

    expect(env.deps.saveState).toHaveBeenCalledTimes(1);
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("never persists an event outbox in scheduler state", async () => {
    const env = harness();

    await env.controller.tick();

    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("preserves adapter and scheduler event order within one tick batch", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapters).mockImplementation((emit, settings) => {
      emit({ category: "diagnostic", level: "debug", message: "adapter-created" });
      return {
        adapters: { twitch: env.twitch, kick: env.kick },
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const adapterIndex = published.findIndex((event) => event.category === "diagnostic" && event.message === "adapter-created");
    const schedulerIndex = published.findIndex((event) => event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed"));
    expect(adapterIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerIndex).toBeGreaterThan(adapterIndex);
  });

  it("publishes category-search diagnostics in their own operation without leaking into the next tick", async () => {
    const env = harness();
    env.twitch.searchCategories = vi.fn(async () => {
      throw new Error("category lookup failed");
    });

    await env.controller.handleMessage({ type: "searchCategories", platform: "twitch", query: "game" });

    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Category search failed: category lookup failed",
      }),
    ]));

    env.reportEvents.mockClear();
    await env.controller.tick();

    const tickEvents = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(tickEvents.some((event) => event.category === "diagnostic" && event.message.includes("category lookup failed"))).toBe(false);
  });

  it("publishes lifecycle events through the host sink without persisting log history", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });

    await env.controller.tick();
    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) => event.code === "farming_started")).toHaveLength(1);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_started",
      platform: "twitch",
    }));
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("does not commit pending-claim diagnostics when scheduler state persistence fails", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);
    env.twitch.isClaimReady = vi.fn(() => false);
    env.deps.saveState.mockRejectedValueOnce(new Error("state write failed"));

    await expect(env.controller.tick()).rejects.toThrow("state write failed");
    await env.controller.tick();

    const waitingEvents = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"));
    expect(waitingEvents).toHaveLength(1);
  });

  it("publishes one actionable link-required diagnostic while repeated automatic claims are suppressed", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    let claimPosts = 0;
    let affirmativelyLinked = false;
    const fetcher: PageFetcher = {
      fetchJson: vi.fn(async (url: string) => {
        if (url === "https://kick.com/api/v1/user") {
          return { id: 123, username: "tester" };
        }
        if (url === "https://web.kick.com/api/v1/drops/claim") {
          claimPosts += 1;
          return { data: { connect_url: "https://accounts.example/link" } };
        }
        if (url === "https://web.kick.com/api/v1/drops/progress") {
          return { data: [{ campaign_id: "kick-campaign", ...(affirmativelyLinked ? { user_app_connected: true } : {}) }] };
        }
        throw new Error(`Unexpected URL ${url}`);
      }) as PageFetcher["fetchJson"],
    };
    const claimState = new KickClaimState();
    env.deps.createAdapters.mockImplementation((emit, settings) => {
      const kick = new KickAdapter(fetcher, undefined, undefined, emit, { claimState });
      kick.discoverCampaigns = vi.fn(async () => [campaign("kick", "claimable")]);
      kick.listCandidateChannels = vi.fn(async () => []);
      return {
        adapters: { twitch: env.twitch, kick },
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();
    await env.controller.tick();

    expect(claimPosts).toBe(1);
    const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
    expect(events.filter((event) =>
      event.category === "diagnostic"
      && event.level === "warn"
      && event.message.includes("using the account-link action")
    )).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("https://accounts.example/link");
    expect(env.state.campaigns.kick[0].rewards[0].claimGuidance).toEqual({
      kind: "link_required",
      url: "https://accounts.example/link",
    });

    affirmativelyLinked = true;
    await env.controller.tick();
    expect(claimPosts).toBe(2);

    const separateState = new KickClaimState();
    const separateAdapter = new KickAdapter(fetcher, undefined, undefined, () => {}, { claimState: separateState });
    await separateAdapter.claimReward(campaign("kick", "claimable"), campaign("kick", "claimable").rewards[0]);
    expect(claimPosts).toBe(3);
  });

  it("publishes a farming stop reason when automation is disabled", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    await env.controller.tick();

    await env.controller.handleMessage({ type: "setRunning", running: false });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      data: expect.objectContaining({ reason: "automation_disabled" }),
    }));
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("publishes an interruption when an idle platform is paused by manual watch", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      pauseOnManualWatch: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 99,
        checkedAt: new Date().toISOString(),
        active: true,
      },
    };

    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "interruption",
      platform: "twitch",
      data: expect.objectContaining({ reason: "manual_watch" }),
    }));
  });

  it("creates the scheduler alarm from persisted settings", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 11 });

    await env.controller.ensureAlarm();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 11 });
  });

  it("auto-starts on launch only when the persisted running state is enabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: true });

    await env.controller.ensureAlarm();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
  });

  it("clears stale restart tabs and auto-resumes with fresh tabs when auto-start is enabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: true });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      campaignId: "old-campaign",
      rewardId: "old-reward",
      offlineChecks: 2,
      playbackChecks: 1,
      errorChecks: 1,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      tabId: 44,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    };
    env.state.campaigns.twitch = [{
      ...campaign("twitch"),
      id: "old-campaign",
      rewards: [{ ...reward(), id: "old-reward" }],
    }];
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "farming_stopped",
        data: expect.objectContaining({ reason: "runtime_restart" }),
      }),
    ]));
  });

  it("pauses stale restart sessions and disables running when auto-start is disabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: false });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 44,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.settings.running).toBe(false);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.managedWatchTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("cleans stale restart state without starting farming when automation is already stopped", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });
    env.state.sessions.kick = {
      platform: "kick",
      status: "paused",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 55,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 55,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.settings.running).toBe(false);
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 55, channelUrl: "https://kick.com/kick-creator", ownedByExtension: true }),
    ]);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.sessions.kick.tabId).toBeUndefined();
  });

  it("clears stale retained page-context tabs on startup", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], reason: "runtime_restart", emit: expect.any(Function) }),
    );
    expect(env.state.managedPageContextTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("preserves a retained Kick page context across a running service-worker restart", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      autoStartDropFarming: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });
    const context = {
      platform: "kick" as const,
      tabId: 91,
      originUrl: "https://kick.com/drops/inventory",
      origin: "https://kick.com",
      ownedByExtension: true as const,
      lastFallbackAt: "2026-07-22T08:00:00.000Z",
      fallbackHost: "web.kick.com",
      backgroundSuccesses: 0,
    };
    env.state.managedPageContextTabs = { kick: context };

    await env.controller.handleStartup();

    expect(env.deps.stopPageContextTabs).not.toHaveBeenCalledWith(
      expect.objectContaining({ kick: expect.objectContaining({ tabId: 91 }) }),
      expect.objectContaining({ reason: "runtime_restart" }),
    );
    expect(env.state.managedPageContextTabs?.kick).toEqual(context);
    expect(env.kick.discoverCampaigns).toHaveBeenCalledOnce();
  });

  it("does not log startup cleanup when there is no stale farming state", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.deps.saveState).not.toHaveBeenCalled();
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some((event) =>
      event.category === "diagnostic" && event.message.includes("Browser restarted")
    )).toBe(false);
  });

  it("disables running on startup when auto-start is disabled even without stale tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: false });

    await env.controller.handleStartup();

    expect(env.settings.running).toBe(false);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.deps.saveState).not.toHaveBeenCalled();
  });

  it("starts automation, persists settings, creates alarm, and runs an immediate tick", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setRunning", running: true }));

    expect(env.settings.running).toBe(true);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: true }));
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
  });

  it("stops automation immediately and applies auto-close behavior to active watch tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoCloseFinishedDrops: false });
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setRunning", running: false }));

    expect(env.settings.running).toBe(false);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 10 }));
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 20 }));
    expect(snapshot.state.sessions.twitch.status).toBe("paused");
    expect(snapshot.state.sessions.kick.status).toBe("paused");
    expect(snapshot.state.managedPageContextTabs?.twitch).toBeUndefined();
  });

  it("prepares a host reset by force-closing managed tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoCloseFinishedDrops: false });
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 10 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 20 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], emit: expect.any(Function) }),
    );
  });

  it("allows host-reset cleanup to be retried", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    await env.controller.tick();

    await env.controller.prepareForHostReset();

    await expect(env.controller.prepareForHostReset()).resolves.toBeUndefined();
  });

  it("force-closes registry-owned tabs even when no live session references them", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 71,
        channelUrl: "https://www.twitch.tv/stale-channel",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([expect.objectContaining({ tabId: 71 })]);
  });

  it("holds controller mutations until host storage reset finishes", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    let releaseReset!: () => void;
    const resetBlocked = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const resetStarted = vi.fn();
    const resetting = env.controller.prepareForHostReset(async () => {
      resetStarted();
      await resetBlocked;
      await env.deps.saveSettings(DEFAULT_SETTINGS);
      await env.deps.saveState(DEFAULT_STATE);
    });
    await vi.waitFor(() => expect(resetStarted).toHaveBeenCalledOnce());
    vi.mocked(env.twitch.discoverCampaigns).mockClear();

    const ticking = env.controller.tick();
    await Promise.resolve();

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    releaseReset();
    await Promise.all([resetting, ticking]);
    expect(env.settings).toEqual(DEFAULT_SETTINGS);
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("toggles one platform and immediately applies the scheduler when running", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    await env.controller.tick();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    }));

    expect(snapshot.settings.platform.twitch.enabled).toBe(false);
    expect(snapshot.settings.platform.kick.enabled).toBe(true);
    expect(snapshot.state.sessions.twitch.status).toBe("paused");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
  });

  it("enables popup automation with one settings save and one initial scheduler pass", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    });

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    expect(env.deps.saveSettings).toHaveBeenCalledTimes(1);
    expect(env.settings.running).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(false);
    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("paused");
  });

  it("saves and normalizes settings without forcing a scheduler tick", async () => {
    const env = harness();
    const nextSettings = { ...DEFAULT_SETTINGS, running: true, pollIntervalMinutes: Number.NaN, offlineRetryLimit: 0 };

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("recreates the scheduler alarm when saving a custom tick interval", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { pollIntervalMinutes: 17 },
    });

    expect(env.settings.pollIntervalMinutes).toBe(17);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 17 });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("merges overlapping settings patches without clobbering previous saves", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });

    await Promise.all([
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyRewardEarned: false,
          platform: { twitch: { excludedChannels: ["skipme"] } },
        },
      }),
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyNoDropsLeft: false,
          platform: { kick: { enabled: false } },
        },
      }),
    ]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.settings.platform.twitch.excludedChannels).toEqual(["skipme"]);
    expect(env.settings.platform.kick.enabled).toBe(false);
  });

  it("preserves rapid scheduling patches without overlapping reconciliation", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
    });
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    let discoveryCalls = 0;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(env.twitch.discoverCampaigns).mockImplementation(async () => {
      discoveryCalls += 1;
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      if (discoveryCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
      activeDiscoveries -= 1;
      return [];
    });

    const first = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await firstStarted;
    const second = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyNoDropsLeft: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await drainMicrotasks();
    releaseFirst();
    await Promise.all([first, second]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(2);
    expect(maxActiveDiscoveries).toBe(1);
  });

  it("runs a scheduler tick after saving settings when requested and automation is active", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("only ticks requested platforms after saving settings with targeted platforms", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        kick: { ...env.settings.platform.kick, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
      tickAfterSavePlatforms: ["kick"],
    }));

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.kick.discoverCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.kick.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("does not start automation after saving Idle Watchlist settings while paused", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.settings.running).toBe(false);
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("keeps active farming untouched when saving a non-scheduling setting", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      tabId: 10,
      tabManagedByExtension: true,
      offlineChecks: 0,
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
    }));

    expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
  });

  it("runs an immediate scheduler tick when requested from the popup", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "farming_started" }),
    ]));
  });

  it("reports scheduler diagnostics without consulting host diagnostic settings", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, diagnosticLogging: false });

    await env.controller.handleMessage({ type: "tickNow" });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.level === "debug")).toBe(true);
  });

  it("records playback telemetry only for the managed watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        readyState: 4,
        currentTime: 12,
        duration: 1200,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toMatchObject({
      platform: "twitch",
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 0,
        mutedVideoCount: 0,
        unmutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 999 } });

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
  });

  it("records visible playback in a non-managed tab as manual watch activity", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      platform: "twitch",
      tabId: 999,
      active: true,
    });
    expect(env.state.sessions.twitch.playback).toBeUndefined();
  });

  it("clears manual watch activity when the source tab is closed", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleTabRemoved(999);

    expect(env.state.manualWatch?.twitch).toBeUndefined();
  });

  it("marks manual watch inactive when the same tab stops visible playback", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 999,
      active: false,
    });
  });

  it("logs playback transitions such as ad starts and blocked playback", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    // Baseline healthy telemetry — no ad, nothing blocked.
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1, playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false, adActive: false },
    }, { tab: { id: 10 } });

    // Ad starts and the browser blocks playback (re-muted).
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 1, unmutedVideoCount: 0, playingVideoCount: 1, blockedPlaybackCount: 1, documentHidden: false, adActive: true },
    }, { tab: { id: 10 } });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const messages = published.filter((event) => event.category === "diagnostic").map((event) => event.message);
    expect(messages).toContain("Ad started; keeping the watch tab counting down");
    expect(published.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.startsWith("Playback was blocked"))).toBe(true);
  });

  it("publishes focus diagnostics exactly once in the telemetry operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness({ ...DEFAULT_SETTINGS, running: false }, {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    reported.length = 0;
    env.deps.applyAdFocus.mockImplementation(async (_platform, _tabId, _adActive, emit) => {
      emit({ category: "diagnostic", level: "info", message: "focus-adjusted", platform: "twitch" });
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    const focusDiagnostics = reported
      .flatMap((events) => events)
      .filter((event) => event.category === "diagnostic" && event.message === "focus-adjusted");
    expect(focusDiagnostics).toHaveLength(1);
  });

  it("keeps persisted playback telemetry when applying ad focus fails", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus callback failed"));

    await expect(env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } })).resolves.toBeUndefined();

    expect(env.state.sessions.twitch.playback?.adActive).toBe(true);
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus callback failed",
    }));
  });

  it("focuses the watch tab when an ad is reported on the managed tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, adFocusMode: "window" });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, true, expect.any(Function));
  });

  it("releases ad focus when telemetry reports no ad", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, adFocusMode: "tab" });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: false,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
  });

  it("does not focus for telemetry from a tab that is not the watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 999 } });

    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
  });

  it("ignores playback telemetry without a sender tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toBeUndefined();
    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.message.startsWith("Ad started"))).toBe(false);
  });

  it("does not treat tabless sessions as managed playback telemetry targets", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      watchMode: "tabless",
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 10,
      active: true,
    });
    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
  });

  it("re-applies ad focus from playback state on each scheduler tick", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.handleMessage({ type: "tickNow" });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("kick", 20, false, expect.any(Function));
  });

  it("keeps successful scheduler state when re-applying ad focus fails", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus refresh failed"));

    await env.controller.tick();

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus refresh failed",
    }));
  });

  it("allows playback control only for the current watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 999 } },
    )).resolves.toEqual({ managed: false, keepVideosUnmuted: true });
  });

  it("passes the playback control setting to managed watch tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, keepFarmingVideosUnmuted: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: false });
  });

  it("defaults playback control on when stored settings are missing the advanced flag", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    env.deps.loadSettings.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      running: true,
      keepFarmingVideosUnmuted: undefined,
    } as unknown as typeof DEFAULT_SETTINGS);
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
    };

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });
  });

  it("defers recovery when the active managed farming tab is closed", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(10);

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch).toEqual({
      platform: "twitch",
      status: "idle",
      offlineChecks: 0,
    });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();

    await env.controller.tick();

    expect(env.twitch.discoverCampaigns).toHaveBeenCalledOnce();
    expect(env.twitch.prepareWatchTab).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tabId).toBe(10);
  });

  it("does not confuse a removed page-context tab with the active farming tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };
    env.state.managedPageContextTabs = {
      kick: {
        platform: "kick",
        tabId: 91,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(91);

    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs?.kick?.tabId).toBe(20);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("ignores removed tabs that are not the active managed watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(999);

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("does not reopen a closed tab for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
      },
    });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("tracks one managed watch tab per running platform", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.tick();

    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs).toMatchObject({
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    });
  });

  it("completes a campaign after manually claiming its last subscription reward", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: false });
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch", "claimed"),
      rewards: [reward("claimed"), subscriptionReward],
    };
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: "twitch-campaign" }),
      expect.objectContaining({ id: "subscription-reward", status: "claimable", requirement: "subscription" }),
    );
    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "completed",
      rewards: [
        { id: "reward", status: "claimed" },
        { id: "subscription-reward", status: "claimed", watchedMinutes: 0 },
      ],
    });
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "reward_claimed",
        data: expect.objectContaining({ method: "manual" }),
      }),
    ]));
  });

  it("keeps a mixed campaign active after manually claiming its subscription reward", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: false });
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch"),
      rewards: [subscriptionReward, { ...reward("locked"), id: "watch-reward", requirement: "watch" as const }],
    };
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      rewards: [
        { id: "subscription-reward", status: "claimed" },
        { id: "watch-reward", status: "locked" },
      ],
    });
  });

  it("unlocks a dependent watch reward immediately after a manual subscription claim", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: false });
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign: DropCampaign = {
      ...campaign("twitch"),
      eligibility: "eligible",
      rewards: [
        subscriptionReward,
        {
          ...reward("locked"),
          id: "watch-reward",
          requirement: "watch",
          preconditionRewardIds: [subscriptionReward.id],
          preconditionsMet: false,
        },
      ],
    };
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: subscriptionReward.id,
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      eligibility: "eligible",
      rewards: [
        { id: subscriptionReward.id, status: "claimed" },
        { id: "watch-reward", status: "locked", preconditionsMet: true },
      ],
    });
  });

  it("does not publish manual-claim events when the corresponding state save fails", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: false }, {
      saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
    });
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];

    await expect(env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    })).rejects.toThrow("storage unavailable");

    expect(env.deps.saveState).toHaveBeenCalledTimes(1);
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("records a warning when a manual claim target is stale", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "missing-campaign",
      rewardId: "reward",
    });

    expect(env.twitch.claimReward).not.toHaveBeenCalled();
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Reward claim skipped because the campaign or reward is no longer available",
      }),
    ]));
  });

  it("emits reward notifications best-effort when rewards become earned", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: true });
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Reward earned",
      message: "Reward from twitch campaign",
    });
  });

  it("emits a notification when a Kick challenge is claimed", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: true });
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Challenge reward claimed",
      message: "You won a mythic card from your daily challenge.",
    });
  });

  it("does not emit a challenge notification when reward notifications are off", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: false });
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Challenge reward claimed" }),
    );
  });

  it("does not emit disabled reward notifications", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: false });
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("emits the no-drops-left notification once when entering the exhausted state", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      notifyNoDropsLeft: true,
      platform: { ...DEFAULT_SETTINGS.platform, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    // A fully claimed campaign is present but has nothing earnable, so the
    // scheduler goes idle into the "no drops left" condition.
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "No drops left" }));
  });

  it("does not re-emit the no-drops-left notification while the exhausted state persists", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      notifyNoDropsLeft: true,
      notifyRewardEarned: false,
      platform: { ...DEFAULT_SETTINGS.platform, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();
    await env.controller.tick();

    // The exhausted state persists across both ticks; the notification must fire
    // only on the transition, not once per tick. No other notifications are
    // enabled, so the no-drops notification is the only expected call.
    expect(env.deps.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "No drops left" }));
    expect(env.deps.createNotification).toHaveBeenCalledTimes(1);
  });

  it("reports a controller-fatal interruption even when diagnostics are filtered by the host", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("adapter factory failed");
    });

    await env.controller.tick();

    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "interruption", level: "error" }),
      expect.objectContaining({ category: "diagnostic", level: "error", message: "adapter factory failed" }),
    ]));
  });

  function fakeTablessWatcher(tick: () => Promise<{ ok: boolean; live?: boolean; message?: string }>) {
    const watcher = {
      platform: "twitch" as const,
      channelUrl: undefined as string | undefined,
      start: vi.fn(async (ch: { url: string }) => {
        watcher.channelUrl = ch.url;
      }),
      tick: vi.fn(tick),
      drainEvents: vi.fn<() => DiagnosticEvent[]>(() => []),
      stop: vi.fn(async () => {
        watcher.channelUrl = undefined;
      }),
    };
    return watcher;
  }

  it("stops a tabless watcher without another heartbeat when authentication degrades", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = vi.fn(() => watcher);

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    env.state.authHealth.twitch = {
      status: "invalid_credentials",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };

    await env.controller.runWatchHeartbeat();

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(watcher.tick).not.toHaveBeenCalled();
  });

  // Drains every pending microtask. setTimeout stays real under the Date-only
  // fake timers these handoff tests install, so one turn of the macrotask queue
  // is enough to let an async loop run to its next park.
  const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // A `wait` the test releases by hand, so handoff loops advance
  // deterministically instead of racing real timers.
  function manualWait() {
    const pending: Array<() => void> = [];
    const wait = vi.fn(async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // The delay still consumes the handoff's time budget, so a loop driven
      // entirely by flush() still reaches its deadline.
      vi.setSystemTime(Date.now() + ms);
    });
    // Drain FIRST so the loop has actually parked — runClaimHandoff suspends on
    // loadSettings well before it reaches its first wait, and releasing an empty
    // queue would leave it parked forever.
    const flush = async () => {
      await drainMicrotasks();
      for (const resolve of pending.splice(0)) resolve();
      await drainMicrotasks();
    };
    return { wait, flush, get parked() { return pending.length; } };
  }

  function tablessEnv(overrides: Partial<ExtensionSettings> = {}) {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
      ...overrides,
    });
    env.twitch.supportsTabless = true;
    return env;
  }

  it("farms tablessly without opening a tab and records heartbeat health", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.twitch.tv/twitch-creator" }),
      expect.any(Object),
    );

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("persists page-context lifecycle metadata changed during a heartbeat", async () => {
    const watcher = fakeTablessWatcher(async () => {
      recordManagedPageContextFallback("twitch", "gql.twitch.tv", undefined, Date.parse("2026-07-21T12:00:00.000Z"));
      return { ok: true, live: true };
    });
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    const context = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    env.state.managedPageContextTabs = { twitch: context };
    registerManagedPageContextTabs({ twitch: context });

    await env.controller.runWatchHeartbeat();

    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      tabId: 66,
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("publishes persistent watcher diagnostics once through the current operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }, {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    const pending: DiagnosticEvent[] = [];
    const watcher = fakeTablessWatcher(async () => {
      pending.push({ category: "diagnostic", platform: "twitch", level: "debug", message: "heartbeat-detail" });
      return { ok: true, live: true };
    });
    watcher.drainEvents.mockImplementation(() => pending.splice(0));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    pending.push({ category: "diagnostic", platform: "twitch", level: "info", message: "connected-after-start" });
    expect(reported.flat().some((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toBe(false);

    await env.controller.runWatchHeartbeat();
    expect(reported.at(-1)?.filter((event) =>
      event.category === "diagnostic"
      && (event.message === "connected-after-start" || event.message === "heartbeat-detail"))
    ).toEqual([
      expect.objectContaining({ message: "connected-after-start" }),
      expect.objectContaining({ message: "heartbeat-detail" }),
    ]);

    await env.controller.runWatchHeartbeat();
    expect(reported.flat().filter((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toHaveLength(1);
  });

  it("falls back to a watch tab once the tabless heartbeat keeps failing", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: false, live: true }));
    const env = tablessEnv({ offlineRetryLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");

    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 1
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();

    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 2, triggers fallback

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tab");
    expect(env.state.sessions.twitch.tablessFallback).toBe(true);
    expect(watcher.stop).toHaveBeenCalled();
  });

  it("keeps successful scheduler state when stopping a tabless watcher fails", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    watcher.stop.mockRejectedValue(new Error("watcher stop failed"));

    await expect(env.controller.handleMessage({ type: "setRunning", running: false })).resolves.toBeDefined();

    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "watcher stop failed",
    }));
  });

  it("rebuilds tabless watchers from persisted sessions after a service-worker restart", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    // Simulate a fresh service worker: a tabless watch session is persisted, but
    // no tick() has run this lifetime to populate the in-memory watcher map.
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    await env.controller.runWatchHeartbeat();

    expect(watcher.start).toHaveBeenCalled();
    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("serializes concurrent state writers so neither update is lost", async () => {
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Model storage snapshot semantics: each load returns an isolated copy, so
    // an unserialized handler building on a stale snapshot would clobber a newer
    // save. Trace load/save ordering to prove the lock serializes them.
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleMessage(
        {
          type: "playbackTelemetry",
          platform: "twitch",
          telemetry: {
            videoCount: 1,
            mutedVideoCount: 0,
            unmutedVideoCount: 1,
            playingVideoCount: 1,
            blockedPlaybackCount: 0,
            documentHidden: false,
          },
        },
        { tab: { id: 10 } },
      ),
      env.controller.tick(),
    ]);

    // Serialized: every load is immediately followed by that operation's save
    // before the next operation's load (never load, load, save, save).
    expect(trace.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < trace.length; i += 2) {
      expect(trace[i]).toBe("load");
      expect(trace[i + 1]).toBe("save");
    }
    // Both writers' changes survive in the final persisted state.
    expect(env.state.sessions.twitch.playback).toBeDefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("serializes handleTabRemoved against a concurrent tick so neither write is lost", async () => {
    const env = harness();
    env.state.manualWatch = {
      kick: { platform: "kick", tabId: 50, checkedAt: new Date().toISOString(), active: true },
    };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Same snapshot-isolation trace as the writer-serialization test above: an
    // unserialized handleTabRemoved would build on a stale snapshot and clobber
    // tick()'s save (or vice versa).
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleTabRemoved(50),
      env.controller.tick(),
    ]);

    // Serialized: every load is immediately followed by that operation's save.
    expect(trace.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < trace.length; i += 2) {
      expect(trace[i]).toBe("load");
      expect(trace[i + 1]).toBe("save");
    }
    // Both writers' changes survive: the manual-watch entry is removed AND the
    // concurrent tick committed its progress.
    expect(env.state.manualWatch?.kick).toBeUndefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("reports the reward ids claimed during a tick, per platform", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: true });
    env.twitch.discoverCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

    const claimed = await env.controller.tick();

    expect(claimed).toEqual({ twitch: ["reward"] });
  });

  describe("post-claim handoff", () => {
    // Date only: the handoff's deadline is wall-clock based, but its delays are
    // injected, so setTimeout must stay real for drainMicrotasks.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Twitch-only environment whose adapter opts into the handoff.
    function handoffEnv(overrides: Partial<ExtensionSettings> = {}) {
      const timer = manualWait();
      const env = harness({
        ...DEFAULT_SETTINGS,
        running: true,
        autoClaim: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
        },
        ...overrides,
      }, { wait: timer.wait });
      env.twitch.supportsPostClaimHandoff = true;
      // Re-declare the getters: spreading `env` would evaluate them once and
      // freeze the initial snapshot, so every assertion would read stale state.
      return {
        ...env,
        timer,
        get state() { return env.state; },
        get settings() { return env.settings; },
      };
    }

    // A campaign whose first reward is claimable and whose second reward only
    // becomes visible on a later inventory read — the Twitch behavior the
    // handoff exists to absorb.
    function chainedCampaign(revealSecond: boolean): DropCampaign {
      const first: DropReward = { id: "reward-1", name: "First", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" };
      const second: DropReward = { id: "reward-2", name: "Second", requiredMinutes: 60, watchedMinutes: 0, status: "in_progress" };
      return {
        id: "twitch-campaign",
        platform: "twitch",
        name: "twitch campaign",
        status: "active",
        rewards: revealSecond ? [first, second] : [first],
      };
    }

    it("starts earning the next reward before the next heartbeat alarm", async () => {
      const env = handoffEnv();
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
    });

    it("stops at the deadline when no next reward appears", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      // A 15s budget at a 5s interval is three refreshes, never ten.
      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("exits early when the platform has no eligible reward left", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => []);

      const handoff = env.controller.runClaimHandoff("twitch");
      await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("aborts in flight when farming stops", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      // Let the loop actually park before aborting, so this exercises an
      // in-flight cancellation rather than a pre-start one.
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
      expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    });

    it("does not run for a platform without the capability", async () => {
      const env = handoffEnv();
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("does not suppress compatibility diagnostics when probing the capability", async () => {
      const env = handoffEnv();
      // Bails right after the capability probe, which is the call that could
      // poison the controller's compatibility dedup cache.
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await env.controller.tick();

      const published = env.reportEvents.mock.calls.flatMap(([events]: [readonly EngineEvent[]]) => events);
      expect(published).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: expect.stringContaining("Using compatibility profile"),
      }));
    });

    it("does not run when the setting is disabled", async () => {
      const env = handoffEnv({ postClaimHandoff: false });

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("sends one immediate heartbeat when the next reward starts tablessly", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).toHaveBeenCalledTimes(1);
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    });

    it("skips the immediate heartbeat when one just landed on the same channel", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      // Both rewards visible from the start, so the triggering tick already
      // selects the successor and the handoff takes its fast path.
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      // Establish the tabless session and land a heartbeat seconds ago.
      await env.controller.tick();
      await env.controller.runWatchHeartbeat();
      watcher.tick.mockClear();

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("starts a handoff after an automatic claim", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.tickAndHandOff();
      for (let index = 0; index < 12; index += 1) await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalled();
    });

    it("does not start a nested handoff for a claim inside a handoff", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      // Every refresh yields another claimable reward, which would restart the
      // deadline forever if a nested handoff were allowed.
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it("keeps an active handoff running during an ordinary settings save", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      expect(env.timer.parked).toBe(1);

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { notifyRewardEarned: false },
      });

      expect(env.timer.parked).toBe(1);
      for (let index = 0; index < 4; index += 1) await env.timer.flush();
      await handoff;
      expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
    });

    it("aborts running handoffs when farming is switched off", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      await env.controller.handleMessage({ type: "setRunning", running: false });
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
    });

    it("does not start a second handoff while the first is still starting", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      // Both calls are made before either has finished its async setup.
      const first = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      const second = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await Promise.all([first, second]);

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("honors an abort issued while the handoff is still starting", async () => {
      const env = handoffEnv();
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      // Synchronously, before any setup await has resolved.
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    });

    it("never refreshes after the maximum duration has elapsed", async () => {
      // A 30s interval against a 45s budget: a second full-length wait would
      // land a refresh at 60s, past the deadline the setting promises.
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 30, postClaimHandoffMaxSeconds: 45 });
      // The session keeps watching the reward that was just claimed, so the loop
      // never succeeds and never sees "nothing left" — only the deadline can end
      // it. Without that, the early exit would mask any overshoot.
      env.twitch.discoverCampaigns = vi.fn(async () => [campaign("twitch")]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward"]);
      for (let index = 0; index < 5; index += 1) await env.timer.flush();
      await handoff;

      expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    });

    it("sends no heartbeat when the abort lands while state is being read", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      await env.controller.tick();
      watcher.tick.mockClear();

      // Cancel at the moment the successor becomes visible to the handoff.
      const loadState = env.deps.loadState.getMockImplementation()!;
      env.deps.loadState.mockImplementation(async () => {
        const state = await loadState();
        if (state.sessions.twitch.rewardId === "reward-2") env.controller.abortClaimHandoffs();
        return state;
      });

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("sends no heartbeat when the next reward runs in a visible tab", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: false });
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.discoverCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).not.toHaveBeenCalled();
      // The tick that detected the successor already re-pointed the tab.
      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
      expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    });
  });
});
