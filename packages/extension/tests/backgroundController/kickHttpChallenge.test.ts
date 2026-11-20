import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { createKickFetcher } from "@lurkloot/core/kick";
import { fetchKickInBackgroundWith } from "@lurkloot/core/transport";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { kickAdapter } from "../helpers/adapters";
import { farming, harness } from "../helpers/backgroundController";

// A Cloudflare challenge that never clears, on a host whose Kick transport has
// no page fallback (the CLI `http` transport: fetchKickInBackgroundWith behind
// createKickFetcher with no pageFetch). It must reach a steady state that is
// neither a failed sign-in nor a request every tick (#1100).

const cookieApi = {
  cookies: {
    get: async ({ name }: { name: string }) =>
      name === "session_token" ? { value: "sess-token" } : undefined,
  },
};

function stubCloudflareChallenge() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>",
        {
          status: 403,
          headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function headlessKickAdapter() {
  return kickAdapter(
    createKickFetcher({
      background: (url, init) => fetchKickInBackgroundWith(cookieApi, url, init),
    }),
  );
}

const TICK_MS = 5 * 60_000;
const SIX_HOURS_OF_TICKS = (6 * 60 * 60_000) / TICK_MS;

describe("persistent Kick challenge without a page fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps a challenged auth probe unavailable, never signed out, for hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-20T12:00:00.000Z");
    const fetchMock = stubCloudflareChallenge();
    const env = harness(farming(DEFAULT_SETTINGS));
    const real = headlessKickAdapter();
    vi.mocked(env.kick.checkAuthHealth).mockImplementation((signal) =>
      real.checkAuthHealth(signal),
    );

    const statuses = new Set<string>();
    for (let tick = 0; tick < SIX_HOURS_OF_TICKS; tick += 1) {
      await env.controller.tick(["kick"]);
      statuses.add(`${env.state.authHealth.kick.status}/${env.state.authHealth.kick.reasonCode}`);
      vi.advanceTimersByTime(TICK_MS);
    }

    expect([...statuses]).toEqual(["unavailable/waf_challenge"]);
    expect(env.state.sessions.kick).toMatchObject({
      status: "error",
      retryAfter: expect.any(String),
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThan(SIX_HOURS_OF_TICKS / 2);
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.watchTabs.kick.open).not.toHaveBeenCalled();
    const authChanges = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter(
        (event) =>
          event.category === "activity"
          && event.code === "auth_health_changed"
          && event.platform === "kick",
      );
    expect(authChanges).toHaveLength(1);
    expect(authChanges[0]).toMatchObject({
      data: { to: "unavailable", reason: "waf_challenge" },
    });
  });

  it("reports a challenged discovery as a platform API failure, leaving auth healthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-20T12:00:00.000Z");
    const fetchMock = stubCloudflareChallenge();
    const env = harness(farming(DEFAULT_SETTINGS), {
      initialState: {
        ...structuredClone(DEFAULT_STATE),
        authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
      },
    });
    const real = headlessKickAdapter();
    env.kick.refreshCampaigns = vi.fn((session, options) =>
      real.refreshCampaigns(session, options),
    );

    for (let tick = 0; tick < SIX_HOURS_OF_TICKS; tick += 1) {
      await env.controller.tick(["kick"]);
      // Before #1100 the challenge read as authentication_rejected, which the
      // scheduler turns into invalid_credentials and an auth suspension.
      expect(env.state.authHealth.kick.status).toBe("healthy");
      expect(env.state.sessions.kick.reasonCode).not.toBe("authentication_unhealthy");
      vi.advanceTimersByTime(TICK_MS);
    }

    // A failed discovery is retried on a later tick, at most one refresh per
    // tick, and its sustained failure flags critical health for the user.
    const refreshes = vi.mocked(env.kick.refreshCampaigns).mock.calls.length;
    expect(refreshes).toBeGreaterThan(1);
    expect(refreshes).toBeLessThanOrEqual(SIX_HOURS_OF_TICKS);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2 * SIX_HOURS_OF_TICKS);
    expect(env.state.criticalHealth?.kick).toMatchObject({ status: "flagged" });
    expect(env.state.criticalHealth?.kick?.records?.at(-1)).toMatchObject({
      kind: "api_error",
      code: "http_error",
    });
    expect(JSON.stringify(env.state)).not.toContain("Just a moment");
    expect(env.watchTabs.kick.open).not.toHaveBeenCalled();
  });
});
