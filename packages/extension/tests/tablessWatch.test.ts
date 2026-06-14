import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "@stream-autopilot/shared/models";
import { buildMinuteWatchedEvent, buildSpadeInput, gzipBase64 } from "@stream-autopilot/core/twitch/watch";
import { KickWatcher, type WebSocketLike } from "@stream-autopilot/core/kick/watch";

async function gunzipBase64(b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

describe("twitch minute-watched payload", () => {
  it("builds a single minute-watched event with the expected properties", () => {
    const [event] = buildMinuteWatchedEvent({
      broadcastId: "111",
      channelId: "222",
      channelLogin: "creator",
      userId: "333",
      gameId: "444",
      gameName: "Some Game",
      clientTime: "2026-06-02T00:00:00.000Z",
    });

    expect(event.event).toBe("minute-watched");
    expect(event.properties).toMatchObject({
      broadcast_id: "111",
      channel_id: "222",
      channel: "creator",
      user_id: "333",
      game: "Some Game",
      game_id: "444",
      live: true,
      logged_in: true,
      muted: false,
      hidden: false,
      minutes_logged: 1,
      client_time: "2026-06-02T00:00:00.000Z",
    });
  });

  it("gzip+base64 round-trips through the spade input encoding", async () => {
    const input = await buildSpadeInput({
      broadcastId: "111",
      channelId: "222",
      channelLogin: "creator",
      userId: "333",
    });

    expect(input.repository).toBe("twilight");
    expect(input.encoding).toBe("GZIP_B64");

    const decoded = JSON.parse(await gunzipBase64(input.data));
    expect(decoded[0].event).toBe("minute-watched");
    expect(decoded[0].properties.channel).toBe("creator");
  });

  it("gzipBase64 decompresses back to the original string", async () => {
    const original = JSON.stringify({ hello: "world", n: 42 });
    expect(await gunzipBase64(await gzipBase64(original))).toBe(original);
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners: Record<string, Array<(event: unknown) => void>> = {};

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type: "open" | "message" | "close" | "error"): void {
    (this.listeners[type] ?? []).forEach((listener) => listener({}));
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((value) => JSON.parse(value));
  }
}

const kickChannel: ChannelCandidate = {
  platform: "kick",
  username: "creator",
  url: "https://kick.com/creator",
};

describe("kick viewer watcher", () => {
  it("opens the viewer socket and sends a watch event on connect", async () => {
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => 1000,
    });

    await watcher.start(kickChannel, {});
    socket.emit("open");

    const watchEvent = socket.parsed().find((message) => message.type === "user_event");
    expect(watchEvent).toBeDefined();
    expect((watchEvent?.data as { message?: Record<string, unknown> })?.message).toMatchObject({
      name: "tracking.user.watch.livestream",
      channel_id: 123,
      livestream_id: 456,
    });
    expect(socket.parsed().some((message) => message.type === "channel_handshake")).toBe(true);

    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });
    await watcher.stop();
  });

  it("surfaces a one-shot info line when tabless farming becomes active", async () => {
    const socket = new FakeSocket();
    const logs: Array<{ level: string; message: string }> = [];
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 123, livestream: { id: 456, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      log: (level, message) => logs.push({ level, message }),
      now: () => 1000,
    });

    await watcher.start(kickChannel, {});
    socket.emit("open");

    // Exactly one info-level "farming active" line so launch-day verification is
    // legible without the verbose/debug filter.
    const active = logs.filter((entry) => entry.level === "info" && /farming active/i.test(entry.message));
    expect(active).toHaveLength(1);
    await watcher.stop();
  });

  it("reports unhealthy when the viewer token cannot be obtained", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: { id: 2, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: {} } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => new FakeSocket(),
    });

    await watcher.start(kickChannel, {});
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false });
    await watcher.stop();
  });

  it("logs a warning when the viewer WebSocket errors", async () => {
    const socket = new FakeSocket();
    const logs: Array<{ level: string; message: string }> = [];
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: { id: 2, is_live: true } } as unknown;
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      log: (level, message) => logs.push({ level, message }),
    });

    await watcher.start(kickChannel, {});
    socket.emit("open");
    socket.emit("error");

    expect(logs.some((entry) => entry.level === "warn" && /WebSocket error/.test(entry.message))).toBe(true);
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false });
    await watcher.stop();
  });

  it("treats an offline channel as not earning without opening a socket", async () => {
    const createWebSocket = vi.fn(() => new FakeSocket());
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) return { id: 1, livestream: null } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket,
    });

    await watcher.start(kickChannel, {});
    expect(createWebSocket).not.toHaveBeenCalled();
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false, live: false });
    await watcher.stop();
  });

  it("reports unhealthy when a connected Kick stream goes offline", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: null } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: false, live: false });
    await watcher.stop();
  });

  it("reports unhealthy when a connected Kick stream changes category", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 20 }] } } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({
      ok: false,
      live: true,
      message: "Kick channel category no longer matches",
    });
    await watcher.stop();
  });

  it("refreshes the Kick livestream id while connected", async () => {
    let now = 1000;
    const socket = new FakeSocket();
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("/api/v2/channels/")) {
        return fetchJson.mock.calls.filter(([calledUrl]) => String(calledUrl).includes("/api/v2/channels/")).length === 1
          ? { id: 1, livestream: { id: 2, is_live: true, categories: [{ id: 10 }] } } as unknown
          : { id: 1, livestream: { id: 3, is_live: true, categories: [{ id: 10 }] } } as unknown;
      }
      if (url.includes("/viewer/v1/token")) return { data: { token: "tok" } } as unknown;
      throw new Error(`unexpected url ${url}`);
    });

    const watcher = new KickWatcher({
      fetcher: { fetchJson: fetchJson as never },
      createWebSocket: () => socket,
      now: () => now,
    });

    await watcher.start({ ...kickChannel, categoryId: "10" }, {});
    socket.emit("open");

    now += 61_000;
    await expect(watcher.tick({})).resolves.toMatchObject({ ok: true, live: true });

    const watchEvents = socket.parsed().filter((message) => message.type === "user_event");
    expect(watchEvents).toHaveLength(2);
    expect((watchEvents[1].data as { message?: Record<string, unknown> }).message).toMatchObject({
      livestream_id: 3,
    });
    await watcher.stop();
  });
});
