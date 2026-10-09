import { afterEach, describe, expect, it, vi } from "vitest";
import { twitchHeartbeatExchange } from "../src/core/twitchHeartbeatTransport";

describe("Twitch heartbeat exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a playlist body and the response URL", async () => {
    const text = vi.fn(async () => "#EXTM3U");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      url: "https://video-weaver.fra05.hls.ttvnw.net/playlist.m3u8",
      headers: { get: () => null },
      text,
    })));

    await expect(twitchHeartbeatExchange("https://usher.ttvnw.net/api/channel/hls/creator.m3u8", {
      method: "GET",
    })).resolves.toEqual({
      status: 200,
      body: "#EXTM3U",
      url: "https://video-weaver.fra05.hls.ttvnw.net/playlist.m3u8",
    });
    expect(text).toHaveBeenCalledOnce();
  });

  it("forwards a manual redirect without reading the body", async () => {
    const text = vi.fn(async () => { throw new Error("body was read"); });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 302,
      url: "https://usher.ttvnw.net/api/channel/hls/creator.m3u8",
      headers: { get: (name: string) => name === "location" ? " https://video-weaver.fra05.hls.ttvnw.net/next.m3u8 " : null },
      text,
    })));

    await expect(twitchHeartbeatExchange("https://usher.ttvnw.net/api/channel/hls/creator.m3u8", {
      method: "GET",
      redirect: "manual",
    })).resolves.toEqual({
      status: 302,
      body: "",
      url: "https://usher.ttvnw.net/api/channel/hls/creator.m3u8",
      location: "https://video-weaver.fra05.hls.ttvnw.net/next.m3u8",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("does not read a segment body on HEAD", async () => {
    const text = vi.fn(async () => { throw new Error("body was read"); });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      url: "https://video-weaver.fra05.hls.ttvnw.net/seg.ts",
      headers: { get: () => null },
      text,
    })));

    await expect(twitchHeartbeatExchange("https://video-weaver.fra05.hls.ttvnw.net/seg.ts", {
      method: "HEAD",
    })).resolves.toEqual({
      status: 200,
      body: "",
      url: "https://video-weaver.fra05.hls.ttvnw.net/seg.ts",
    });
    expect(text).not.toHaveBeenCalled();
  });
});
