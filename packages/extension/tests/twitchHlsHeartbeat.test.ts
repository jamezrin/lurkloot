import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchHeartbeatContext, TwitchHeartbeatExchange } from "@lurkloot/core/twitch/heartbeat";
import {
  HLS_POLL_BUDGET_MS,
  HLS_POLL_INTERVAL_MS,
  TWITCH_HLS_HEARTBEAT_ID,
  createHlsHeartbeat,
  createTwitchHeartbeat,
  playlistUrls,
} from "@lurkloot/core/twitch/heartbeat";
import type { ChannelCandidate } from "@lurkloot/shared/models";
import { twitchAdapter } from "./helpers/adapters";

const MASTER_URL = "https://usher.ttvnw.net/api/channel/hls/creator.m3u8";
const VARIANT_URL = "https://video-weaver.fra05.hls.ttvnw.net/playlist.m3u8?token=signed-variant";
const SEGMENT_ONE = "https://video-weaver.fra05.hls.ttvnw.net/seg-1.ts?token=signed-one";
const SEGMENT_TWO = "https://video-weaver.fra05.hls.ttvnw.net/seg-2.ts?token=signed-two";
const SEGMENT_THREE = "https://video-weaver.fra05.hls.ttvnw.net/seg-3.ts?token=signed-three";

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100
${VARIANT_URL}
`;

function media(...segments: string[]): string {
  return ["#EXTM3U", ...segments.flatMap((segment) => ["#EXTINF:2.000,", segment])].join("\n");
}

function context(broadcastId = "broadcast-1"): TwitchHeartbeatContext {
  return {
    channel: {
      platform: "twitch",
      username: "Creator",
      url: "https://www.twitch.tv/creator",
    },
    broadcastId,
    channelId: "channel-id",
    userId: "viewer-id",
    gameId: "game-id",
    gameName: "Game",
  };
}

function playbackToken() {
  return { data: { streamPlaybackAccessToken: { value: "token-value", signature: "sig-value" } } };
}

function expectDirectPlaylistFetch(init: RequestInit): void {
  expect(init.cache).toBe("no-store");
  expect(init.credentials).toBe("omit");
  expect(init.redirect).toBe("manual");
  expect(init.referrerPolicy).toBe("no-referrer");
}

describe("Twitch HLS playlists", () => {
  it("resolves a relative quality URI and ignores trailing comments", () => {
    const urls = playlistUrls(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1
audio/index.m3u8
# a trailing comment
`, "https://usher.ttvnw.net/api/channel/hls/creator.m3u8", "master");

    expect(urls).toEqual(["https://usher.ttvnw.net/api/channel/hls/audio/index.m3u8"]);
  });

  it("rejects a master whose URI is not a playlist, including a dangling tag", () => {
    const base = "https://usher.ttvnw.net/api/channel/hls/creator.m3u8";
    expect(playlistUrls("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://video-weaver.fra05.hls.ttvnw.net/seg.ts\n", base, "master")).toEqual([]);
    expect(playlistUrls("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n", base, "master")).toEqual([]);
    expect(playlistUrls("#EXTM3U\nhttps://video-weaver.fra05.hls.ttvnw.net/index.m3u8\n", base, "master")).toEqual([]);
    expect(playlistUrls("not a playlist", base, "master")).toEqual([]);
  });

  it("resolves relative media URIs and does not request key or map URIs", () => {
    const urls = playlistUrls(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
seg-1.ts
#EXTINF:2.0,
https://video-weaver.fra05.hls.ttvnw.net/seg-2.ts
`, VARIANT_URL, "media");

    expect(urls).toEqual([
      "https://video-weaver.fra05.hls.ttvnw.net/seg-1.ts",
      "https://video-weaver.fra05.hls.ttvnw.net/seg-2.ts",
    ]);
  });

  it("rejects a media URI on an unsafe host", () => {
    expect(playlistUrls(`#EXTM3U
#EXTINF:2.0,
https://evil.example/seg.ts
`, VARIANT_URL, "media")).toEqual([]);
    expect(playlistUrls(`#EXTM3U
#EXTINF:2.0,
https://user:pass@video-weaver.fra05.hls.ttvnw.net/seg.ts
`, VARIANT_URL, "media")).toEqual([]);
  });
});

describe("Twitch HLS heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function strategyFor(options: {
    exchange: TwitchHeartbeatExchange;
    now?: () => number;
    fetchText?: (url: string) => Promise<string>;
    post?: (url: string, init: RequestInit) => Promise<{ status: number }>;
    log?: (level: string, message: string) => void;
  }) {
    const gql = vi.fn(async (operationName: string) => {
      if (operationName === "PlaybackAccessToken") return playbackToken();
      throw new Error(`unexpected ${operationName}`);
    });
    const strategy = createHlsHeartbeat({
      gql: gql as never,
      exchange: options.exchange,
      fetchText: options.fetchText ?? (async () => { throw new Error("spade page was not expected"); }),
      post: options.post ?? (async () => { throw new Error("spade beacon was not expected"); }),
      log: options.log ?? (() => {}),
      now: options.now,
    });
    return { strategy, gql };
  }

  function exchangeFrom(playlists: { master?: string; media: string }, head: (url: string) => { status: number } | Promise<{ status: number }>): TwitchHeartbeatExchange {
    return async (url, init) => {
      expectDirectPlaylistFetch(init);
      if (init.method === "GET" && url.startsWith(MASTER_URL)) {
        return { status: 200, body: playlists.master ?? MASTER, url };
      }
      if (init.method === "GET") return { status: 200, body: playlists.media, url };
      const response = await head(url);
      return { status: response.status, body: "", url };
    };
  }

  it("HEADs each new segment once across overlapping playlists", async () => {
    const heads: string[] = [];
    let playlist = media(SEGMENT_ONE, SEGMENT_TWO);
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        expectDirectPlaylistFetch(init);
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        if (init.method === "GET") return { status: 200, body: playlist, url };
        heads.push(url);
        return { status: 200, body: "", url };
      },
      fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
      post: async () => ({ status: 204 }),
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    playlist = media(SEGMENT_TWO, SEGMENT_THREE);
    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

    expect(heads).toEqual([SEGMENT_ONE, SEGMENT_TWO, SEGMENT_THREE]);
  });

  it("retries a failed segment and does not repeat a successful sibling", async () => {
    const heads: string[] = [];
    const { strategy } = strategyFor({
      exchange: exchangeFrom({ media: media(SEGMENT_ONE, SEGMENT_TWO) }, (url) => {
        heads.push(url);
        return { status: url === SEGMENT_ONE && heads.filter((item) => item === SEGMENT_ONE).length === 1 ? 503 : 200 };
      }),
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

    expect(heads).toEqual([SEGMENT_ONE, SEGMENT_TWO, SEGMENT_ONE]);
  });

  it("does not request media bodies from a malformed master", async () => {
    const calls: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        calls.push(`${init.method} ${new URL(url).pathname}`);
        return { status: 200, body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://video-weaver.fra05.hls.ttvnw.net/seg.ts\n", url };
      },
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, message: "Twitch did not return a playback playlist" });
    expect(calls).toEqual(["GET /api/channel/hls/creator.m3u8"]);
  });

  it("reacquires a playlist after HTTP 401 and resets the cache for a new broadcast", async () => {
    const { strategy, gql } = strategyFor({
      exchange: async (url, init) => {
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        if (init.method === "GET") {
          return { status: gql.mock.calls.length === 1 ? 401 : 200, body: media(SEGMENT_ONE), url };
        }
        return { status: 200, body: "", url };
      },
    });

    await expect(strategy.tick(context("broadcast-1"))).resolves.toMatchObject({ ok: false, message: "Twitch HLS playlist returned HTTP 401" });
    await expect(strategy.tick(context("broadcast-1"))).resolves.toEqual({ ok: true, live: true });
    await expect(strategy.tick(context("broadcast-2"))).resolves.toEqual({ ok: true, live: true });

    expect(gql).toHaveBeenCalledTimes(3);
  });

  it("sends auxiliary telemetry on the first poll and again after 59 seconds", async () => {
    let clock = 1_000;
    const posts: number[] = [];
    const { strategy } = strategyFor({
      now: () => clock,
      exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 200 })),
      fetchText: async (url) => {
        if (url === "https://www.twitch.tv/creator") return '<script src="https://static.twitch.tv/config/settings.js"></script>';
        if (url === "https://static.twitch.tv/config/settings.js") return '{"spade_url":"https://spade.twitch.tv/track"}';
        throw new Error(url);
      },
      post: async () => {
        posts.push(clock);
        return { status: 500 };
      },
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    clock += 10_000;
    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    clock += 49_000;
    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

    expect(posts).toEqual([1_000, 60_000]);
  });

  it("does not send telemetry when the playlist fails", async () => {
    const post = vi.fn(async () => ({ status: 204 }));
    const { strategy } = strategyFor({
      exchange: async (url) => ({ status: 500, body: "", url }),
      post,
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false });
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a response that lands outside the video CDN", async () => {
    const heads: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        if (init.method === "HEAD") heads.push(url);
        return { status: 200, body: MASTER, url: "https://evil.example/playlist.m3u8?token=secret" };
      },
    });

    const result = await strategy.tick(context());
    expect(result).toMatchObject({ ok: false, message: "Twitch HLS response came from an unexpected host" });
    expect(result.message).not.toContain("secret");
    expect(heads).toEqual([]);
  });

  it("drops signed URLs from transport failures", async () => {
    const { strategy } = strategyFor({
      exchange: async () => {
        throw new Error("connect failed https://video-weaver.fra05.hls.ttvnw.net/seg.ts?token=secret");
      },
    });

    const result = await strategy.tick(context());
    expect(result.message).toBe("Twitch HLS watch failed");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("ttvnw");
  });

  it("stops an in-flight segment request when reset", async () => {
    let release: (error: Error) => void = () => {};
    const reached = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        if (init.method === "GET") return { status: 200, body: media(SEGMENT_ONE), url };
        await reached;
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    const pending = strategy.tick(context());
    await release(new Error("unused"));
    strategy.reset?.();
    await expect(pending).resolves.toEqual({ ok: false, live: true, message: "Twitch HLS watch stopped" });
  });

  it("fails the poll when every new segment request fails", async () => {
    const { strategy } = strategyFor({
      exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 503 })),
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({
      ok: false,
      message: "Twitch HLS segment returned HTTP 503",
    });
  });

  it("keeps going to the live edge when an earlier segment request fails", async () => {
    const heads: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        expectDirectPlaylistFetch(init);
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        if (init.method === "GET") return { status: 200, body: media(SEGMENT_ONE, SEGMENT_TWO), url };
        heads.push(url);
        if (url === SEGMENT_ONE) throw new Error("Twitch heartbeat request failed for video-weaver.fra05.hls.ttvnw.net: network request failed");
        return { status: 200, body: "", url };
      },
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    expect(heads).toEqual([SEGMENT_ONE, SEGMENT_TWO]);
  });

  it("follows a playlist redirect only onto the video CDN", async () => {
    const redirected = "https://video-weaver.fra05.hls.ttvnw.net/master.m3u8";
    const calls: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        expectDirectPlaylistFetch(init);
        calls.push(url);
        if (url.startsWith(MASTER_URL)) return { status: 302, body: "", location: redirected };
        if (url === redirected) {
          return { status: 200, body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\naudio/index.m3u8\n", url };
        }
        if (init.method === "GET") return { status: 200, body: media(SEGMENT_ONE), url };
        return { status: 200, body: "", url };
      },
      fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
      post: async () => ({ status: 204 }),
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    expect(calls.map((url) => new URL(url).hostname)).toEqual([
      "usher.ttvnw.net",
      "video-weaver.fra05.hls.ttvnw.net",
      "video-weaver.fra05.hls.ttvnw.net",
      "video-weaver.fra05.hls.ttvnw.net",
    ]);
    expect(calls[1]).toBe(redirected);
    expect(calls[2]).toBe("https://video-weaver.fra05.hls.ttvnw.net/audio/index.m3u8");
  });

  it("does not request a redirect target outside the video CDN", async () => {
    const calls: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url, init) => {
        expectDirectPlaylistFetch(init);
        calls.push(url);
        return { status: 302, body: "", location: "https://evil.example/playlist.m3u8?token=secret" };
      },
    });

    const result = await strategy.tick(context());
    expect(result).toMatchObject({ ok: false, message: "Twitch HLS response came from an unexpected host" });
    expect(result.message).not.toContain("secret");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).hostname).toBe("usher.ttvnw.net");
  });

  it("does not follow an opaque redirect", async () => {
    const calls: string[] = [];
    const { strategy } = strategyFor({
      exchange: async (url) => {
        calls.push(url);
        return { status: 0, body: "", url };
      },
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({
      ok: false,
      message: "Twitch HLS redirect could not be verified",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects a completed response that does not name its host", async () => {
    const { strategy } = strategyFor({
      exchange: async () => ({ status: 200, body: MASTER, url: "" }),
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({
      ok: false,
      message: "Twitch HLS response came from an unexpected host",
    });
  });

  it("keeps a successful segment watch when telemetry outlasts the playlist budget", async () => {
    vi.useFakeTimers();
    const { strategy } = strategyFor({
      exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 200 })),
      fetchText: async () => {
        await new Promise((resolve) => setTimeout(resolve, HLS_POLL_BUDGET_MS + 1_000));
        return '{"spade_url":"https://spade.twitch.tv/track"}';
      },
      post: async () => ({ status: 204 }),
    });

    const pending = strategy.tick(context());
    await vi.advanceTimersByTimeAsync(HLS_POLL_BUDGET_MS + 1_000);
    await expect(pending).resolves.toEqual({ ok: true, live: true });
  });

  it("requires the playlist transport at the factory boundary", () => {
    expect(() => createTwitchHeartbeat("twitch-heartbeat-hls-v1", {
      gql: vi.fn() as never,
      emit: vi.fn(),
      log: vi.fn(),
      identity: "web",
      fetchText: vi.fn(),
      post: vi.fn(),
    })).toThrow(/playlist request/);
  });
});

describe("Twitch HLS watcher cadence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const channel: ChannelCandidate = {
    platform: "twitch",
    username: "creator",
    url: "https://www.twitch.tv/creator",
  };

  function streamInfo() {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const operationName = JSON.parse(String(init?.body)).operationName;
      if (operationName === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id", game: { id: "game", name: "Game" } } } } };
      }
      throw new Error(operationName);
    });
  }

  it("polls on the HLS interval and clears it on stop", async () => {
    vi.useFakeTimers();
    const strategy = {
      id: TWITCH_HLS_HEARTBEAT_ID,
      tick: vi.fn(async () => ({ ok: true, live: true })),
      reset: vi.fn(),
    };
    const watcher = twitchAdapter({ fetchJson: streamInfo() as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: HLS_POLL_INTERVAL_MS,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS);
    expect(strategy.tick).toHaveBeenCalledOnce();

    await watcher.stop();
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS * 3);
    expect(strategy.tick).toHaveBeenCalledOnce();
    expect(strategy.reset).toHaveBeenCalled();
  });

  it("does not arm the interval for a Spade strategy", async () => {
    vi.useFakeTimers();
    const strategy = {
      id: "twitch-heartbeat-spade-v1",
      tick: vi.fn(async () => ({ ok: true, live: true })),
    };
    const watcher = twitchAdapter({ fetchJson: streamInfo() as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: HLS_POLL_INTERVAL_MS,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS * 2);
    expect(strategy.tick).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("drops the rest of a segment batch when the channel changes", async () => {
    const heads: string[] = [];
    let continueSecond: () => void = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      continueSecond = resolve;
    });
    const exchange: TwitchHeartbeatExchange = async (url, init) => {
      if (init.method === "GET" && url.includes("usher.ttvnw.net")) return { status: 200, body: MASTER, url };
      if (init.method === "GET") return { status: 200, body: media(SEGMENT_ONE, SEGMENT_TWO), url };
      heads.push(url);
      if (heads.length === 1) return { status: 200, body: "", url };
      continueSecond();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.operationName === "StreamInfo") {
        return { data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } } };
      }
      if (body.operationName === "PlaybackAccessToken") return playbackToken();
      throw new Error(body.operationName);
    });
    const watcher = twitchAdapter({ fetchJson: fetchJson as never }, undefined, {
      heartbeatExchange: exchange,
      heartbeatFetchText: async () => { throw new Error("no page"); },
      heartbeatPost: async () => ({ status: 204 }),
      heartbeatPollIntervalMs: 0,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    const first = watcher.tick({});
    await secondStarted;
    await watcher.start({ ...channel, username: "other", url: "https://www.twitch.tv/other" }, { userId: "viewer-id" });

    await expect(first).resolves.toEqual({ ok: false, live: true, message: "Twitch HLS watch stopped" });
    expect(heads).toEqual([SEGMENT_ONE, SEGMENT_TWO]);
    await watcher.stop();
  });
});
