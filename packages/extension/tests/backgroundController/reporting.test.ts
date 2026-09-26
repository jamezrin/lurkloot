import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { SchedulerState } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { createKickFetcher, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { kickAdapter } from "../helpers/adapters";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { allDiagnostics, campaign, deferred, farming, harness, reward } from "../helpers/backgroundController";

// Compatibility reporting, event publication, route evidence and notifications.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the effective compatibility profile and capability once per enabled platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

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
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      compatibilityProfile: "twitch-2026-07",
      compatibilityCapability: "twitch-heartbeat-spade-v1",
    }));
  });

  it("reports compatibility again only when the effective selection changes", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

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
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: hostileSelection,
        },
      },
    }));

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
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, profile: "unknown-profile" },
      },
    }));

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
    const env = harness(farming(DEFAULT_SETTINGS));
    env.twitch.refreshCampaigns = vi.fn(async () => { throw new Error("discovery failed"); });

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
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
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
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: { ...DEFAULT_SETTINGS.compatibility.twitch, heartbeatTransport: "first-secret" },
      },
    }));

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
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      compatibility: {
        ...DEFAULT_SETTINGS.compatibility,
        twitch: {
          ...DEFAULT_SETTINGS.compatibility.twitch,
          heartbeatTransport: "twitch-heartbeat-trowel-v1",
        },
      },
    }));

    await env.controller.handleStartup();

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "Host-incompatible Twitch heartbeat compatibility selection; using twitch-heartbeat-spade-v1",
    }));
  });

  it("saves each operational state before publishing its ordered batch", async () => {
    const calls: string[] = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      saveState: async () => { calls.push("state"); },
      // Controller-run and tick lifecycle diagnostics are published as they
      // happen and describe no state, so they are outside the
      // state-before-events batching invariant this test guards. Only
      // operational batches are recorded.
      reportEvents: async (events) => {
        if (events.every((event) =>
          event.category === "diagnostic"
          && /^(?:Background controller run |Tick #)/.test(event.message))) return;
        calls.push("events");
      },
    });

    await env.controller.tick();

    expect(calls).toEqual([
      "state", "events",
      "state", "events",
      "state", "events",
      "state", "events",
    ]);
  });

  it("does not publish tick events when the corresponding state save fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let saveCalls = 0;
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("storage unavailable");
      Object.assign(env.state, next);
    });

    await expect(env.controller.tick(["twitch"])).rejects.toThrow("storage unavailable");

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.deps.saveState).toHaveBeenCalledTimes(2);
    // Controller-run and tick lifecycle diagnostics publish independently of
    // state, so the invariant under test is about operational batches only.
    const operationalBatches = env.reportEvents.mock.calls
      .map(([events]) => events)
      .filter((events) => !events.every((event) =>
        event.category === "diagnostic"
        && /^(?:Background controller run |Tick #)/.test(event.message)));
    expect(operationalBatches).toHaveLength(1);
    expect(operationalBatches[0]).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      platform: "twitch",
    }));
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some((event) =>
      event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed")
    )).toBe(false);
  });

  it("never persists an event outbox in scheduler state", async () => {
    const env = harness();

    await env.controller.tick();

    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("publishes adapter construction events in the auth phase without leaking into the scheduler batch", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      emit({ category: "diagnostic", level: "debug", message: "adapter-created" });
      return {
        adapter: platform === "twitch" ? env.twitch : env.kick,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });

    await env.controller.tick();

    const batches = env.reportEvents.mock.calls.map(([events]) => events);
    const authBatchIndex = batches.findIndex((events) =>
      events.some((event) => event.category === "diagnostic" && event.message === "adapter-created"));
    const schedulerBatchIndex = batches.findIndex((events) =>
      events.some((event) => event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed"))
    );
    expect(authBatchIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerBatchIndex).toBeGreaterThan(authBatchIndex);
    expect(batches[schedulerBatchIndex]).not.toContainEqual(expect.objectContaining({ message: "adapter-created" }));
  });

  it("flushes standalone Kick search and manual claim successes into their own reports", async () => {
    const env = harness(DEFAULT_SETTINGS, { initialState: {
      ...DEFAULT_STATE,
      campaigns: { twitch: [], kick: [campaign("kick", "claimable")] },
    } });
    const discoveryState = new KickDiscoveryState();
    env.deps.createAdapters.mockImplementation((emit, settings) => ({
      adapters: { twitch: env.twitch, kick: kickAdapter(createKickFetcher({
        background: async (url) => url.includes("/search") ? { categories: [] } : { success: true },
        routeState: discoveryState.routeDiagnostics,
      }), undefined, undefined, emit, { discoveryState }) },
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));
    await env.controller.handleMessage({ type: "searchCategories", platform: "kick", query: "private-query" });
    const searchReports = allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary");
    expect(searchReports.map((event) => event.data)).toEqual([{ "kick.com.background": 1 }]);
    await env.controller.handleMessage({ type: "claimReward", platform: "kick", campaignId: "kick-campaign", rewardId: "reward" });
    const summaries = allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary");
    expect(summaries.map((event) => event.data)).toEqual([{ "kick.com.background": 1 }, { "web.kick.com.background": 1 }]);
    expect(JSON.stringify(summaries)).not.toContain("private-query");
    env.controller.shutdown();
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
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      url: "https://example.test/campaign",
      rewards: [{ ...reward(), imageUrl: "https://cdn.example.test/reward.png" }],
    }]);

    await env.controller.tick();
    await env.controller.tick();

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.filter((event) => event.category === "activity" && event.code === "farming_started")).toHaveLength(1);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_started",
      platform: "twitch",
      data: expect.objectContaining({
        rewardImageUrl: "https://cdn.example.test/reward.png",
        campaignUrl: "https://example.test/campaign",
      }),
    }));
    // The activity entry always brings its English diagnostic mirror along.
    expect(published.filter((event) => event.category === "diagnostic" && event.code === "farming_started")).toHaveLength(1);
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("does not commit pending-claim diagnostics when scheduler state persistence fails", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);
    env.twitch.isClaimReady = vi.fn(() => false);
    env.deps.saveState.mockRejectedValueOnce(new Error("state write failed"));

    await expect(env.controller.tick()).rejects.toThrow("state write failed");
    await env.controller.tick();

    const waitingEvents = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"));
    expect(waitingEvents).toHaveLength(1);
  });

  describe("route evidence independent of state publication", () => {
    function routeEnv(onBackgroundSuccess?: (host: string, emit: EventEmitter) => Promise<void> | void) {
      const env = harness({ ...DEFAULT_SETTINGS, preferKnownChannels: false, platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      } }, { authProbeTimeoutMs: 25 });
      const discoveryState = new KickDiscoveryState();
      env.deps.createAdapter.mockImplementation((platform, emit, settings) => ({
        adapter: platform === "kick" ? kickAdapter(createKickFetcher({
          background: async (url) => {
            if (url.endsWith("/user")) return { id: 42 };
            throw new KickWafBlockedError("blocked");
          },
          pageFetch: async () => ({ data: [] }),
          routeState: discoveryState.routeDiagnostics,
          onBackgroundSuccess,
          onPageFallback: (_host, operationEmit) => operationEmit({ category: "activity", code: "page_context_opened", level: "info", platform: "kick", data: { host: "kick.com", reason: "background_rejected" } }),
        }), undefined, undefined, emit, { discoveryState }) : env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      }));
      return env;
    }

    it.each(["abort after discovery drain", "stale publication rejection"])("keeps route evidence through %s without publishing discarded activity", async (mode) => {
      const env = routeEnv();
      let interrupted = false;
      env.deps.applyAdFocus.mockImplementation(async () => {
        if (mode === "abort after discovery drain") {
          interrupted = true;
          env.controller.shutdown();
        } else {
          env.deps.loadState.mockImplementationOnce(async () => {
            interrupted = true;
            env.controller.shutdown();
            return env.state;
          });
        }
      });
      await env.controller.tick(["kick"]);
      expect(interrupted).toBe(true);
      expect(env.state.sessions.kick.lastCheckedAt).toBeUndefined();
      const diagnostics = allDiagnostics(env);
      expect(diagnostics.filter((event) => event.code === "kick_fetch_route" && event.message.includes("using page tab"))).toHaveLength(1);
      expect(diagnostics.some((event) => event.code === "kick_fetch_summary" && event.data?.["web.kick.com.page"] === 2)).toBe(true);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) => event.category === "activity" && event.code === "page_context_opened")).toEqual([]);
    });

    it.each(["abort", "stale generation"])("keeps auth route evidence after %s", async (mode) => {
      const started = deferred<void>();
      const finish = deferred<void>();
      const env = routeEnv(async () => { started.resolve(); await finish.promise; });
      const checking = mode === "abort" ? env.controller.tick(["kick"]) : env.controller.checkAuthHealth("kick");
      await started.promise;
      if (mode === "abort") env.controller.shutdown();
      else await env.controller.invalidateAuthHealth("kick");
      finish.resolve();
      await checking;
      await env.controller.settleBackgroundWork();
      expect(env.state.authHealth.kick.status).not.toBe("healthy");
      expect(allDiagnostics(env).filter((event) => event.code === "kick_fetch_route")).toHaveLength(1);
      expect(allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary").map((event) => event.data)).toEqual([{ "kick.com.background": 1 }]);
      if (mode === "stale generation") {
        await env.controller.checkAuthHealth("kick");
        expect(env.state.authHealth.kick.status).toBe("healthy");
        expect(allDiagnostics(env).filter((event) => event.code === "kick_fetch_route")).toHaveLength(1);
      }
      env.controller.shutdown();
    });

    it.each([[false, false], [false, true], [true, false], [true, true]])("reports a late auth completion once after the deadline (tick=%s, lifecycle failure=%s)", async (tickProbe, lifecycleFailure) => {
      vi.useFakeTimers();
      const started = deferred<void>();
      const finish = deferred<void>();
      const env = routeEnv(async (_host, emit) => {
        started.resolve();
        await finish.promise;
        emit({ category: "activity", code: "page_context_closed", level: "info", platform: "kick", data: { host: "kick.com", reason: "background_recovered" } });
        if (lifecycleFailure) throw new Error("secret late lifecycle error");
      });
      const checking = tickProbe ? env.controller.tick(["kick"]) : env.controller.checkAuthHealth("kick");
      await started.promise;
      await vi.advanceTimersByTimeAsync(25);
      await checking;
      expect(env.state.authHealth.kick.reasonCode).toBe("network_unavailable");
      const writes = env.deps.saveState.mock.calls.length;
      expect(allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary")).toHaveLength(0);
      finish.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await env.controller.settleBackgroundWork();
      const diagnostics = allDiagnostics(env);
      expect(diagnostics.filter((event) => event.code === "kick_fetch_route")).toHaveLength(1);
      expect(diagnostics.filter((event) => event.code === "kick_fetch_summary").map((event) => event.data)).toEqual([{ "kick.com.background": 1 }]);
      expect(diagnostics.filter((event) => event.code === "kick_fetch_lifecycle_failed")).toHaveLength(lifecycleFailure ? 1 : 0);
      if (tickProbe) expect(diagnostics.filter((event) => event.code?.startsWith("kick_fetch_")).every((event) => event.platformTickId === 1)).toBe(true);
      expect(env.deps.saveState).toHaveBeenCalledTimes(writes);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter((event) => event.category === "activity" && event.code === "page_context_closed")).toEqual([]);
      expect(JSON.stringify(diagnostics.filter((event) => event.code?.startsWith("kick_fetch_")))).not.toContain("secret");
      env.controller.shutdown();
      vi.useRealTimers();
    });
  });

  it("preserves route transition and lifecycle failure evidence when scheduler publication fails", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      preferKnownChannels: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    const discoveryState = new KickDiscoveryState();
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => {
      const kick = kickAdapter(createKickFetcher({
        routeState: discoveryState.routeDiagnostics,
        background: async (url) => {
          if (url.endsWith("/user")) return { id: 42 };
          throw new KickWafBlockedError("secret");
        },
        pageFetch: async () => ({ data: [] }),
        onPageFallback: () => { throw new Error("secret lifecycle"); },
      }), undefined, undefined, emit, { discoveryState });
      // Simulate a host capability becoming unavailable during reconciliation,
      // after network discovery but before scheduler publication.
      Object.defineProperty(kick, "createDiscoverySignalController", { get: () => { throw new Error("publication failed"); } });
      return {
        adapter: platform === "kick" ? kick : env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      };
    });
    await env.controller.tick(["kick"]);
    const diagnostics = allDiagnostics(env);
    expect(diagnostics.some((event) => event.code === "kick_fetch_route" && event.message.includes("using page tab"))).toBe(true);
    expect(diagnostics.filter((event) => event.code === "kick_fetch_lifecycle_failed").length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.some((event) => event.code === "kick_fetch_summary" && Number(event.data?.["web.kick.com.page"]) >= 2)).toBe(true);
    expect(JSON.stringify(diagnostics.filter((event) => event.code?.startsWith("kick_fetch_")))).not.toContain("secret");
    env.controller.shutdown();
  });

  it("reports bounded complete route counts from fresh Kick adapters across repeated ticks", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      preferKnownChannels: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: Array.from({ length: 50 }, (_, index) => `channel-${index}`) },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
      },
    });
    const discoveryState = new KickDiscoveryState();
    let requests = 0;
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => ({
      adapter: platform === "kick" ? kickAdapter(createKickFetcher({
        routeState: discoveryState.routeDiagnostics,
        background: async (url) => {
          requests += 1;
          if (url.endsWith("/user")) return { id: 42 };
          if (url.includes("/channels/")) return { livestream: null };
          return { data: [] };
        },
        pageFetch: async () => { throw new Error("unexpected fallback"); },
      }), undefined, undefined, emit, { discoveryState }) : env.twitch,
      ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
    }));
    for (let tick = 0; tick < 50; tick += 1) await env.controller.tick(["kick"]);
    const events = env.reportEvents.mock.calls.flatMap(([batch]) => batch);
    const summaries = events.filter((event) => event.category === "diagnostic" && event.code === "kick_fetch_summary") as DiagnosticEvent[];
    expect(requests).toBeGreaterThan(2500);
    expect(summaries.length).toBeGreaterThanOrEqual(50);
    expect(summaries.length).toBeLessThanOrEqual(150);
    const summarized = summaries.reduce((total, event) => total + Object.values(event.data ?? {}).reduce<number>((sum, count) => sum + Number(count), 0), 0);
    expect(summarized).toBe(requests);
    expect(events.filter((event) => event.category === "diagnostic" && event.code === "kick_fetch_route")).toHaveLength(2);
    expect(summaries.every((event) => event.controllerRunId && event.platformTickId)).toBe(true);
    env.controller.shutdown();
  });

  it("publishes one actionable link-required diagnostic while repeated automatic claims are suppressed", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
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
        if (url === "https://web.kick.com/api/v1/drops/campaigns") {
          return {
            data: [{
              id: "kick-campaign",
              name: "Kick campaign",
              status: "active",
              rewards: [{
                id: "kick-reward",
                name: "Reward",
                required_minutes: 1,
              }],
            }],
          };
        }
        if (url === "https://web.kick.com/api/v1/drops/progress") {
          return {
            data: [{
              campaign_id: "kick-campaign",
              progress_units: 2,
              ...(affirmativelyLinked ? { user_app_connected: true } : {}),
            }],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      }) as PageFetcher["fetchJson"],
    };
    const claimState = new KickClaimState();
    env.deps.createAdapter.mockImplementation((platform, emit, settings) => {
      const kick = kickAdapter(fetcher, undefined, undefined, emit, { claimState });
      kick.listCandidateChannels = vi.fn(async () => []);
      return {
        adapter: platform === "kick" ? kick : env.twitch,
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
    const separateAdapter = kickAdapter(fetcher, undefined, undefined, () => {}, { claimState: separateState });
    await separateAdapter.claimReward(campaign("kick", "claimable"), campaign("kick", "claimable").rewards[0]);
    expect(claimPosts).toBe(3);
  });

  it("publishes a farming stop reason when automation is disabled", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
      ...campaign("twitch"),
      url: "https://example.test/campaign",
      rewards: [{ ...reward(), imageUrl: "https://cdn.example.test/reward.png" }],
    }]);
    await env.controller.tick();

    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "farming_stopped",
      data: expect.objectContaining({
        reason: "automation_disabled",
        rewardImageUrl: "https://cdn.example.test/reward.png",
        campaignUrl: "https://example.test/campaign",
      }),
    }));
    expect(env.deps.saveState).toHaveBeenCalledWith(expect.not.objectContaining({ events: expect.anything() }));
  });

  it("publishes an interruption when an idle platform is paused by manual watch", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      pauseOnManualWatch: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
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

  it("reports scheduler diagnostics without consulting host diagnostic settings", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, diagnosticLogging: false }));

    await env.controller.handleMessage({ type: "tickNow" });

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.level === "debug")).toBe(true);
  });

  it("emits reward notifications best-effort when rewards become earned", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }));
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Reward earned",
      message: "Reward from twitch campaign",
    });
  });

  it.each(["claimable", "claimed"] as const)("does not notify for a newly discovered %s reward", async (status) => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: false,
    }));
    env.state.campaigns = { twitch: [], kick: [] };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", status)]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalled();
  });

  it("does not notify again when an earned reward changes from claimable to claimed", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: false,
    }));
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalled();
  });

  it("notifies when a known unearned reward transitions directly to claimed", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }));
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Reward earned",
      message: "Reward from twitch campaign",
    });
  });

  it("emits a notification when a Kick challenge is claimed", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }));
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Challenge reward claimed",
      message: "You won a mythic card from your daily challenge.",
    });
  });

  it("does not emit a challenge notification when reward notifications are off", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: false }));
    env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "mythic", recurrence: "daily" }]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Challenge reward claimed" }),
    );
  });

  it("does not emit disabled reward notifications", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: false }));
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("emits the no-drops-left notification once when entering the exhausted state", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      notifyNoDropsLeft: true,
      platform: { ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true }, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    // A fully claimed campaign is present but has nothing earnable, so the
    // scheduler goes idle into the "no drops left" condition.
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "No drops left" }));
  });

  it("does not re-emit the no-drops-left notification while the exhausted state persists", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      notifyNoDropsLeft: true,
      notifyRewardEarned: false,
      platform: { ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true }, kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false } },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimed")]);

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
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("adapter factory failed");
    });

    await env.controller.tick();

    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "interruption", level: "error" }),
      expect.objectContaining({
        category: "diagnostic",
        level: "error",
        message: expect.stringContaining("adapter factory failed"),
      }),
    ]));
  });
});
