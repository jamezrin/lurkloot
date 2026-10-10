import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "@lurkloot/shared/models";
import { KickDiscoverySignalController } from "@lurkloot/core/kick/discoverySignals";
import { KICK_REALTIME_CONNECTION_URL, KickRealtimeConnection, kickRealtimeNegotiation } from "@lurkloot/core/kick/realtime";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { kickAdapter } from "./helpers/adapters";

if (false) {
  // @ts-expect-error Core observers require their host to provide the WebSocket transport.
  void new KickDiscoverySignalController();
}

// Socket keepalive, reconnects and the provider protocols are the realtime
// connection's (kickRealtime.test.ts); these tests cover discovery on top.

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
  remoteClose(code?: number): void { this.readyState = 3; for (const listener of this.listeners.close ?? []) listener({ code }); }
  message(value: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }
  frames(): unknown[] { return this.sent.map((frame) => JSON.parse(frame)); }
}

const NEGOTIATED = { data: { connections: [{ provider: "pusher", credentials: { app_key: "negotiatedkey", cluster: "us2" } }] } };
const NEGOTIATED_URL = "wss://ws-us2.pusher.com/app/negotiatedkey?protocol=7&client=js&version=8.4.0&flash=false";
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const postJson = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => NEGOTIATED);
  const createWebSocket = vi.fn((url: string) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; });
  const controller = new KickDiscoverySignalController({
    createWebSocket,
    postJson,
    randomId: () => "client-1",
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer as never; },
    clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
  });
  const socket = () => sockets.at(-1)!;
  // Opens the socket and confirms `categories`' subscriptions.
  const establish = (...categories: string[]) => {
    socket().open();
    socket().message({ event: "pusher:connection_established", data: "{\"socket_id\":\"1.2\"}" });
    for (const category of categories) socket().message({ event: "pusher_internal:subscription_succeeded", channel: `drops_category_${category}`, data: "{}" });
  };
  const fire = (target: FakeSocket, category: string, data: unknown) =>
    target.message({ event: "drops_campaign_started", channel: `drops_category_${category}`, data });
  return { controller, sockets, socket, establish, fire, postJson, createWebSocket, timers };
}

const kickChannel = (categoryId: string): ChannelCandidate => ({
  platform: "kick",
  username: "creator",
  url: "https://kick.com/creator",
  categoryId,
});

describe("Kick discovery signals", () => {
  it("exposes a Kick discovery observer through the adapter", () => {
    const fetcher = { fetchJson: async <T,>(): Promise<T> => ({}) as T };
    const observer = kickAdapter(fetcher, (url) => new FakeSocket(url)).createDiscoverySignalController?.();
    expect(observer).toBeInstanceOf(KickDiscoverySignalController);
    expect(observer?.platform).toBe("kick");
    expect(kickAdapter(fetcher).createDiscoverySignalController).toBeUndefined();
  });

  // #755: the negotiation must never reach a fetcher that can open a tab.
  it("negotiates through the adapter's realtime fetcher when the host gives one", async () => {
    const pageCapable = { fetchJson: vi.fn(async (): Promise<never> => { throw new Error("would open a tab"); }) } as unknown as PageFetcher & { fetchJson: ReturnType<typeof vi.fn> };
    const backgroundOnly = { fetchJson: vi.fn(async (): Promise<unknown> => NEGOTIATED) } as unknown as PageFetcher & { fetchJson: ReturnType<typeof vi.fn> };
    const sockets: FakeSocket[] = [];
    const observer = kickAdapter(pageCapable, (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; }, undefined, { realtimeFetcher: backgroundOnly })
      .createDiscoverySignalController!();
    await observer.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    expect(pageCapable.fetchJson).not.toHaveBeenCalled();
    expect(backgroundOnly.fetchJson).toHaveBeenCalledWith(KICK_REALTIME_CONNECTION_URL, expect.objectContaining({ method: "POST" }), expect.any(Function));
    expect(sockets[0]?.url).toBe(NEGOTIATED_URL);
    await observer.stop();
  });

  it("negotiates Pusher only and subscribes once for the normalized category on the negotiated app", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel(" 42 ") }, () => undefined);
    await settle();
    expect(s.postJson).toHaveBeenCalledWith(KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation("client-1", ["pusher"]));
    expect(s.createWebSocket).toHaveBeenCalledWith(NEGOTIATED_URL);
    expect(s.controller.targetKey).toBe("42");
    s.establish();
    expect(s.socket().frames()).toEqual([{ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }]);

    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    expect(s.createWebSocket).toHaveBeenCalledOnce();
    expect(s.postJson).toHaveBeenCalledOnce();
  });

  it("emits one signal only for the current category's confirmed campaign-start event", async () => {
    const s = setup();
    const onSignal = vi.fn();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);
    await settle();
    s.establish();
    s.fire(s.socket(), "42", JSON.stringify("too-early"));
    expect(onSignal).not.toHaveBeenCalled();
    s.socket().message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });
    s.fire(s.socket(), "42", JSON.stringify("campaign-7"));
    expect(onSignal).toHaveBeenCalledOnce();
  });

  it("accepts a finite numeric campaign identifier", async () => {
    const s = setup();
    const onSignal = vi.fn();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);
    await settle();
    s.establish("42");
    s.fire(s.socket(), "42", "123");
    expect(onSignal).toHaveBeenCalledOnce();
  });

  it("updates the callback without reopening an unchanged normalized category", async () => {
    const s = setup();
    const firstSignal = vi.fn();
    const nextSignal = vi.fn();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, firstSignal);
    await s.controller.start({ platform: "kick", channel: kickChannel(" 42 ") }, nextSignal);
    await settle();
    s.establish("42");
    s.fire(s.socket(), "42", JSON.stringify("campaign-7"));
    expect(firstSignal).not.toHaveBeenCalled();
    expect(nextSignal).toHaveBeenCalledOnce();
    expect(s.createWebSocket).toHaveBeenCalledOnce();
  });

  it("ignores malformed, unrelated and previous-category events", async () => {
    const s = setup();
    const onSignal = vi.fn();
    await s.controller.start({ platform: "kick", channel: kickChannel("41") }, onSignal);
    await settle();
    s.establish("41");
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);
    s.socket().message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });

    s.fire(s.socket(), "41", JSON.stringify("old"));
    s.socket().message("not json");
    s.socket().message({ event: "other_event", channel: "drops_category_42", data: JSON.stringify("campaign-7") });
    for (const data of ["", JSON.stringify(""), JSON.stringify("   "), JSON.stringify(true), JSON.stringify(["campaign-7"]), JSON.stringify({ id: "campaign-7" }), JSON.stringify(null), "{not json"]) {
      s.fire(s.socket(), "42", data);
    }
    expect(onSignal).not.toHaveBeenCalled();
  });

  // Intended change (#755): a new category joins the same socket instead of
  // replacing it, subscribing before the old channel leaves.
  it("switches categories on one socket, subscribing the new channel before leaving the old", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("41") }, () => undefined);
    await settle();
    s.establish("41");
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    expect(s.sockets).toHaveLength(1);
    expect(s.socket().closed).toBe(false);
    expect(s.socket().frames().slice(1)).toEqual([
      { event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } },
      { event: "pusher:unsubscribe", data: { channel: "drops_category_41" } },
    ]);
  });

  it("resubscribes the current category after a reconnect", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    s.establish("42");
    s.socket().remoteClose(1006);
    const retry = s.timers.find((timer) => !timer.cleared && timer.delayMs === 1_000)!;
    retry.cleared = true;
    retry.callback();
    await settle();
    s.establish();
    expect(s.sockets).toHaveLength(2);
    expect(s.socket().frames()).toEqual([{ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }]);
  });

  it("closes the socket on stop and does not reconnect", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    s.establish("42");
    await s.controller.stop();
    expect(s.socket().closed).toBe(true);
    expect(s.controller.targetKey).toBeUndefined();
    s.socket().remoteClose(1000);
    expect(s.timers.filter((timer) => !timer.cleared)).toEqual([]);
  });

  it("parses no chat or other event it does not listen for", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    s.establish("42");
    const parse = vi.spyOn(JSON, "parse");
    s.socket().message("{\"event\":\"App\\\\Events\\\\ChatMessageEvent\",\"data\":\"{\\\"content\\\":\\\"secret\\\"}\",\"channel\":\"chatrooms.1.v2\"}");
    s.socket().message("{\"event\":\"other_event\",\"data\":\"{}\",\"channel\":\"drops_category_42\"}");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("logs subscription, accepted-signal and payload-free malformed-frame diagnostics", async () => {
    const s = setup();
    const onSignal = vi.fn();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);
    await settle();
    s.establish("42");
    s.fire(s.socket(), "42", JSON.stringify({ secret: "payload" }));
    s.fire(s.socket(), "42", JSON.stringify("campaign-secret"));
    const events = s.controller.drainEvents();
    expect(onSignal).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/subscribed.*category 42/i) }),
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/accepted.*campaign-start.*category 42/i) }),
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/malformed.*frame/i) }),
    ]));
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("stops and logs debug diagnostics for invalid targets", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    await s.controller.start({ platform: "twitch", channel: { ...kickChannel("42"), platform: "twitch" } }, () => undefined);
    expect(s.socket().closed).toBe(true);
    expect(s.controller.targetKey).toBeUndefined();
    expect(s.controller.drainEvents()).toContainEqual(expect.objectContaining({ level: "debug", platform: "kick" }));

    await s.controller.start({ platform: "kick", channel: kickChannel("   ") }, () => undefined);
    await settle();
    expect(s.createWebSocket).toHaveBeenCalledOnce();
  });

  it("stops an active connection when the Kick category is blank", async () => {
    const s = setup();
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    await settle();
    await s.controller.start({ platform: "kick", channel: kickChannel("   ") }, () => undefined);
    expect(s.socket().closed).toBe(true);
    expect(s.controller.targetKey).toBeUndefined();
  });

  it("bounds callback diagnostics to the newest 250 entries", async () => {
    const s = setup();
    let callbackIndex = 0;
    await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => {
      throw new Error(`callback-${callbackIndex}`);
    });
    await settle();
    s.establish("42");
    s.controller.drainEvents();
    for (callbackIndex = 0; callbackIndex < 260; callbackIndex += 1) {
      s.fire(s.socket(), "42", JSON.stringify(`campaign-${callbackIndex}`));
    }
    const events = s.controller.drainEvents();
    expect(events).toHaveLength(250);
    const warnings = events.filter((event) => event.level === "warn");
    expect(events.every((event) => event.platform === "kick")).toBe(true);
    expect(warnings).toHaveLength(125);
    expect(warnings[0]?.message).toBe("Kick discovery signal callback failed: callback-135");
    expect(warnings.at(-1)?.message).toBe("Kick discovery signal callback failed: callback-259");
  });

  // #755: on a host that shares its connection, discovery is one owner of it.
  describe("on a shared connection", () => {
    function shared() {
      const sockets: FakeSocket[] = [];
      const postJson = vi.fn(async (): Promise<unknown> => NEGOTIATED);
      const connection = new KickRealtimeConnection({
        createWebSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
        postJson,
        randomId: () => "host-client",
      });
      const ownCreate = vi.fn();
      const controller = new KickDiscoverySignalController({ createWebSocket: ownCreate, postJson: vi.fn(), connection });
      return { connection, controller, sockets, postJson, ownCreate };
    }

    it("subscribes on the host's connection instead of opening its own", async () => {
      const s = shared();
      await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
      await settle();
      expect(s.ownCreate).not.toHaveBeenCalled();
      // The host's providers, not discovery's Pusher-only default.
      expect(s.postJson).toHaveBeenCalledWith(KICK_REALTIME_CONNECTION_URL, kickRealtimeNegotiation("host-client"));
      s.sockets[0]!.open();
      s.sockets[0]!.message({ event: "pusher:connection_established", data: "{}" });
      expect(s.sockets[0]!.frames()).toEqual([{ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }]);
      await s.controller.stop();
    });

    it("leaves only its own channel on stop, keeping another owner's socket open", async () => {
      const s = shared();
      s.connection.subscribe("chatrooms.668.v2");
      await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
      await settle();
      s.sockets[0]!.open();
      s.sockets[0]!.message({ event: "pusher:connection_established", data: "{}" });
      await s.controller.stop();
      expect(s.sockets[0]!.closed).toBe(false);
      expect(s.sockets[0]!.frames().at(-1)).toEqual({ event: "pusher:unsubscribe", data: { channel: "drops_category_42" } });
      expect(s.connection.status().state).toBe("connected");
      await s.connection.stop();
    });

    it("closes the connection when it was the last owner", async () => {
      const s = shared();
      await s.controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
      await settle();
      s.sockets[0]!.open();
      await s.controller.stop();
      expect(s.sockets[0]!.closed).toBe(true);
      expect(s.connection.status()).toEqual({ state: "idle" });
    });
  });
});
