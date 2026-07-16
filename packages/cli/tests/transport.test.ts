import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../src/transport";
import { tablessWatchPort, withHeartbeatTimeout } from "../src/transport/common";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";

const ENABLED = { twitch: true, kick: true };

afterEach(() => vi.unstubAllGlobals());

describe("createTransport", () => {
  it("builds a disposable http transport with both adapters", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    expect(handle.adapters.twitch.platform).toBe("twitch");
    expect(handle.adapters.kick.platform).toBe("kick");
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it("resolves CLI adapters with the Android Twitch identity", async () => {
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);

    const construction = handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS);

    expect(construction.compatibility.twitch.heartbeat).toBe("twitch-heartbeat-trowel-v1");
    expect(construction.adapters.twitch.compatibility).toEqual(construction.compatibility.twitch);
    expect(construction.adapters.kick.compatibility).toEqual(construction.compatibility.kick);
    await handle.dispose();
  });

  it("shares Kick claim suppression across fresh HTTP adapter constructions", async () => {
    let claimPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return new Response(JSON.stringify({ connect_url: "https://accounts.example/link" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }));
    const handle = await createTransport("http", {}, "/tmp/auth", ENABLED);
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", name: "Reward", status: "claimable" } as DropReward;

    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);
    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);

    expect(claimPosts).toBe(1);
    await handle.dispose();
  });

  it("sends Trowel through the HTTP transport request path", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(url.includes("trowel.twitch.tv") ? null : JSON.stringify({
      data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
    }), { status: url.includes("trowel.twitch.tv") ? 204 : 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const handle = await createTransport("http", { twitch: { authToken: "token" } }, "/tmp/auth", ENABLED);
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(fetchMock).toHaveBeenCalledWith("https://trowel.twitch.tv/track", expect.objectContaining({ method: "POST" }));
    await handle.dispose();
  });

  it("sends custom-client Spade page resolution and beacon through HTTP fetch", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("gql.twitch.tv")) return new Response(JSON.stringify({
        data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://www.twitch.tv/creator") {
        return new Response('<script src="https://static.twitch.tv/config/settings.js"></script>');
      }
      if (url === "https://static.twitch.tv/config/settings.js") {
        return new Response('{"spade_url":"https://spade.twitch.tv/track"}');
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handle = await createTransport("http", {
      twitch: { authToken: "token", clientId: "custom-web-client" },
    }, "/tmp/auth", ENABLED);
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(fetchMock).toHaveBeenCalledWith("https://www.twitch.tv/creator", expect.objectContaining({
      credentials: "include",
      redirect: "error",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://static.twitch.tv/config/settings.js", expect.objectContaining({
      credentials: "include",
      redirect: "error",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://spade.twitch.tv/track", expect.objectContaining({ method: "POST" }));
    await handle.dispose();
  });

  // impersonate and browser are exercised by impersonate.test.ts / browser.test.ts
  // (with cycletls/Playwright handled there, so no real subprocess spawns here).
});

describe("tablessWatchPort", () => {
  it("fails loudly when asked to open a watch tab", () => {
    expect(() => tablessWatchPort.openPinnedMutedTab({ platform: "twitch", username: "x", url: "https://twitch.tv/x" }))
      .toThrow(/Tab-based watch is unavailable/);
  });

  it("treats stopping as a harmless no-op", async () => {
    await expect(tablessWatchPort.stopWatchTab({ platform: "twitch", status: "idle", offlineChecks: 0 })).resolves.toBeUndefined();
  });
});

describe("heartbeat request bounds", () => {
  it("rejects a stalled request after the configured timeout", async () => {
    vi.useFakeTimers();
    const request = withHeartbeatTimeout(() => new Promise<never>(() => {}), undefined, 25);
    const rejection = expect(request).rejects.toThrow("Twitch heartbeat request timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("preserves caller cancellation and its reason", async () => {
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    const request = withHeartbeatTimeout(() => new Promise<never>(() => {}), caller.signal, 10_000);

    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });
});
