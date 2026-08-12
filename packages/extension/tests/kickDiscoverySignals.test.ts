import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "@lurkloot/shared/models";
import { KickDiscoverySignalController } from "@lurkloot/core/kick/discoverySignals";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { kickAdapter } from "./helpers/adapters";

if (false) {
  // @ts-expect-error Core observers require their host to provide the WebSocket transport.
  void new KickDiscoverySignalController();
}

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {};

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type: "open" | "close" | "error", event: WebSocketMessageEventLike = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  message(value: unknown): void {
    for (const listener of this.listeners.message ?? []) {
      listener({ data: typeof value === "string" ? value : JSON.stringify(value) });
    }
  }
}

interface ScheduledReconnect {
  callback: () => void;
  delayMs: number;
  timer: ReturnType<typeof setTimeout>;
}

const reconnectScheduler = () => {
  const scheduled: ScheduledReconnect[] = [];
  const scheduleReconnect = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = { id: scheduled.length } as unknown as ReturnType<typeof setTimeout>;
    scheduled.push({ callback, delayMs, timer });
    return timer;
  };
  return { scheduled, scheduleReconnect };
};

interface ScheduledKeepAlive {
  callback: () => void;
  delayMs: number;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

const keepAliveScheduler = () => {
  const scheduled: ScheduledKeepAlive[] = [];
  const scheduleKeepAlive = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = { id: scheduled.length } as unknown as ReturnType<typeof setTimeout>;
    scheduled.push({ callback, delayMs, timer, cancelled: false });
    return timer;
  };
  const cancelKeepAlive = (timer: ReturnType<typeof setTimeout>): void => {
    const entry = scheduled.find((candidate) => candidate.timer === timer);
    if (entry) entry.cancelled = true;
  };
  return { scheduled, scheduleKeepAlive, cancelKeepAlive };
};

const kickChannel = (categoryId: string): ChannelCandidate => ({
  platform: "kick",
  username: "creator",
  url: "https://kick.com/creator",
  categoryId,
});

describe("Kick discovery signals", () => {
  it("exposes a Kick discovery observer through the adapter", () => {
    const fetcher = { fetchJson: async <T,>(): Promise<T> => ({}) as T };
    const adapter = kickAdapter(
      fetcher,
      undefined,
      () => new FakeSocket(),
    );

    const observer = adapter.createDiscoverySignalController?.();

    expect(observer).toBeInstanceOf(KickDiscoverySignalController);
    expect(observer?.platform).toBe("kick");
    expect(kickAdapter(fetcher).createDiscoverySignalController).toBeUndefined();
  });

  it("opens the Pusher connection and subscribes once for the normalized category", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const controller = new KickDiscoverySignalController({ createWebSocket });

    await controller.start({ platform: "kick", channel: kickChannel(" 42 ") }, () => undefined);

    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false",
    );
    expect(controller.targetKey).toBe("42");
    expect(socket.sent).toEqual([]);

    socket.message({ event: "pusher:connection_established", data: "{}" });

    expect(socket.sent).toEqual([
      JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }),
    ]);

    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    expect(createWebSocket).toHaveBeenCalledOnce();
  });

  it("emits one signal only for the current category campaign-start event", async () => {
    const socket = new FakeSocket();
    const onSignal = vi.fn();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);

    socket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify("campaign-7") });

    expect(onSignal).toHaveBeenCalledOnce();
  });

  it("accepts a finite numeric campaign identifier", async () => {
    const socket = new FakeSocket();
    const onSignal = vi.fn();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);

    socket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: "123" });

    expect(onSignal).toHaveBeenCalledOnce();
  });

  it("updates the callback without reopening an unchanged normalized category", async () => {
    const socket = new FakeSocket();
    const firstSignal = vi.fn();
    const nextSignal = vi.fn();
    const createWebSocket = vi.fn(() => socket);
    const controller = new KickDiscoverySignalController({ createWebSocket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, firstSignal);
    await controller.start({ platform: "kick", channel: kickChannel(" 42 ") }, nextSignal);

    socket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify("campaign-7") });

    expect(firstSignal).not.toHaveBeenCalled();
    expect(nextSignal).toHaveBeenCalledOnce();
    expect(createWebSocket).toHaveBeenCalledOnce();
  });

  it("ignores malformed, unrelated, and stale-socket events", async () => {
    const oldSocket = new FakeSocket();
    const currentSocket = new FakeSocket();
    const sockets = [oldSocket, currentSocket];
    const onSignal = vi.fn();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => sockets.shift()! });
    await controller.start({ platform: "kick", channel: kickChannel("41") }, onSignal);
    await controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);

    oldSocket.message({ event: "drops_campaign_started", channel: "drops_category_41", data: JSON.stringify("old") });
    currentSocket.message("not json");
    currentSocket.message({ event: "other_event", channel: "drops_category_42", data: JSON.stringify("campaign-7") });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_41", data: JSON.stringify("campaign-7") });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: "" });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify("") });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify("   ") });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify(true) });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify(["campaign-7"]) });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify({ id: "campaign-7" }) });
    currentSocket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify(null) });

    expect(onSignal).not.toHaveBeenCalled();
  });

  it("closes the obsolete category socket before subscribing to the replacement", async () => {
    const oldSocket = new FakeSocket();
    const replacementSocket = new FakeSocket();
    const createWebSocket = vi.fn()
      .mockReturnValueOnce(oldSocket)
      .mockImplementationOnce(() => {
        expect(oldSocket.closed).toBe(true);
        return replacementSocket;
      });
    const controller = new KickDiscoverySignalController({ createWebSocket });
    await controller.start({ platform: "kick", channel: kickChannel("41") }, () => undefined);

    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    replacementSocket.message({ event: "pusher:connection_established", data: {} });

    expect(replacementSocket.sent).toEqual([
      JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }),
    ]);
  });

  it("answers Pusher ping frames without emitting a discovery signal", async () => {
    const socket = new FakeSocket();
    const onSignal = vi.fn();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);

    socket.message({ event: "pusher:ping", data: "{}" });

    expect(socket.sent).toEqual([JSON.stringify({ event: "pusher:pong", data: {} })]);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("sends client Pusher pings every 20 seconds after subscription and continues after pong", async () => {
    const socket = new FakeSocket();
    const keepAlive = keepAliveScheduler();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => socket,
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
    });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    socket.message({ event: "pusher:connection_established", data: "{}" });
    expect(keepAlive.scheduled).toEqual([]);
    socket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });
    expect(keepAlive.scheduled[0]?.delayMs).toBe(20_000);

    keepAlive.scheduled[0]!.callback();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ event: "pusher:ping", data: {} }));
    expect(keepAlive.scheduled[1]?.delayMs).toBe(10_000);

    socket.message({ event: "pusher:pong", data: "{}" });
    expect(keepAlive.scheduled[1]?.cancelled).toBe(true);
    expect(keepAlive.scheduled[2]?.delayMs).toBe(20_000);

    keepAlive.scheduled[2]!.callback();
    expect(socket.sent.filter((frame) => frame === JSON.stringify({ event: "pusher:ping", data: {} })))
      .toHaveLength(2);
  });

  it("closes and reconnects once when a client Pusher ping receives no pong", async () => {
    const timedOutSocket = new FakeSocket();
    const sockets = [timedOutSocket, new FakeSocket()];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => sockets.shift()!,
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    timedOutSocket.message({ event: "pusher:connection_established", data: "{}" });
    timedOutSocket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });

    keepAlive.scheduled[0]!.callback();
    keepAlive.scheduled[1]!.callback();

    expect(timedOutSocket.closed).toBe(true);
    expect(reconnect.scheduled).toHaveLength(1);
    timedOutSocket.emit("close", { code: 1006 });
    expect(reconnect.scheduled).toHaveLength(1);

    reconnect.scheduled[0]!.callback();
    expect(sockets).toEqual([]);
  });

  it("cancels keepalive timers on close, category replacement, and stop", async () => {
    const closedSocket = new FakeSocket();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [closedSocket, firstSocket, secondSocket];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => sockets.shift()!,
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start({ platform: "kick", channel: kickChannel("41") }, () => undefined);
    closedSocket.message({ event: "pusher:connection_established", data: "{}" });
    closedSocket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_41", data: "{}" });
    const closedTimer = keepAlive.scheduled[0]!;

    closedSocket.emit("close", { code: 1006 });
    expect(closedTimer.cancelled).toBe(true);
    closedTimer.callback();
    expect(closedSocket.sent).not.toContain(JSON.stringify({ event: "pusher:ping", data: {} }));
    reconnect.scheduled[0]!.callback();

    firstSocket.message({ event: "pusher:connection_established", data: "{}" });
    firstSocket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_41", data: "{}" });
    const replacedTimer = keepAlive.scheduled.at(-1)!;

    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);
    expect(replacedTimer.cancelled).toBe(true);
    replacedTimer.callback();
    expect(firstSocket.sent).not.toContain(JSON.stringify({ event: "pusher:ping", data: {} }));

    secondSocket.message({ event: "pusher:connection_established", data: "{}" });
    secondSocket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });
    keepAlive.scheduled.at(-1)!.callback();
    const stoppedTimer = keepAlive.scheduled.at(-1)!;
    await controller.stop();

    expect(stoppedTimer.cancelled).toBe(true);
    stoppedTimer.callback();
    expect(reconnect.scheduled).toHaveLength(1);
  });

  it("reconnects after an unexpected close and resubscribes to the current category", async () => {
    const sockets: FakeSocket[] = [];
    const { scheduled, scheduleReconnect } = reconnectScheduler();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleReconnect,
    });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, expectedDelay] of expectedDelays.entries()) {
      sockets[index]!.emit("close");
      expect(scheduled[index]?.delayMs).toBe(expectedDelay);
      scheduled[index]!.callback();
    }

    const reconnectedSocket = sockets.at(-1)!;
    reconnectedSocket.message({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: "1.2" }) });
    expect(reconnectedSocket.sent).toEqual([
      JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: "drops_category_42" } }),
    ]);

    reconnectedSocket.emit("close");
    expect(scheduled.at(-1)?.delayMs).toBe(1_000);
  });

  it("does not reconnect after stop or an expected replacement close", async () => {
    const oldSocket = new FakeSocket();
    const replacementSocket = new FakeSocket();
    const sockets = [oldSocket, replacementSocket];
    const { scheduled, scheduleReconnect } = reconnectScheduler();
    const cancelReconnect = vi.fn();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => sockets.shift()!,
      scheduleReconnect,
      cancelReconnect,
    });
    await controller.start({ platform: "kick", channel: kickChannel("41") }, () => undefined);
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    oldSocket.emit("close");
    expect(scheduled).toEqual([]);

    replacementSocket.emit("close");
    expect(scheduled).toHaveLength(1);
    await controller.stop();
    expect(cancelReconnect).toHaveBeenCalledWith(scheduled[0]!.timer);
    scheduled[0]!.callback();
    expect(sockets).toEqual([]);

    replacementSocket.emit("close");
    expect(scheduled).toHaveLength(1);
  });

  it("lets an error/close pair schedule only one reconnect", async () => {
    const socket = new FakeSocket();
    const { scheduled, scheduleReconnect } = reconnectScheduler();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket, scheduleReconnect });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    socket.emit("error");
    socket.emit("close");

    expect(scheduled).toHaveLength(1);
    expect(controller.drainEvents()).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "kick",
      level: "warn",
    }));
  });

  it.each([
    { code: 3999, reconnects: true },
    { code: 4000, reconnects: false },
    { code: 4099, reconnects: false },
    { code: 4100, reconnects: true },
  ])("handles Pusher close code $code with reconnect=$reconnects", async ({ code, reconnects }) => {
    const socket = new FakeSocket();
    const reconnect = reconnectScheduler();
    const controller = new KickDiscoverySignalController({
      createWebSocket: () => socket,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    socket.emit("close", { code, reason: "protocol decision" });

    expect(reconnect.scheduled).toHaveLength(reconnects ? 1 : 0);
    if (!reconnects) {
      expect(controller.drainEvents()).toContainEqual(expect.objectContaining({
        level: "warn",
        platform: "kick",
        message: expect.stringMatching(new RegExp(`terminal Pusher close code ${code}`)),
      }));
    }
  });

  it("logs subscription, accepted-signal, and payload-free malformed-frame diagnostics", async () => {
    const socket = new FakeSocket();
    const onSignal = vi.fn();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, onSignal);

    socket.message({ event: "pusher:connection_established", data: "{}" });
    socket.message({ event: "pusher_internal:subscription_succeeded", channel: "drops_category_42", data: "{}" });
    socket.message("malformed secret payload");
    socket.message({ event: "drops_campaign_started", channel: "drops_category_42", data: JSON.stringify("campaign-secret") });

    const events = controller.drainEvents();
    expect(onSignal).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/subscribed.*category 42/i) }),
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/accepted.*campaign-start.*category 42/i) }),
      expect.objectContaining({ level: "debug", message: expect.stringMatching(/malformed.*frame/i) }),
    ]));
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("stops and logs debug diagnostics for invalid targets", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const controller = new KickDiscoverySignalController({ createWebSocket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    await controller.start({ platform: "twitch", channel: { ...kickChannel("42"), platform: "twitch" } }, () => undefined);

    expect(socket.closed).toBe(true);
    expect(controller.targetKey).toBeUndefined();
    expect(controller.drainEvents()).toContainEqual(expect.objectContaining({ level: "debug", platform: "kick" }));

    await controller.start({ platform: "kick", channel: kickChannel("   ") }, () => undefined);
    expect(createWebSocket).toHaveBeenCalledOnce();
  });

  it("stops an active connection when the Kick category is blank", async () => {
    const socket = new FakeSocket();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => undefined);

    await controller.start({ platform: "kick", channel: kickChannel("   ") }, () => undefined);

    expect(socket.closed).toBe(true);
    expect(controller.targetKey).toBeUndefined();
  });

  it("bounds callback diagnostics to the newest 250 entries", async () => {
    const socket = new FakeSocket();
    const controller = new KickDiscoverySignalController({ createWebSocket: () => socket });
    let callbackIndex = 0;
    await controller.start({ platform: "kick", channel: kickChannel("42") }, () => {
      throw new Error(`callback-${callbackIndex}`);
    });

    for (callbackIndex = 0; callbackIndex < 260; callbackIndex += 1) {
      socket.message({
        event: "drops_campaign_started",
        channel: "drops_category_42",
        data: JSON.stringify(`campaign-${callbackIndex}`),
      });
    }

    const events = controller.drainEvents();
    expect(events).toHaveLength(250);
    const warnings = events.filter((event) => event.level === "warn");
    expect(events.every((event) => event.platform === "kick")).toBe(true);
    expect(warnings).toHaveLength(125);
    expect(warnings[0]?.message).toBe("Kick discovery signal callback failed: callback-135");
    expect(warnings.at(-1)?.message).toBe("Kick discovery signal callback failed: callback-259");
  });
});
