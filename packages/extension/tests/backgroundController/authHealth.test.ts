import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAuthHealth } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { createKickFetcher } from "@lurkloot/core/kick";
import { kickAdapter } from "../helpers/adapters";
import { fetchKickInBackgroundWith, KickWafBlockedError } from "@lurkloot/core/transport";
import { channel, deferred, farming, harness } from "../helpers/backgroundController";
import {
  fetchJsonInPageWithBrowser,
  pageFetchJson,
  type BrowserTabApi,
} from "../../src/core/browserTabs";
import { KickPageContextFallback } from "../../src/core/kickPageDocument";

// Auth health probes, refreshes and invalidation.

const KICK_PAGE_ORIGIN = "https://kick.com/drops/inventory";

// Kick behind an HTTP challenge from the service worker, wired to the real
// page-context fallback with a browser whose tabs stay open until removed.
// `page.works` decides whether the in-page fetch is challenged too.
function challengedKickPageContext() {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("<!doctype html><title>Just a moment…</title>private-body", { status: 403 }),
    ),
  );
  vi.stubGlobal("document", { cookie: "", contentType: "text/html" });
  const env = harness(farming(DEFAULT_SETTINGS));
  const userTabs: { id: number; url: string }[] = [];
  const openTabs = new Set<number>();
  let nextTabId = 40;
  const create = vi.fn(async () => {
    nextTabId += 1;
    openTabs.add(nextTabId);
    return { id: nextTabId };
  });
  const remove = vi.fn(async (tabId: number) => {
    openTabs.delete(tabId);
  });
  const get = vi.fn(async (tabId: number) =>
    openTabs.has(tabId) ? { id: tabId, url: KICK_PAGE_ORIGIN, status: "complete" } : undefined,
  );
  const page = { works: false };
  const executeScript = vi.fn<
    NonNullable<NonNullable<BrowserTabApi["scripting"]>["executeScript"]>
  >(async (details) => {
    const { func, args } = details as { func: (...args: never[]) => unknown; args?: never[] };
    return [
      {
        result:
          func === pageFetchJson && page.works
            ? { __lurklootPageFetch: true, ok: true, data: { id: 42 } }
            : await func(...(args ?? [])),
      },
    ];
  });
  const browser = {
    tabs: {
      query: vi.fn(async () => userTabs),
      create,
      remove,
      get,
      update: vi.fn(async () => ({})),
    },
    scripting: { executeScript },
  } as unknown as BrowserTabApi;
  const fallback = new KickPageContextFallback();
  const kick = kickAdapter(
    createKickFetcher({
      background: (url, init) => fetchKickInBackgroundWith({}, url, init),
      pageFetch: (url, init, error) =>
        fallback.fetch(url, error, (options) =>
          fetchJsonInPageWithBrowser(
            env.tabRegistry,
            browser,
            KICK_PAGE_ORIGIN,
            url,
            init,
            options,
          ),
        ),
      onBackgroundSuccess: (host) => fallback.recordBackgroundSuccess(host),
    }),
  );
  vi.mocked(env.kick.checkAuthHealth).mockImplementation((signal) => kick.checkAuthHealth(signal));
  return {
    env,
    create,
    remove,
    openTabs,
    userTabs,
    page,
    pageFetches: () =>
      executeScript.mock.calls.filter(
        ([details]) => (details as { func?: unknown }).func === pageFetchJson,
      ).length,
    tick: () => env.controller.tick(["kick"], "alarm"),
  };
}

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("backs off a Kick HTML challenge at the identity endpoint and resumes after a healthy probe", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () =>
        new Response("<!doctype html><title>Just a moment…</title>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const env = harness(farming(DEFAULT_SETTINGS));
    const kick = kickAdapter(
      createKickFetcher({
        background: (url, init) => fetchKickInBackgroundWith({}, url, init),
      }),
    );
    vi.mocked(env.kick.checkAuthHealth).mockImplementation((signal) =>
      kick.checkAuthHealth(signal),
    );
    const tick = () => env.controller.tick(["kick"], "alarm");

    await tick();
    expect(env.state.authHealth.kick).toMatchObject({
      status: "unavailable",
      reasonCode: "request_challenged",
    });
    expect(env.state.sessions.kick).toMatchObject({
      status: "error",
      reasonCode: "platform_error",
      errorChecks: 1,
    });
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    // The critical-failure prompt gets the challenge code from the scheduler.
    expect(env.state.criticalHealth?.kick?.records?.at(-1)).toMatchObject({
      kind: "api_error",
      code: "request_challenged",
      detail: "Identity request challenged",
    });
    const firstRetry = env.state.sessions.kick.retryAfter;

    vi.advanceTimersByTime(30_000);
    await tick();
    expect(fetch).toHaveBeenCalledOnce();
    expect(env.state.sessions.kick).toMatchObject({
      reasonCode: "platform_backoff",
      retryAfter: firstRetry,
      errorChecks: 1,
    });

    vi.advanceTimersByTime(30_000);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(env.state.sessions.kick).toMatchObject({ reasonCode: "platform_error", errorChecks: 2 });
    expect(Date.parse(env.state.sessions.kick.retryAfter ?? "") - Date.now()).toBe(120_000);

    fetch.mockResolvedValueOnce(Response.json({ id: 42 }));
    vi.advanceTimersByTime(120_000);
    await tick();
    expect(env.state.authHealth.kick.status).toBe("healthy");
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.state.sessions.kick.retryAfter).toBeUndefined();
  });

  it("opens one Kick page context when only the service worker is challenged and recovers", async () => {
    const kick = challengedKickPageContext();
    kick.page.works = true;

    await kick.tick();

    expect(kick.env.state.authHealth.kick.status).toBe("healthy");
    expect(kick.create).toHaveBeenCalledOnce();
    expect(kick.remove).not.toHaveBeenCalled();
  });

  it("reuses one Kick page context across hours of challenges on both sides, then recovers", async () => {
    const kick = challengedKickPageContext();

    for (let minute = 0; minute < 180; minute += 1) {
      await kick.tick();
      vi.advanceTimersByTime(60_000);
    }
    expect(kick.create).toHaveBeenCalledOnce();
    expect(kick.remove).not.toHaveBeenCalled();
    expect(kick.pageFetches()).toBeGreaterThan(5);
    expect(kick.env.state.authHealth.kick).toMatchObject({
      status: "unavailable",
      reasonCode: "request_challenged",
    });
    expect(JSON.stringify(kick.env.reportEvents.mock.calls)).not.toContain("private-body");

    kick.page.works = true;
    vi.setSystemTime(Date.parse(kick.env.state.sessions.kick.retryAfter ?? ""));
    await kick.tick();
    expect(kick.env.state.authHealth.kick.status).toBe("healthy");
    expect(kick.create).toHaveBeenCalledOnce();
  });

  it("opens no Kick page context after the page itself was challenged, but reuses a user tab", async () => {
    const kick = challengedKickPageContext();
    await kick.tick();
    expect(kick.create).toHaveBeenCalledOnce();
    // The user closes the challenged context. Another tab would repeat the
    // blocked request, so the fallback only reuses what is already open.
    kick.openTabs.clear();

    for (let minute = 0; minute < 180; minute += 1) {
      vi.advanceTimersByTime(60_000);
      await kick.tick();
    }
    expect(kick.create).toHaveBeenCalledOnce();
    expect(kick.env.state.authHealth.kick).toMatchObject({
      status: "unavailable",
      reasonCode: "request_challenged",
    });

    const fetchesBefore = kick.pageFetches();
    kick.userTabs.push({ id: 7, url: KICK_PAGE_ORIGIN });
    vi.setSystemTime(Date.parse(kick.env.state.sessions.kick.retryAfter ?? ""));
    await kick.tick();
    expect(kick.pageFetches()).toBe(fetchesBefore + 1);
    expect(kick.env.state.authHealth.kick.status).toBe("unavailable");

    kick.page.works = true;
    vi.setSystemTime(Date.parse(kick.env.state.sessions.kick.retryAfter ?? ""));
    await kick.tick();
    expect(kick.env.state.authHealth.kick.status).toBe("healthy");
    expect(kick.create).toHaveBeenCalledOnce();
  });

  it("starts enabled auth probes concurrently and persists each before scheduler work", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchHealth = deferred<PlatformAuthHealth>();
    const kickHealth = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(twitchHealth.promise);
    vi.mocked(env.kick.checkAuthHealth).mockReturnValue(kickHealth.promise);

    const ticking = env.controller.tick();
    await vi.waitFor(() => {
      expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    });

    kickHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
    });
    await vi.waitFor(() => expect(env.state.authHealth.kick.status).toBe("healthy"));

    expect(env.state.authHealth.twitch.status).toBe("checking");
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();

    twitchHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:01.000Z",
    });
    await ticking;

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("waits for started auth probes before reporting a sibling setup failure", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(farming(DEFAULT_SETTINGS), { authProbeTimeoutMs: 25 });
      const oldTwitchHealth = deferred<PlatformAuthHealth>();
      vi.mocked(env.twitch.checkAuthHealth)
        .mockReturnValueOnce(oldTwitchHealth.promise)
        .mockResolvedValueOnce({
          status: "healthy",
          checkedAt: "2026-07-26T12:00:01.000Z",
        });
      vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
        if (platform === "kick") {
          throw new Error("kick adapter setup failed");
        }
        return {
          adapter: env.twitch,
          ...resolveCompatibility(settings.compatibility, {
            host: "extension",
            twitchIdentity: "web",
          }),
        };
      });

      let tickSettled = false;
      const ticking = env.controller.tick().then(() => {
        tickSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const settledBeforeDeadline = tickSettled;
      const refreshing = ticking.then(() => env.controller.checkAuthHealth("twitch"));

      await vi.advanceTimersByTimeAsync(25);
      await refreshing;

      expect(env.state.authHealth.twitch).toMatchObject({
        status: "healthy",
        checkedAt: "2026-07-26T12:00:01.000Z",
      });
      expect(settledBeforeDeadline).toBe(false);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
        expect.objectContaining({
          category: "activity",
          code: "interruption",
          data: expect.objectContaining({ detail: "kick adapter setup failed" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and aborts a stalled auth probe at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(farming(DEFAULT_SETTINGS), { authProbeTimeoutMs: 25 });
      let signal: AbortSignal | undefined;
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation((nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      });

      const checking = env.controller.checkAuthHealth("twitch");
      await vi.advanceTimersByTimeAsync(24);
      expect(env.state.authHealth.twitch.status).toBe("checking");
      await vi.advanceTimersByTimeAsync(1);
      await checking;

      expect(signal?.aborted).toBe(true);
      expect(env.state.authHealth.twitch).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
        message: { key: "authNetworkUnavailable" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown preempts a stalled credential availability check", async () => {
    const checkCredentialAvailability = vi.fn(async () => new Promise<never>(() => undefined));
    const env = harness(farming(DEFAULT_SETTINGS), {
      authProbeTimeoutMs: 60_000,
      checkCredentialAvailability,
    });

    const ticking = env.controller.tick();
    await vi.waitFor(() => {
      expect(checkCredentialAvailability).toHaveBeenCalled();
    });

    env.controller.shutdown();

    await expect(ticking).resolves.toEqual({});
  });

  it("does not start a Kick page fallback after the auth deadline aborts background fetch", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(farming(DEFAULT_SETTINGS), { authProbeTimeoutMs: 25 });
      let backgroundStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        backgroundStarted = resolve;
      });
      const pageFetch = vi.fn(async () => ({ id: 42 }));
      const kick = kickAdapter(
        createKickFetcher({
          background: async (_url, init) => {
            backgroundStarted();
            await new Promise<void>((resolve) => {
              init?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new KickWafBlockedError("background rejected after deadline");
          },
          pageFetch,
        }),
      );
      vi.mocked(env.kick.checkAuthHealth).mockImplementation((signal) =>
        kick.checkAuthHealth(signal),
      );

      const checking = env.controller.checkAuthHealth("kick");
      await started;
      await vi.advanceTimersByTimeAsync(25);
      await checking;
      await vi.advanceTimersByTimeAsync(0);

      expect(pageFetch).not.toHaveBeenCalled();
      expect(env.state.authHealth.kick).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay a resolved platform while another probe awaits its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(farming(DEFAULT_SETTINGS), { authProbeTimeoutMs: 25 });
      vi.mocked(env.twitch.checkAuthHealth).mockImplementation(() => new Promise(() => undefined));
      vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
        status: "healthy",
        checkedAt: "2026-07-26T12:00:00.000Z",
      });

      let settled = false;
      const ticking = env.controller.tick().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(env.state.authHealth.kick.status).toBe("healthy");
      expect(env.state.authHealth.twitch.status).toBe("checking");
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(24);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await ticking;

      expect(settled).toBe(true);
      expect(env.state.authHealth.twitch).toMatchObject({
        status: "unavailable",
        reasonCode: "network_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles once when a timed out auth adapter rejects later", async () => {
    vi.useFakeTimers();
    try {
      const env = harness(farming(DEFAULT_SETTINGS), { authProbeTimeoutMs: 25 });
      const health = deferred<PlatformAuthHealth>();
      vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(health.promise);

      const checking = env.controller.checkAuthHealth("twitch");
      await vi.advanceTimersByTimeAsync(25);
      await checking;
      const saveCount = env.deps.saveState.mock.calls.length;
      const transitionCount = env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter(
          (event) => event.category === "activity" && event.code === "auth_health_changed",
        ).length;

      health.reject(new Error("late adapter failure"));
      await vi.advanceTimersByTimeAsync(0);

      expect(env.deps.saveState).toHaveBeenCalledTimes(saveCount);
      expect(
        env.reportEvents.mock.calls
          .flatMap(([events]) => events)
          .filter((event) => event.category === "activity" && event.code === "auth_health_changed"),
      ).toHaveLength(transitionCount);
      expect(env.state.authHealth.twitch.reasonCode).toBe("network_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges a completed auth probe into state written while the probe was pending", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const health = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValue(health.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());

    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    await env.controller.handleMessage(
      {
        type: "playbackTelemetry",
        platform: "kick",
        telemetry: {
          videoCount: 1,
          mutedVideoCount: 1,
          unmutedVideoCount: 0,
          playingVideoCount: 1,
          blockedPlaybackCount: 0,
          documentHidden: true,
          readyState: 4,
          currentTime: 12,
          duration: 1200,
        },
      },
      { tab: { id: 20 } },
    );
    health.resolve({ status: "healthy", checkedAt: "2026-07-26T12:00:01.000Z" });
    await checking;

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.sessions.kick.playback?.videoCount).toBe(1);
  });

  it("keeps a newer same-platform refresh when an older tick probe settles last", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    const older = deferred<PlatformAuthHealth>();
    const newer = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(1));
    const cookieRefresh = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2));

    newer.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
    await cookieRefresh;
    older.resolve({
      status: "invalid_credentials",
      checkedAt: "2026-07-26T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await ticking;

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-26T12:05:00.000Z",
      message: { key: "authHealthy" },
    });
  });

  it("keeps invalidation checking when it supersedes an in-flight probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const older = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValueOnce(older.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());
    await env.controller.invalidateAuthHealth("twitch");

    older.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
      message: { key: "authHealthy" },
    });
    await checking;

    expect(env.state.authHealth.twitch).toEqual({ status: "checking" });
  });

  it("supersedes an in-flight probe without putting a newly disabled platform in checking", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.authHealth = {
      ...env.state.authHealth,
      twitch: {
        status: "healthy",
        checkedAt: "2026-07-26T12:00:00.000Z",
        message: { key: "authHealthy" },
      },
    };
    const older = deferred<PlatformAuthHealth>();
    vi.mocked(env.twitch.checkAuthHealth).mockReturnValueOnce(older.promise);

    const checking = env.controller.checkAuthHealth("twitch");
    await vi.waitFor(() => expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce());
    await env.deps.saveSettings({
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, enabled: false },
      },
    });
    await env.controller.invalidateAuthHealth("twitch");

    older.resolve({
      status: "invalid_credentials",
      checkedAt: "2026-07-26T12:01:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await checking;

    expect(env.state.authHealth.twitch).toEqual({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
      message: { key: "authHealthy" },
    });
  });

  it("terminalizes direct adapter setup failures with platform context", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("twitch adapter setup failed");
    });

    const error = await env.controller.checkAuthHealth("twitch").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      platform: "twitch",
      message: "twitch adapter setup failed",
    });
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    });
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "activity",
        code: "auth_health_changed",
        platform: "twitch",
        data: expect.objectContaining({ to: "unavailable" }),
      }),
    );
  });

  it("surfaces sibling auth persistence failure alongside adapter setup failure", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const kickHealth = deferred<PlatformAuthHealth>();
    vi.mocked(env.kick.checkAuthHealth).mockReturnValue(kickHealth.promise);
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      if (platform === "twitch") {
        throw new Error("twitch adapter setup failed");
      }
      return {
        adapter: env.kick,
        ...resolveCompatibility(settings.compatibility, {
          host: "extension",
          twitchIdentity: "web",
        }),
      };
    });
    const persist = env.deps.saveState.getMockImplementation();
    if (!persist) throw new Error("Expected harness state persistence");
    env.deps.saveState.mockImplementation(async (state) => {
      if (state.authHealth.kick.status === "healthy") {
        throw new Error("kick auth persistence failed");
      }
      await persist(state);
    });

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
    kickHealth.resolve({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
    });
    const error = await ticking.catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining({
        message: "kick auth persistence failed",
      }),
    );
    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "activity",
        code: "interruption",
        platform: "twitch",
        data: expect.objectContaining({ detail: "twitch adapter setup failed" }),
      }),
    );
  });

  it("isolates a consistently failing Kick constructor from Twitch auth health", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("combined construction reached failing Kick adapter");
    });
    vi.mocked(env.deps.createAdapter).mockImplementation((platform, emit, settings) => {
      if (platform === "kick") throw new Error("kick adapter setup failed");
      return {
        adapter: env.twitch,
        ...resolveCompatibility(settings.compatibility, {
          host: "extension",
          twitchIdentity: "web",
        }),
      };
    });

    await env.controller.tick();

    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.authHealth.kick).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const interruptions = published.filter(
      (event) => event.category === "activity" && event.code === "interruption",
    );
    expect(interruptions).toEqual([expect.objectContaining({ platform: "kick" })]);
    expect(
      published.filter(
        (event) =>
          event.category === "diagnostic"
          && event.platform === "kick"
          && event.message.includes("kick adapter setup failed"),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "interruption",
        mirroredActivity: true,
        message: "Farming interrupted: reason=platform_error (kick adapter setup failed)",
      }),
    ]);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("terminalizes startup adapter setup failure instead of leaving checking", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("combined startup construction failed");
    });
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("twitch startup adapter failed");
    });

    // Startup now runs a tick (the platform is enabled, and auto-start is on),
    // and a tick absorbs adapter setup failures into a reported interruption
    // rather than rethrowing. What matters is the same: the platform lands on a
    // terminal auth status instead of being stranded in "checking".
    await env.controller.handleStartup().catch(() => undefined);

    expect(env.state.authHealth.twitch).toMatchObject({
      status: "unavailable",
      reasonCode: "platform_unavailable",
    });
  });

  it("reports missing credentials without calling the platform probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "missing" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.twitch).toEqual(
      expect.objectContaining({
        status: "missing_credentials",
        reasonCode: "credentials_missing",
      }),
    );
  });

  it("reports credential lookup failure without calling the platform probe", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "unavailable" }),
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(
      expect.objectContaining({
        status: "unavailable",
        reasonCode: "credential_lookup_failed",
      }),
    );
  });

  it("continues to the authenticated probe when credentials are available", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    await env.controller.checkAuthHealth("twitch");

    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
  });

  it("blocks startup account work when credentials are missing without disabling the platform", async () => {
    const env = harness(
      {
        ...DEFAULT_SETTINGS,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
        },
      },
      {
        checkCredentialAvailability: async () => ({ status: "missing" }),
      },
    );

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
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
    const env = harness(
      {
        ...DEFAULT_SETTINGS,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
        },
      },
      {
        checkCredentialAvailability: async () => ({ status: "available" }),
      },
    );
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
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(
      env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.category === "activity" && event.code === "auth_health_changed"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ to: "invalid_credentials" }) }),
        expect.objectContaining({ data: expect.objectContaining({ to: "healthy" }) }),
      ]),
    );
  });

  it("publishes authentication transitions when diagnostic logging is disabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, diagnosticLogging: false }));
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "activity",
        code: "auth_health_changed",
        platform: "kick",
        data: expect.objectContaining({ to: "blocked" }),
      }),
    );
  });

  it('does not strand the popup on "checking" when the credential probe throws', async () => {
    const env = harness(
      {
        ...DEFAULT_SETTINGS,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
        },
      },
      {
        checkCredentialAvailability: async () => {
          throw new Error("cookie read failed");
        },
      },
    );

    await env.controller.tickAndHandOff(["twitch"]);

    // A transient failure reading the session cookies must not roll the whole
    // tick back and leave auth health pinned on its prior "checking" value —
    // that is what keeps the popup stuck on "Checking your signed-in session…".
    expect(env.state.authHealth.twitch.status).not.toBe("checking");
    expect(env.state.authHealth.twitch).toMatchObject({ status: "unavailable" });
  });

  it("preserves a healthy auth-health probe when a later scheduler step throws", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, watchlistChannels: [] },
      },
    });
    // The probe resolves healthy, but reconciling the tabless watcher (which
    // runs after the probe, once the scheduler has decided to watch) throws.
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => {
      throw new Error("tabless watcher boom");
    };
    expect(env.state.authHealth.twitch.status).toBe("checking");

    await env.controller.tickAndHandOff(["twitch"]);

    // The tick rolled back, but the resolved auth health must survive it —
    // otherwise the popup snaps back to "Checking your signed-in session…".
    expect(env.twitch.checkAuthHealth).toHaveBeenCalled();
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({ category: "activity", code: "interruption" }),
    );
  });

  it("reports authentication as the reason farming stopped after logout", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
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

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "activity",
        code: "farming_stopped",
        platform: "twitch",
        data: expect.objectContaining({ reason: "authentication_unhealthy" }),
      }),
    );
  });

  it("recovers Twitch authentication health after login without changing enabled settings", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), {
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
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValueOnce({
      status: "healthy",
      checkedAt: "2026-07-22T12:00:00.000Z",
    });
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
    expect(env.reportEvents).toHaveBeenCalledWith([
      {
        category: "activity",
        code: "auth_health_changed",
        level: "info",
        platform: "twitch",
        data: { from: "healthy", to: "checking" },
        emittedAt: expect.any(String),
        // No farming session was opened in this harness (no startup).
        sessionId: null,
      },
      {
        category: "diagnostic",
        code: "auth_health_changed",
        level: "info",
        platform: "twitch",
        mirroredActivity: true,
        message: "twitch authentication health changed from healthy to checking",
        controllerRunId: expect.any(String),
        data: { from: "healthy", to: "checking" },
        emittedAt: expect.any(String),
      },
    ]);

    env.reportEvents.mockClear();
    await env.controller.invalidateAuthHealth("twitch");
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("checks and persists authentication health for only the requested platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValueOnce({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "safe-ref" } },
    });

    await env.controller.checkAuthHealth("kick");

    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.state.authHealth.kick).toEqual(
      expect.objectContaining({
        status: "blocked",
        reasonCode: "security_policy_blocked",
      }),
    );
    expect(env.reportEvents).toHaveBeenCalledWith([
      {
        category: "activity",
        code: "auth_health_changed",
        level: "error",
        platform: "kick",
        data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
        emittedAt: expect.any(String),
        // No farming session was opened in this harness (no startup).
        sessionId: null,
      },
      {
        category: "diagnostic",
        code: "auth_health_changed",
        level: "error",
        platform: "kick",
        mirroredActivity: true,
        message:
          "kick authentication health changed from checking to blocked: reason=security_policy_blocked",
        controllerRunId: expect.any(String),
        data: { from: "checking", to: "blocked", reason: "security_policy_blocked" },
        emittedAt: expect.any(String),
      },
    ]);
  });

  it("stores timestamp-only auth refreshes without repeating activity", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
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
    const env = harness(farming(DEFAULT_SETTINGS));
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
});
