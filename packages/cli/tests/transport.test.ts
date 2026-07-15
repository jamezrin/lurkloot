import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../src/transport";
import { tablessWatchPort } from "../src/transport/common";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";

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
