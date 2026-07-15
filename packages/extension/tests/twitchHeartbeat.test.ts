import { describe, expect, it, vi } from "vitest";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { TwitchHeartbeatStrategy } from "@lurkloot/core/twitch/heartbeat";
import { createSpadeHeartbeat, createTrowelHeartbeat, isAllowedTwitchUrl } from "@lurkloot/core/twitch/heartbeat";

describe("Twitch heartbeat strategies", () => {
  it("delegates resolved stream and viewer identifiers to the injected strategy", async () => {
    const strategy: TwitchHeartbeatStrategy = {
      id: "test-heartbeat",
      tick: vi.fn(async () => ({ ok: true, live: true })),
    };
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      const operationName = JSON.parse(String(init?.body)).operationName;
      if (operationName === "StreamInfo") {
        return {
          data: {
            user: {
              id: "channel-id",
              stream: { id: "broadcast-id", game: { id: "game-id", name: "Game Name" } },
            },
          },
        };
      }
      throw new Error(`unexpected operation ${operationName}`);
    });
    const adapter = new TwitchAdapter(
      { fetchJson: fetchJson as never },
      undefined,
      undefined,
      { heartbeatStrategy: strategy },
    );
    const watcher = adapter.createTablessWatcher();
    const channel = {
      platform: "twitch" as const,
      username: "creator",
      url: "https://www.twitch.tv/creator",
    };

    await watcher.start(channel, { userId: "viewer-id" });
    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(strategy.tick).toHaveBeenCalledOnce();
    expect(strategy.tick).toHaveBeenCalledWith({
      channel,
      broadcastId: "broadcast-id",
      channelId: "channel-id",
      userId: "viewer-id",
      gameId: "game-id",
      gameName: "Game Name",
    });
  });

  describe("Spade v1", () => {
    const context = (username = "Creator") => ({
      channel: {
        platform: "twitch" as const,
        username,
        url: `https://www.twitch.tv/${username}`,
      },
      broadcastId: "broadcast-id",
      channelId: "channel-id",
      userId: "viewer-id",
      gameId: "game-id",
      gameName: "Game Name",
    });

    it.each([
      "http://twitch.tv/beacon",
      "https://twitch.tv.example.com/beacon",
      "https://twitch.tv@evil.example/beacon",
      "https://evil.example/?next=https://twitch.tv/beacon",
      "not a url",
    ])("rejects deceptive or non-HTTPS Twitch URLs: %s", (url) => {
      expect(isAllowedTwitchUrl(url)).toBe(false);
    });

    it.each([
      "https://twitch.tv/beacon",
      "https://spade.twitch.tv/beacon",
      "https://WWW.TWITCH.TV/channel",
    ])("accepts HTTPS Twitch-owned URLs: %s", (url) => {
      expect(isAllowedTwitchUrl(url)).toBe(true);
    });

    it("posts an inline spade_url as form-urlencoded plain base64 and expects 204", async () => {
      const fetchText = vi.fn(async () => '<script>window.__twilightSettings={"spade_url":"https://spade.twitch.tv/track"}</script>');
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

      expect(fetchText).toHaveBeenCalledWith("https://www.twitch.tv/Creator", expect.objectContaining({ credentials: "include" }));
      expect(post).toHaveBeenCalledOnce();
      const [url, init] = post.mock.calls[0];
      expect(url).toBe("https://spade.twitch.tv/track");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const encoded = new URLSearchParams(String(init.body)).get("data");
      expect(encoded).not.toBeNull();
      expect(JSON.parse(atob(encoded!))).toMatchObject([{
        event: "minute-watched",
        properties: { channel: "Creator", broadcast_id: "broadcast-id", user_id: "viewer-id" },
      }]);
    });

    it("falls back to a Twitch-owned settings bundle containing beacon_url", async () => {
      const fetchText = vi.fn(async (url: string) => url.includes("/settings.")
        ? 'window.settings={"beacon_url":"https://beacon.twitch.tv/collect"}'
        : '<script src="https://assets.twitch.tv/config/settings.abcd.js"></script>');
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: true });

      expect(fetchText).toHaveBeenNthCalledWith(2, "https://assets.twitch.tv/config/settings.abcd.js", expect.objectContaining({ credentials: "include" }));
      expect(post).toHaveBeenCalledWith("https://beacon.twitch.tv/collect", expect.anything());
    });

    it("forbids redirects on authenticated page, settings, and beacon requests", async () => {
      const fetchText = vi.fn(async (url: string) => url.includes("/settings.")
        ? 'window.settings={"beacon_url":"https://beacon.twitch.tv/collect"}'
        : '<script src="https://assets.twitch.tv/config/settings.abcd.js"></script>');
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

      expect(fetchText).toHaveBeenNthCalledWith(1, "https://www.twitch.tv/Creator", expect.objectContaining({
        credentials: "include",
        redirect: "error",
      }));
      expect(fetchText).toHaveBeenNthCalledWith(2, "https://assets.twitch.tv/config/settings.abcd.js", expect.objectContaining({
        credentials: "include",
        redirect: "error",
      }));
      expect(post).toHaveBeenCalledWith("https://beacon.twitch.tv/collect", expect.objectContaining({
        credentials: "include",
        redirect: "error",
      }));
    });

    it("does not treat redirect errors as successful heartbeats", async () => {
      const fetchText = vi.fn(async () => '{"spade_url":"https://spade.twitch.tv/redirect"}');
      const post = vi.fn<(url: string, init: RequestInit) => Promise<{ status: number }>>()
        .mockRejectedValue(new TypeError("redirect mode is set to error"));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, live: true });

      expect(post).toHaveBeenCalledTimes(2);
      expect(fetchText).toHaveBeenCalledTimes(2);
    });

    it("caches destinations per normalized channel login", async () => {
      const fetchText = vi.fn(async (url: string) => `{"spade_url":"https://spade.twitch.tv/${url.toLowerCase().includes("other") ? "other" : "creator"}"}`);
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await strategy.tick(context("Creator"));
      await strategy.tick(context(" creator "));
      await strategy.tick(context("Other"));

      expect(fetchText).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map(([url]) => url)).toEqual([
        "https://spade.twitch.tv/creator",
        "https://spade.twitch.tv/creator",
        "https://spade.twitch.tv/other",
      ]);
    });

    it("evicts a failed destination, resolves fresh, and retries exactly once", async () => {
      const fetchText = vi.fn()
        .mockResolvedValueOnce('{"spade_url":"https://spade.twitch.tv/stale"}')
        .mockResolvedValueOnce('{"spade_url":"https://spade.twitch.tv/fresh"}');
      const post = vi.fn<(url: string, init: RequestInit) => Promise<{ status: number }>>()
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 204 });
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
      expect(fetchText).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map(([url]) => url)).toEqual([
        "https://spade.twitch.tv/stale",
        "https://spade.twitch.tv/fresh",
      ]);
    });

    it("refreshes and retries exactly once when the first post rejects", async () => {
      const fetchText = vi.fn()
        .mockResolvedValueOnce('{"spade_url":"https://spade.twitch.tv/stale"}')
        .mockResolvedValueOnce('{"spade_url":"https://spade.twitch.tv/fresh"}');
      const post = vi.fn<(url: string, init: RequestInit) => Promise<{ status: number }>>()
        .mockRejectedValueOnce(new Error("network failure"))
        .mockResolvedValueOnce({ status: 204 });
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
      expect(fetchText).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
    });

    it("validates settings bundles and beacons before authenticated requests", async () => {
      const settingsFetch = vi.fn(async () => '<script src="https://evil.example/settings.js"></script>');
      const settingsPost = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const settingsStrategy = createSpadeHeartbeat({ fetchText: settingsFetch, post: settingsPost });

      await expect(settingsStrategy.tick(context())).resolves.toMatchObject({ ok: false });
      expect(settingsFetch).toHaveBeenCalledTimes(1);
      expect(settingsPost).not.toHaveBeenCalled();

      const beaconFetch = vi.fn(async () => '{"spade_url":"https://twitch.tv@evil.example/beacon"}');
      const beaconPost = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 204 }));
      const beaconStrategy = createSpadeHeartbeat({ fetchText: beaconFetch, post: beaconPost });

      await expect(beaconStrategy.tick(context())).resolves.toMatchObject({ ok: false });
      expect(beaconPost).not.toHaveBeenCalled();

      const channelFetch = vi.fn(async () => '{"spade_url":"https://spade.twitch.tv/beacon"}');
      const channelStrategy = createSpadeHeartbeat({ fetchText: channelFetch, post: beaconPost });
      const deceptiveChannel = context();
      deceptiveChannel.channel.url = "https://twitch.tv@evil.example/Creator";

      await expect(channelStrategy.tick(deceptiveChannel)).resolves.toMatchObject({ ok: false });
      expect(channelFetch).not.toHaveBeenCalled();
    });

    it("reports failure after one retry and leaves the failed destination evicted", async () => {
      const fetchText = vi.fn(async () => '{"spade_url":"https://spade.twitch.tv/fail"}');
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 500 }));
      const strategy = createSpadeHeartbeat({ fetchText, post });

      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, live: true });
      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, live: true });

      expect(post).toHaveBeenCalledTimes(4);
      expect(fetchText).toHaveBeenCalledTimes(4);
    });
  });

  describe("Trowel v1", () => {
    const context = {
      channel: { platform: "twitch" as const, username: "Creator", url: "https://www.twitch.tv/Creator" },
      broadcastId: "broadcast-id",
      channelId: "channel-id",
      userId: "viewer-id",
      gameId: "game-id",
      gameName: "Game Name",
    };

    it("posts a standard-base64 event array as raw text/plain to the fixed endpoint", async () => {
      const post = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 202 }));
      const strategy = createTrowelHeartbeat({ identity: "android", post });

      await expect(strategy.tick(context)).resolves.toEqual({ ok: true, live: true });

      expect(post).toHaveBeenCalledOnce();
      const [url, init] = post.mock.calls[0];
      expect(url).toBe("https://trowel.twitch.tv/track");
      expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "text/plain" } });
      expect(String(init.body)).not.toMatch(/[\-_]/);
      expect(JSON.parse(atob(String(init.body)))).toMatchObject([{
        event: "minute-watched",
        properties: { channel: "Creator", broadcast_id: "broadcast-id", user_id: "viewer-id" },
      }]);
    });

    it.each([200, 204, 299])("accepts HTTP %s", async (status) => {
      const strategy = createTrowelHeartbeat({ identity: "android", post: async () => ({ status }) });
      await expect(strategy.tick(context)).resolves.toEqual({ ok: true, live: true });
    });

    it.each([199, 300, 500])("reports HTTP %s as unhealthy", async (status) => {
      const strategy = createTrowelHeartbeat({ identity: "android", post: async () => ({ status }) });
      await expect(strategy.tick(context)).resolves.toMatchObject({ ok: false, live: true });
    });

    it("reports transport rejection as unhealthy", async () => {
      const strategy = createTrowelHeartbeat({
        identity: "android",
        post: async () => { throw new Error("proxy unavailable"); },
      });
      await expect(strategy.tick(context)).resolves.toMatchObject({ ok: false, live: true, message: "proxy unavailable" });
    });

    it("rejects construction for a non-Android identity", () => {
      expect(() => createTrowelHeartbeat({ identity: "web", post: async () => ({ status: 204 }) }))
        .toThrow(/Android identity/);
    });
  });
});
