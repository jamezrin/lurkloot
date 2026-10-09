import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchHeartbeatContext, TwitchHeartbeatExchange } from "@lurkloot/core/twitch/heartbeat";
import {
  HLS_POLL_BUDGET_MS,
  HLS_POLL_INTERVAL_MS,
  HLS_TOKEN_RETRY_MAX_MS,
  HLS_TOKEN_RETRY_MS,
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

  it("reacquires an expired playlist after HTTP 401 and resets the cache for a new broadcast", async () => {
    let mediaGets = 0;
    const { strategy, gql } = strategyFor({
      exchange: async (url, init) => {
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        if (init.method === "GET") {
          mediaGets += 1;
          return { status: mediaGets === 2 ? 401 : 200, body: media(SEGMENT_ONE), url };
        }
        return { status: 200, body: "", url };
      },
      fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
      post: async () => ({ status: 204 }),
    });

    await expect(strategy.tick(context("broadcast-1"))).resolves.toEqual({ ok: true, live: true });
    await expect(strategy.tick(context("broadcast-1"))).resolves.toMatchObject({ ok: false, message: "Twitch HLS playlist returned HTTP 401" });
    await expect(strategy.tick(context("broadcast-1"))).resolves.toEqual({ ok: true, live: true });
    await expect(strategy.tick(context("broadcast-2"))).resolves.toEqual({ ok: true, live: true });

    expect(gql).toHaveBeenCalledTimes(3);
  });

  it("treats a fresh playlist that is refused straight away as a failed token request", async () => {
    let clock = 0;
    const { strategy, gql } = strategyFor({
      now: () => clock,
      exchange: async (url, init) => {
        if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
        return { status: 403, body: "", url };
      },
    });

    await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, message: "Twitch HLS playlist returned HTTP 403" });
    clock += 10_000;
    await expect(strategy.tick(context())).resolves.toMatchObject({ message: "Twitch HLS watch is waiting to request a new playback token" });
    expect(gql).toHaveBeenCalledTimes(1);
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

  describe("playback token retries", () => {
    function failingTokenStrategy(clock: { now: number }) {
      let tokenWorks = false;
      const gql = vi.fn(async (operationName: string) => {
        if (operationName !== "PlaybackAccessToken") throw new Error(`unexpected ${operationName}`);
        if (!tokenWorks) throw new Error("failed integrity check");
        return playbackToken();
      });
      const strategy = createHlsHeartbeat({
        gql: gql as never,
        exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 200 })),
        fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
        post: async () => ({ status: 204 }),
        log: () => {},
        now: () => clock.now,
      });
      return { strategy, gql, fixToken: () => { tokenWorks = true; } };
    }

    it("waits before requesting a token again, doubling the wait while it keeps failing", async () => {
      const clock = { now: 0 };
      const { strategy, gql } = failingTokenStrategy(clock);

      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, message: "failed integrity check" });
      clock.now += 10_000;
      await expect(strategy.tick(context())).resolves.toMatchObject({
        ok: false,
        live: true,
        message: "Twitch HLS watch is waiting to request a new playback token",
      });
      expect(gql).toHaveBeenCalledTimes(1);

      clock.now = HLS_TOKEN_RETRY_MS;
      await expect(strategy.tick(context())).resolves.toMatchObject({ ok: false, message: "failed integrity check" });
      expect(gql).toHaveBeenCalledTimes(2);
      clock.now += HLS_TOKEN_RETRY_MS;
      await strategy.tick(context());
      expect(gql).toHaveBeenCalledTimes(2);
      clock.now += HLS_TOKEN_RETRY_MS;
      await strategy.tick(context());
      expect(gql).toHaveBeenCalledTimes(3);
    });

    it("caps the wait and clears it once a watch succeeds", async () => {
      const clock = { now: 0 };
      const { strategy, gql, fixToken } = failingTokenStrategy(clock);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await strategy.tick(context());
        clock.now += HLS_TOKEN_RETRY_MAX_MS;
      }
      expect(gql).toHaveBeenCalledTimes(8);

      fixToken();
      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
      expect(gql).toHaveBeenCalledTimes(9);
    });

    it("lets the poll between health ticks skip quietly while waiting", async () => {
      const clock = { now: 0 };
      const { strategy, gql } = failingTokenStrategy(clock);
      await strategy.tick(context());
      clock.now += 10_000;
      await expect(strategy.sustain?.(context())).resolves.toBeUndefined();
      expect(gql).toHaveBeenCalledTimes(1);
    });

    it("tries again straight away for a new broadcast", async () => {
      const clock = { now: 0 };
      const { strategy, gql } = failingTokenStrategy(clock);
      await strategy.tick(context("broadcast-1"));
      await strategy.tick(context("broadcast-2"));
      expect(gql).toHaveBeenCalledTimes(2);
    });

    it("refreshes an expired playlist without waiting when the last token request succeeded", async () => {
      let mediaStatus = 200;
      const { strategy, gql } = strategyFor({
        now: () => 0,
        exchange: async (url, init) => {
          if (init.method === "GET" && url.startsWith(MASTER_URL)) return { status: 200, body: MASTER, url };
          if (init.method === "GET") return { status: mediaStatus, body: media(SEGMENT_ONE), url };
          return { status: 200, body: "", url };
        },
        fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
        post: async () => ({ status: 204 }),
      });
      await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
      mediaStatus = 403;
      await expect(strategy.sustain?.(context())).resolves.toMatchObject({ ok: false, message: "Twitch HLS playlist returned HTTP 403" });
      mediaStatus = 200;
      await expect(strategy.sustain?.(context())).resolves.toEqual({ ok: true, live: true });
      expect(gql).toHaveBeenCalledTimes(2);
    });
  });

  it("reports a stop that lands while telemetry is in flight", async () => {
    let reached: () => void = () => {};
    const posting = new Promise<void>((resolve) => { reached = resolve; });
    let finish: () => void = () => {};
    const { strategy } = strategyFor({
      exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 200 })),
      fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
      post: async () => {
        reached();
        await new Promise<void>((resolve) => { finish = resolve; });
        return { status: 204 };
      },
    });

    const pending = strategy.tick(context());
    await posting;
    strategy.reset?.();
    finish();
    await expect(pending).resolves.toEqual({ ok: false, live: true, message: "Twitch HLS watch stopped" });
  });

  it("notes a beacon that is refused or fails without failing the watch", async () => {
    const logs: string[] = [];
    let clock = 0;
    let fail = false;
    const { strategy } = strategyFor({
      now: () => clock,
      exchange: exchangeFrom({ media: media(SEGMENT_ONE) }, () => ({ status: 200 })),
      fetchText: async () => '{"spade_url":"https://spade.twitch.tv/track"}',
      post: async () => {
        if (fail) throw new Error("connect failed https://spade.twitch.tv/track?secret=1");
        return { status: 400 };
      },
      log: (_level, message) => logs.push(message),
    });

    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });
    fail = true;
    clock += 60_000;
    await expect(strategy.tick(context())).resolves.toEqual({ ok: true, live: true });

    expect(logs).toContain("Twitch minute-watched beacon returned HTTP 400");
    expect(logs).toContain("Twitch minute-watched beacon failed: network request failed");
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("reports a poll that runs out of budget as a timeout, not a stop", async () => {
    vi.useFakeTimers();
    const { strategy } = strategyFor({
      exchange: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
      }),
    });

    const pending = strategy.tick(context());
    await vi.advanceTimersByTimeAsync(HLS_POLL_BUDGET_MS);
    await expect(pending).resolves.toEqual({ ok: false, live: true, message: "Twitch HLS watch timed out" });
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

  function hlsStrategy() {
    return {
      id: TWITCH_HLS_HEARTBEAT_ID,
      tick: vi.fn(async (_context: TwitchHeartbeatContext) => ({ ok: true, live: true })),
      sustain: vi.fn(async (_context: TwitchHeartbeatContext): Promise<{ ok: boolean; live?: boolean; message?: string } | undefined> => ({ ok: true, live: true })),
      reset: vi.fn(),
    };
  }

  function operations(fetchJson: ReturnType<typeof streamInfo>): string[] {
    return fetchJson.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).operationName);
  }

  it("polls between health ticks with the last tick's context and clears the poll on stop", async () => {
    vi.useFakeTimers();
    const strategy = hlsStrategy();
    const fetchJson = streamInfo();
    const watcher = twitchAdapter({ fetchJson: fetchJson as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: HLS_POLL_INTERVAL_MS,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    // Nothing to poll before a health tick has resolved the broadcast.
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS);
    expect(strategy.sustain).not.toHaveBeenCalled();

    await watcher.tick({ userId: "viewer-id" });
    expect(strategy.tick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS * 3);
    expect(strategy.sustain).toHaveBeenCalledTimes(3);
    expect(strategy.sustain).toHaveBeenLastCalledWith(strategy.tick.mock.calls[0][0]);
    // The polls look nothing up: the one stream lookup is the health tick's.
    expect(operations(fetchJson)).toEqual(["StreamInfo"]);

    await watcher.stop();
    await vi.advanceTimersByTimeAsync(HLS_POLL_INTERVAL_MS * 3);
    expect(strategy.sustain).toHaveBeenCalledTimes(3);
    expect(strategy.reset).toHaveBeenCalled();
  });

  it("stops polling when the health tick finds the channel offline", async () => {
    const strategy = hlsStrategy();
    let live = true;
    const fetchJson = vi.fn(async () => ({
      data: { user: { id: "channel-id", stream: live ? { id: "broadcast-id" } : null } },
    }));
    const watcher = twitchAdapter({ fetchJson: fetchJson as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: 0,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    await watcher.tick({});
    await watcher.sustain?.();
    expect(strategy.sustain).toHaveBeenCalledOnce();

    live = false;
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false, live: false });
    await watcher.sustain?.();
    expect(strategy.sustain).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it("runs its own health tick after a poll in progress instead of reusing its result", async () => {
    const strategy = hlsStrategy();
    let finishPoll: () => void = () => {};
    strategy.sustain.mockImplementationOnce(() => new Promise((resolve) => {
      finishPoll = () => resolve({ ok: false, live: true, message: "Twitch HLS segment returned HTTP 503" });
    }));
    const watcher = twitchAdapter({ fetchJson: streamInfo() as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: 0,
    }).createTablessWatcher();

    await watcher.start(channel, { userId: "viewer-id" });
    await watcher.tick({});
    const poll = watcher.sustain?.();
    const health = watcher.tick({});
    // A second poll while one runs does nothing.
    await watcher.sustain?.();
    expect(strategy.sustain).toHaveBeenCalledOnce();
    expect(strategy.tick).toHaveBeenCalledOnce();

    finishPoll();
    await poll;
    await expect(health).resolves.toEqual({ ok: true, live: true });
    expect(strategy.tick).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("has no between-tick poll for a strategy without one", async () => {
    vi.useFakeTimers();
    const strategy = {
      id: "twitch-heartbeat-spade-v1",
      tick: vi.fn(async () => ({ ok: true, live: true })),
    };
    const watcher = twitchAdapter({ fetchJson: streamInfo() as never }, undefined, {
      heartbeatStrategy: strategy,
      heartbeatPollIntervalMs: HLS_POLL_INTERVAL_MS,
    }).createTablessWatcher();

    expect(watcher.sustain).toBeUndefined();
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
