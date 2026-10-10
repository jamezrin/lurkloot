import { describe, expect, it, vi } from "vitest";
import { KickChatPresenceClient, kickChatChannels } from "@lurkloot/core/kick/chatPresence";
import { kickRealtimeNegotiation, type KickRealtimeConnection, type KickRealtimeEndpoint, type KickRealtimeStatus } from "@lurkloot/core/kick/realtime";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { kickAdapter } from "./helpers/adapters";

class FakeConnection {
  readonly subscriptions: string[] = [];
  readonly calls: string[] = [];
  readonly confirmed = new Set<string>();
  realtime: KickRealtimeStatus = { state: "connected", provider: "centrifugo" };
  started: Array<KickRealtimeEndpoint | undefined> = [];
  stopped = 0;
  clientIdentity() { return "client-1"; }
  start(endpoint?: KickRealtimeEndpoint) { this.started.push(endpoint); }
  subscribe(channel: string) { this.subscriptions.push(channel); this.calls.push(`+${channel}`); }
  unsubscribe(channel: string) { this.subscriptions.splice(this.subscriptions.indexOf(channel), 1); this.calls.push(`-${channel}`); this.confirmed.delete(channel); }
  isSubscribed(channel: string) { return this.confirmed.has(channel); }
  status() { return this.realtime; }
  async stop() { this.stopped += 1; }
  drainEvents() { return []; }
}

const ROOMS: Record<string, { id: number; chatroom: { id: number } }> = {
  xqc: { id: 676, chatroom: { id: 668 } },
  adinross: { id: 900, chatroom: { id: 901 } },
};
const CHAT_ENDPOINT = { data: { connections: [{ provider: "centrifugo", credentials: { url: "wss://realtime.us-east-1.platform.kick.com/connection/websocket" } }] } };

function setup() {
  const connection = new FakeConnection();
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const getJson = vi.fn(async (url: string): Promise<unknown> => ROOMS[decodeURIComponent(url.split("/").at(-1)!)] ?? {});
  const postJson = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => CHAT_ENDPOINT);
  const client = new KickChatPresenceClient({
    connection: connection as unknown as KickRealtimeConnection,
    getJson,
    postJson,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
  });
  return { client, connection, getJson, postJson, timers, live: () => timers.filter((timer) => !timer.cleared) };
}

describe("Kick chat presence", () => {
  it("joins as the web client does: room lookup, chat connection, five chat channels", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    expect(s.getJson).toHaveBeenCalledWith("https://kick.com/api/v2/channels/xqc");
    expect(s.postJson).toHaveBeenCalledWith("https://web.kick.com/api/v1/realtime/channels/676/chat/connection", kickRealtimeNegotiation("client-1"));
    expect(s.connection.started).toEqual([{ provider: "centrifugo", url: "wss://realtime.us-east-1.platform.kick.com/connection/websocket" }]);
    expect(s.connection.subscriptions).toEqual(["channel_676", "channel.676", "chatroom_668", "chatrooms.668", "chatrooms.668.v2"]);
    expect(kickChatChannels({ channelId: "676", chatroomId: "668" })).toEqual(s.connection.subscriptions);
  });

  it("reports joining until the chat channel is confirmed", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    expect(s.client.status()).toEqual({ state: "joining", channel: "xqc" });
    s.connection.confirmed.add("chatrooms.668.v2");
    expect(s.client.status()).toEqual({ state: "joined", channel: "xqc" });
    expect(s.client.drainEvents()).toContainEqual(expect.objectContaining({ message: "Kick chat presence joined xqc" }));
  });

  it("switches by subscribing the new channels before leaving the old ones", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    s.connection.calls.length = 0;
    await s.client.follow({ username: "adinross" });
    const firstLeave = s.connection.calls.findIndex((call) => call.startsWith("-"));
    expect(s.connection.calls.slice(0, firstLeave).every((call) => call.startsWith("+"))).toBe(true);
    expect(s.connection.subscriptions).toEqual(kickChatChannels({ channelId: "900", chatroomId: "901" }));
  });

  it("leaves every chat channel when the target goes away", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    await s.client.follow(undefined);
    expect(s.connection.subscriptions).toEqual([]);
    expect(s.client.status()).toEqual({ state: "left" });
  });

  it("closes the realtime connection on stop", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    await s.client.stop();
    expect(s.connection.stopped).toBe(1);
    expect(s.connection.subscriptions).toEqual([]);
  });

  it("retries a failed join with backoff, and warns once", async () => {
    const s = setup();
    s.getJson.mockRejectedValue(new Error("HTTP 500"));
    await s.client.follow({ username: "xqc" });
    expect(s.client.status()).toEqual({ state: "error", channel: "xqc" });
    const pending = s.live().at(-1)!;
    pending.cleared = true;
    pending.callback();
    await Promise.resolve(); await Promise.resolve();
    expect(s.live().map((timer) => timer.delayMs)).toEqual([2_000]);
    const warnings = s.client.drainEvents().filter((event) => "level" in event && event.level === "warn");
    expect(warnings).toHaveLength(1);
  });

  it("blocks without retrying when Kick rejects the session", async () => {
    const s = setup();
    s.postJson.mockRejectedValue(new SafeFetchError({ kind: "authentication_rejected", status: 401 }));
    await s.client.follow({ username: "xqc" });
    expect(s.client.status()).toEqual({ state: "blocked", channel: "xqc", reason: "auth" });
    expect(s.live()).toEqual([]);
  });

  it("passes on a blocked realtime connection", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    s.connection.realtime = { state: "blocked", reason: "unsupported-provider" };
    expect(s.client.status()).toEqual({ state: "blocked", channel: "xqc", reason: "unsupported-provider" });
  });

  it("fails a channel Kick names no chatroom for", async () => {
    const s = setup();
    await s.client.follow({ username: "ghost" });
    expect(s.client.status().state).toBe("error");
    expect(s.connection.subscriptions).toEqual([]);
  });

  it("drops a lookup a newer follow overtook", async () => {
    const s = setup();
    let release!: (value: unknown) => void;
    s.getJson.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = s.client.follow({ username: "xqc" });
    await s.client.follow({ username: "adinross" });
    release(ROOMS.xqc);
    await first;
    expect(s.connection.subscriptions).toEqual(kickChatChannels({ channelId: "900", chatroomId: "901" }));
  });

  it("never calls a chat send endpoint", async () => {
    const s = setup();
    await s.client.follow({ username: "xqc" });
    await s.client.follow({ username: "adinross" });
    await s.client.follow(undefined);
    for (const [url] of s.postJson.mock.calls) expect(url).toMatch(/\/chat\/connection$/);
  });
});

describe("Kick chat presence adapter factory", () => {
  const fetcher = { fetchJson: async <T,>(): Promise<T> => ({}) as T };

  it("offers presence only on a host that opens kick.com-origin sockets", () => {
    // The plain worker socket is refused by Kick's realtime server.
    expect(kickAdapter(fetcher, () => { throw new Error("unused"); }).createChatPresenceClient).toBeUndefined();
    const client = kickAdapter(fetcher, undefined, undefined, { realtimeWebSocketFactory: () => { throw new Error("unused"); } }).createChatPresenceClient?.();
    expect(client).toBeInstanceOf(KickChatPresenceClient);
  });

  // Presence is tabless: its Kick calls must never open a page-context tab.
  it("makes its Kick calls through the realtime fetcher when the host gives one", async () => {
    const pageCapable = { fetchJson: vi.fn(async (): Promise<never> => { throw new Error("would open a tab"); }) };
    const background = {
      fetchJson: vi.fn(async (url: string): Promise<unknown> => url.includes("/api/v2/channels/") ? ROOMS.xqc : CHAT_ENDPOINT),
    };
    const client = kickAdapter(pageCapable as never, undefined, undefined, {
      realtimeFetcher: background as never,
      realtimeWebSocketFactory: () => ({ readyState: 0, send() {}, close() {}, addEventListener() {} }),
    }).createChatPresenceClient!();
    await client.follow({ username: "xqc" });
    expect(pageCapable.fetchJson).not.toHaveBeenCalled();
    expect(background.fetchJson.mock.calls.map(([url]) => url)).toEqual([
      "https://kick.com/api/v2/channels/xqc",
      "https://web.kick.com/api/v1/realtime/channels/676/chat/connection",
      // The realtime connection mints its token through it too.
      "https://web.kick.com/api/v1/realtime/auth/connection",
    ]);
    await client.stop();
  });

  it("negotiates and joins through the Kick fetcher", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const routed = {
      fetchJson: async <T,>(url: string, init?: RequestInit): Promise<T> => {
        calls.push({ url, method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (url.includes("/api/v2/channels/")) return ROOMS.xqc as T;
        return CHAT_ENDPOINT as T;
      },
    };
    const client = kickAdapter(routed, undefined, undefined, { realtimeWebSocketFactory: () => ({ readyState: 0, send() {}, close() {}, addEventListener() {} }) }).createChatPresenceClient!();
    await client.follow({ username: "xqc" });
    expect(calls[0]).toEqual({ url: "https://kick.com/api/v2/channels/xqc" });
    expect(calls[1]).toMatchObject({ url: "https://web.kick.com/api/v1/realtime/channels/676/chat/connection", method: "POST" });
    await client.stop();
  });
});
