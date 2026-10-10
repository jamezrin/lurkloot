import { describe, expect, it, vi } from "vitest";
import {
  KICK_REALTIME_AUTH_URL,
  KICK_REALTIME_CONNECTION_URL,
  KickRealtimeConnection,
  kickRealtimeNegotiation,
  parseKickRealtimeEndpoint,
} from "@lurkloot/core/kick/realtime";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  open(): void { this.readyState = 1; for (const listener of this.listeners.open ?? []) listener({}); }
  message(data: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  remoteClose(code?: number): void { this.readyState = 3; for (const listener of this.listeners.close ?? []) listener({ code }); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>); }
}

// Timers run only when a test fires them, newest last.
function manualTimers() {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { cleared: boolean }).cleared = true; },
    live: () => timers.filter((timer) => !timer.cleared),
    fire(delayMs: number) {
      const timer = timers.find((candidate) => !candidate.cleared && candidate.delayMs === delayMs);
      if (!timer) throw new Error(`no live timer of ${delayMs} ms (live: ${timers.filter((t) => !t.cleared).map((t) => t.delayMs).join(", ")})`);
      timer.cleared = true;
      timer.callback();
    },
  };
}

const CENTRIFUGO = { data: { connections: [{ provider: "centrifugo", credentials: { url: "wss://realtime.us-west-2.platform.kick.com/connection/websocket" } }], mode: "websocket" } };
const PUSHER = { data: { connections: [{ provider: "pusher", credentials: { app_key: "abc123", cluster: "us2" } }] } };
const TOKEN = "header.payload.signature";

function setup(negotiation: unknown = CENTRIFUGO) {
  const sockets: FakeSocket[] = [];
  const timers = manualTimers();
  let tokens = 0;
  const postJson = vi.fn(async (url: string, _body: unknown): Promise<unknown> => {
    if (url === KICK_REALTIME_CONNECTION_URL) return negotiation;
    if (url === KICK_REALTIME_AUTH_URL) return { data: { token: `${TOKEN}-${++tokens}` } };
    throw new Error(`unexpected ${url}`);
  });
  const onStatusChange = vi.fn();
  const connection = new KickRealtimeConnection({
    createWebSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    postJson,
    onStatusChange,
    randomId: () => "client-1",
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const socket = () => sockets.at(-1)!;
  return { connection, sockets, socket, timers, postJson, onStatusChange };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

async function connectedCentrifugo(reply: Record<string, unknown> = { client: "c", version: "6.9.6", ping: 25, pong: true }) {
  const s = setup();
  s.connection.start();
  await settle();
  s.socket().open();
  const connect = s.socket().frames()[0] as { id: number };
  s.socket().message({ id: connect.id, connect: reply });
  return s;
}

describe("Kick realtime negotiation", () => {
  it("sends the web client's negotiation body", () => {
    expect(kickRealtimeNegotiation("client-1")).toEqual({
      client: { id: "client-1", type: "web" },
      capabilities: { accepted_providers: [{ provider: "pusher" }, { provider: "centrifugo" }] },
    });
  });

  it("picks the first implemented provider and builds its URL", () => {
    expect(parseKickRealtimeEndpoint(CENTRIFUGO)).toEqual({ provider: "centrifugo", url: "wss://realtime.us-west-2.platform.kick.com/connection/websocket" });
    expect(parseKickRealtimeEndpoint(PUSHER)).toEqual({ provider: "pusher", url: "wss://ws-us2.pusher.com/app/abc123?protocol=7&client=js&version=8.4.0&flash=false" });
    expect(parseKickRealtimeEndpoint({ data: { connections: [{ provider: "ably", credentials: {} }, ...PUSHER.data.connections] } })?.provider).toBe("pusher");
  });

  it.each([
    { name: "no connections", body: { data: { connections: [] } } },
    { name: "an unknown provider", body: { data: { connections: [{ provider: "ably", credentials: { url: "wss://x" } }] } } },
    { name: "a non-wss Centrifugo URL", body: { data: { connections: [{ provider: "centrifugo", credentials: { url: "http://x" } }] } } },
    { name: "a malformed Pusher key", body: { data: { connections: [{ provider: "pusher", credentials: { app_key: "a/b" } }] } } },
  ])("finds no endpoint in $name", ({ body }) => {
    expect(parseKickRealtimeEndpoint(body)).toBeUndefined();
  });
});

describe("Kick realtime over Centrifugo", () => {
  it("negotiates, mints a token and connects as the web client does", async () => {
    const s = setup();
    s.connection.start();
    await settle();
    expect(s.postJson.mock.calls).toEqual([
      [KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation("client-1")],
      [KICK_REALTIME_AUTH_URL, { client_id: "client-1" }],
    ]);
    expect(s.socket().url).toBe("wss://realtime.us-west-2.platform.kick.com/connection/websocket");
    s.socket().open();
    expect(s.socket().frames()).toEqual([{ connect: { token: `${TOKEN}-1`, name: "js" }, id: 1 }]);
    expect(s.connection.status()).toEqual({ state: "connecting", provider: "centrifugo" });
  });

  it("negotiates as the client a caller already named", async () => {
    let ids = 0;
    const s = setup();
    const connection = new KickRealtimeConnection({ createWebSocket: () => new FakeSocket("x"), postJson: s.postJson, randomId: () => `client-${++ids}`, setTimer: s.timers.setTimer, clearTimer: s.timers.clearTimer });
    const named = connection.clientIdentity();
    connection.start();
    await settle();
    expect(s.postJson.mock.calls[0]).toEqual([KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation(named)]);
    expect(s.postJson.mock.calls[1]).toEqual([KICK_REALTIME_AUTH_URL, { client_id: named }]);
  });

  it("subscribes owned channels once connected, and confirms them", async () => {
    const s = setup();
    s.connection.subscribe("chatrooms.668.v2");
    s.connection.start();
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: { ping: 25 } });
    expect(s.socket().frames().slice(1)).toEqual([{ subscribe: { channel: "chatrooms.668.v2", flag: 1 }, id: 2 }]);
    expect(s.connection.isSubscribed("chatrooms.668.v2")).toBe(false);
    s.socket().message({ id: 2, subscribe: {} });
    expect(s.connection.isSubscribed("chatrooms.668.v2")).toBe(true);
    expect(s.connection.status()).toEqual({ state: "connected", provider: "centrifugo" });
  });

  it("subscribes and unsubscribes while connected", async () => {
    const s = await connectedCentrifugo();
    s.connection.subscribe("channel_1");
    s.connection.unsubscribe("channel_1");
    expect(s.socket().frames().slice(1)).toEqual([
      { subscribe: { channel: "channel_1", flag: 1 }, id: 2 },
      { unsubscribe: { channel: "channel_1" }, id: 3 },
    ]);
  });

  it("answers server pings and treats silence past the ping interval as a dead socket", async () => {
    const s = await connectedCentrifugo({ ping: 25 });
    s.socket().message("{}");
    expect(s.socket().sent.at(-1)).toBe("{}");
    const first = s.socket();
    s.timers.fire(35_000);
    expect(first.closed).toBe(true);
    expect(s.connection.status().state).toBe("error");
  });

  it("drops publications without parsing them", async () => {
    const s = await connectedCentrifugo();
    const parse = vi.spyOn(JSON, "parse");
    s.socket().message("{\"push\":{\"channel\":\"chatrooms.668.v2\",\"pub\":{\"data\":{\"content\":\"hello\"}}}}");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(JSON.stringify(s.connection.drainEvents())).not.toContain("hello");
  });

  it("refreshes the token before its ttl lapses", async () => {
    const s = await connectedCentrifugo({ ping: 25, expires: true, ttl: 300 });
    s.timers.fire(285_000);
    await settle();
    expect(s.postJson).toHaveBeenLastCalledWith(KICK_REALTIME_AUTH_URL, { client_id: "client-1" });
    expect(s.socket().frames().at(-1)).toEqual({ refresh: { token: `${TOKEN}-2` }, id: 2 });
    s.socket().message({ id: 2, refresh: { expires: true, ttl: 300 } });
    expect(s.timers.live().some((timer) => timer.delayMs === 285_000)).toBe(true);
  });

  it("replays subscriptions after a reconnect, with backoff", async () => {
    const s = await connectedCentrifugo();
    s.connection.subscribe("chatrooms.668.v2");
    s.socket().remoteClose(1006);
    expect(s.connection.isSubscribed("chatrooms.668.v2")).toBe(false);
    s.timers.fire(1_000);
    await settle();
    s.socket().open();
    s.socket().message({ id: s.socket().frames()[0]!.id, connect: {} });
    expect(s.socket().frames().at(-1)).toMatchObject({ subscribe: { channel: "chatrooms.668.v2", flag: 1 } });
  });

  it("doubles the backoff up to a minute", async () => {
    const s = setup();
    s.postJson.mockRejectedValue(new Error("network down"));
    s.connection.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await settle();
      const timer = s.timers.live().at(-1)!;
      delays.push(timer.delayMs);
      s.timers.fire(timer.delayMs);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("resets the backoff after a connection stays up for a minute", async () => {
    const s = setup();
    s.postJson.mockRejectedValueOnce(new Error("network down")).mockRejectedValueOnce(new Error("network down"));
    s.connection.start();
    await settle();
    s.timers.fire(1_000);
    await settle();
    s.timers.fire(2_000);
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: {} });
    s.timers.fire(60_000);
    s.socket().remoteClose(1006);
    expect(s.timers.live().at(-1)?.delayMs).toBe(1_000);
  });

  it("keeps the backoff for a connection that drops within the minute", async () => {
    const s = setup();
    s.postJson.mockRejectedValueOnce(new Error("network down")).mockRejectedValueOnce(new Error("network down"));
    s.connection.start();
    await settle();
    s.timers.fire(1_000);
    await settle();
    s.timers.fire(2_000);
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: {} });
    s.socket().remoteClose(1006);
    expect(s.timers.live().at(-1)?.delayMs).toBe(4_000);
  });

  it("stops retrying after a final close code", async () => {
    const s = await connectedCentrifugo();
    s.socket().remoteClose(3501);
    expect(s.timers.live()).toEqual([]);
    expect(s.connection.status()).toEqual({ state: "error", provider: "centrifugo" });
  });

  it("blocks without retrying when Kick rejects the session", async () => {
    const s = setup();
    s.postJson.mockRejectedValue(new SafeFetchError({ kind: "authentication_rejected", status: 401 }));
    s.connection.start();
    await settle();
    expect(s.connection.status()).toEqual({ state: "blocked", reason: "auth" });
    expect(s.timers.live()).toEqual([]);
  });

  it("blocks when no supported provider is offered", async () => {
    const s = setup({ data: { connections: [{ provider: "ably", credentials: {} }] } });
    s.connection.start();
    await settle();
    expect(s.connection.status()).toEqual({ state: "blocked", reason: "unsupported-provider" });
    expect(s.sockets).toEqual([]);
  });

  // #755: a shared socket stays put for another region of the same provider;
  // moving would drop every other owner's channels until they replay.
  it("keeps the socket when a caller names another region of the same provider", async () => {
    const s = await connectedCentrifugo();
    const first = s.socket();
    s.connection.start({ provider: "centrifugo", url: "wss://realtime.us-east-1.platform.kick.com/connection/websocket" });
    await settle();
    expect(first.closed).toBe(false);
    expect(s.sockets).toHaveLength(1);
  });

  it("moves to another provider when a caller names one", async () => {
    const s = await connectedCentrifugo();
    const first = s.socket();
    s.connection.start({ provider: "pusher", url: "wss://ws-us2.pusher.com/app/abc123?protocol=7&client=js&version=8.4.0&flash=false" });
    await settle();
    expect(first.closed).toBe(true);
    expect(s.socket().url).toBe("wss://ws-us2.pusher.com/app/abc123?protocol=7&client=js&version=8.4.0&flash=false");
  });

  it("warns once when the connection keeps failing, and again only after it recovered", async () => {
    const s = setup();
    s.postJson.mockRejectedValue(new Error("network down"));
    s.connection.start();
    const fail = async (times: number) => {
      for (let i = 0; i < times; i += 1) {
        await settle();
        const timer = s.timers.live().at(-1)!;
        s.timers.fire(timer.delayMs);
      }
    };
    await fail(6);
    const warnings = () => s.connection.drainEvents().filter((event) => "level" in event && event.level === "warn" && /keeps failing/.test(String(event.message)));
    expect(warnings()).toHaveLength(1);
  });

  it("closes the socket and forgets everything on stop", async () => {
    const s = await connectedCentrifugo();
    s.connection.subscribe("chatrooms.668.v2");
    await s.connection.stop();
    expect(s.socket().closed).toBe(true);
    expect(s.timers.live()).toEqual([]);
    expect(s.connection.status()).toEqual({ state: "idle" });
    s.socket().remoteClose(1000);
    expect(s.timers.live()).toEqual([]);
  });

  it("never puts the token in diagnostics", async () => {
    const s = await connectedCentrifugo({ ping: 25, expires: true, ttl: 300 });
    s.socket().message({ id: 99, error: { code: 109, message: "token expired" } });
    s.socket().remoteClose(1006);
    expect(JSON.stringify(s.connection.drainEvents())).not.toContain(TOKEN);
  });

  it("reports status changes to its owner", async () => {
    const s = await connectedCentrifugo();
    expect(s.onStatusChange).toHaveBeenCalled();
    s.onStatusChange.mockClear();
    s.socket().message("{}");
    expect(s.onStatusChange).not.toHaveBeenCalled();
  });
});

describe("Kick realtime over Pusher", () => {
  async function connectedPusher() {
    const s = setup(PUSHER);
    s.connection.subscribe("chatrooms.668.v2");
    s.connection.start();
    await settle();
    s.socket().open();
    s.socket().message({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: "1.2", activity_timeout: 120 }) });
    return s;
  }

  it("needs no token, and subscribes public channels once established", async () => {
    const s = await connectedPusher();
    expect(s.postJson.mock.calls.map(([url]) => url)).toEqual([KICK_REALTIME_CONNECTION_URL]);
    expect(s.socket().frames()).toEqual([{ event: "pusher:subscribe", data: { auth: "", channel: "chatrooms.668.v2" } }]);
    s.socket().message({ event: "pusher_internal:subscription_succeeded", channel: "chatrooms.668.v2", data: "{}" });
    expect(s.connection.isSubscribed("chatrooms.668.v2")).toBe(true);
    expect(s.connection.status()).toEqual({ state: "connected", provider: "pusher" });
  });

  it("answers pings, and drops a socket that misses its own ping's pong", async () => {
    const s = await connectedPusher();
    s.socket().message({ event: "pusher:ping", data: {} });
    expect(s.socket().frames().at(-1)).toEqual({ event: "pusher:pong", data: {} });
    s.timers.fire(20_000);
    expect(s.socket().frames().at(-1)).toEqual({ event: "pusher:ping", data: {} });
    s.timers.fire(10_000);
    expect(s.socket().closed).toBe(true);
  });

  it("drops channel events without parsing them", async () => {
    const s = await connectedPusher();
    const parse = vi.spyOn(JSON, "parse");
    s.socket().message("{\"event\":\"App\\\\Events\\\\ChatMessageEvent\",\"data\":\"{\\\"content\\\":\\\"hello\\\"}\",\"channel\":\"chatrooms.668.v2\"}");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("stops retrying after a final Pusher close code", async () => {
    const s = await connectedPusher();
    s.socket().remoteClose(4001);
    expect(s.timers.live()).toEqual([]);
    expect(s.connection.status().state).toBe("error");
  });
});

// #755: owners listen for named events on their channels; nothing else is read.
describe("Kick realtime listeners", () => {
  async function centrifugoWith(channel: string) {
    const s = setup();
    const onEvent = vi.fn();
    s.connection.subscribe(channel, { events: ["drops_campaign_started"], onEvent });
    s.connection.start();
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: {} });
    return { ...s, onEvent };
  }
  const push = (channel: string, event: string, data: unknown) =>
    JSON.stringify({ push: { channel, pub: { data: { event, data } } } });

  it("delivers a listened event from a confirmed Centrifugo channel, with its payload", async () => {
    const s = await centrifugoWith("drops_category_15");
    s.socket().message(push("drops_category_15", "drops_campaign_started", "too-early"));
    expect(s.onEvent).not.toHaveBeenCalled();
    s.socket().message({ id: 2, subscribe: {} });
    s.socket().message(push("drops_category_15", "drops_campaign_started", "campaign-7"));
    s.socket().message(push("drops_category_15", "other_event", "x"));
    expect(s.onEvent.mock.calls).toEqual([["drops_campaign_started", "campaign-7"]]);
  });

  it("never parses a publication on a channel nobody listens to", async () => {
    const s = await centrifugoWith("drops_category_15");
    s.connection.subscribe("chatrooms.1.v2");
    const parse = vi.spyOn(JSON, "parse");
    s.socket().message(push("chatrooms.1.v2", "App\\Events\\ChatMessageEvent", { content: "secret" }));
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("stops delivering once the channel is unsubscribed", async () => {
    const s = await centrifugoWith("drops_category_15");
    s.socket().message({ id: 2, subscribe: {} });
    s.connection.unsubscribe("drops_category_15");
    s.socket().message(push("drops_category_15", "drops_campaign_started", "campaign-7"));
    expect(s.onEvent).not.toHaveBeenCalled();
  });

  it("keeps the connection alive when a listener throws", async () => {
    const s = await centrifugoWith("drops_category_15");
    s.onEvent.mockImplementation(() => { throw new Error("boom"); });
    s.socket().message({ id: 2, subscribe: {} });
    s.socket().message(push("drops_category_15", "drops_campaign_started", "campaign-7"));
    expect(s.socket().closed).toBe(false);
    expect(s.connection.drainEvents()).toContainEqual(expect.objectContaining({ level: "warn", message: "Kick realtime drops_campaign_started listener failed: boom" }));
  });

  it("negotiates only the providers the host accepts", async () => {
    const s = setup(PUSHER);
    const connection = new KickRealtimeConnection({ createWebSocket: () => new FakeSocket("x"), postJson: s.postJson, acceptedProviders: ["pusher"], randomId: () => "client-1", setTimer: s.timers.setTimer, clearTimer: s.timers.clearTimer });
    connection.start();
    await settle();
    expect(s.postJson.mock.calls[0]).toEqual([KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation("client-1", ["pusher"])]);
    expect(kickRealtimeNegotiation("client-1", ["pusher"])).toMatchObject({ capabilities: { accepted_providers: [{ provider: "pusher" }] } });
    expect(s.postJson.mock.calls.map(([url]) => url)).not.toContain(KICK_REALTIME_AUTH_URL);
  });
});

// #755: owners share one connection; one owner leaving never closes it for another.
describe("Kick realtime release", () => {
  it("closes only once no owner's subscription is left", async () => {
    const s = await connectedCentrifugo();
    s.connection.subscribe("drops_category_15");
    s.connection.subscribe("chatrooms.668.v2");
    s.connection.unsubscribe("chatrooms.668.v2");
    await s.connection.releaseIfIdle();
    expect(s.socket().closed).toBe(false);
    s.connection.unsubscribe("drops_category_15");
    await s.connection.releaseIfIdle();
    expect(s.socket().closed).toBe(true);
    expect(s.connection.status()).toEqual({ state: "idle" });
  });

  it("starts again after an idle release", async () => {
    const s = await connectedCentrifugo();
    await s.connection.releaseIfIdle();
    s.connection.subscribe("drops_category_15");
    s.connection.start();
    await settle();
    expect(s.sockets).toHaveLength(2);
  });
});

describe("Kick realtime Centrifugo payloads", () => {
  // Kick's web client decodes a string payload inside the envelope.
  it("decodes a JSON string payload, as Kick's web client does", async () => {
    const s = setup();
    const onEvent = vi.fn();
    s.connection.subscribe("drops_category_15", { events: ["drops_campaign_started"], onEvent });
    s.connection.start();
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: {} });
    s.socket().message({ id: 2, subscribe: {} });
    s.socket().message(JSON.stringify({ push: { channel: "drops_category_15", pub: { data: { event: "drops_campaign_started", data: "\"campaign-7\"" } } } }));
    s.socket().message(JSON.stringify({ push: { channel: "drops_category_15", pub: { data: { event: "drops_campaign_started", data: "plain" } } } }));
    expect(onEvent.mock.calls).toEqual([["drops_campaign_started", "campaign-7"], ["drops_campaign_started", "plain"]]);
  });

  it("names, at debug, an unexpected event on a listened channel", async () => {
    const s = setup();
    s.connection.subscribe("drops_category_15", { events: ["drops_campaign_started"], onEvent: () => undefined });
    s.connection.start();
    await settle();
    s.socket().open();
    s.socket().message({ id: 1, connect: {} });
    s.socket().message({ id: 2, subscribe: {} });
    s.socket().message(JSON.stringify({ push: { channel: "drops_category_15", pub: { data: { event: "DropsCampaignStarted", data: { secret: "x" } } } } }));
    const events = s.connection.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({ level: "debug", message: "Kick realtime ignored DropsCampaignStarted on drops_category_15" }));
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});

