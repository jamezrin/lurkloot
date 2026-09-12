import { afterEach, describe, expect, it, vi } from "vitest";
import { TwitchChannelPointsPushController } from "@lurkloot/core/twitch/channelPointsPush";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import { twitchAdapter } from "./helpers/adapters";

const liveControllers: TwitchChannelPointsPushController[] = [];

afterEach(async () => {
  await Promise.all(liveControllers.splice(0).map((controller) => controller.stop()));
});

function createPushController(
  deps: ConstructorParameters<typeof TwitchChannelPointsPushController>[0],
): TwitchChannelPointsPushController {
  const controller = new TwitchChannelPointsPushController(deps);
  liveControllers.push(controller);
  return controller;
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
  cancelled: boolean;
}

const reconnectScheduler = () => {
  const scheduled: ScheduledReconnect[] = [];
  const scheduleReconnect = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = { id: scheduled.length } as unknown as ReturnType<typeof setTimeout>;
    scheduled.push({ callback, delayMs, timer, cancelled: false });
    return timer;
  };
  const cancelReconnect = (timer: ReturnType<typeof setTimeout>): void => {
    const entry = scheduled.find((candidate) => candidate.timer === timer);
    if (entry) entry.cancelled = true;
  };
  return { scheduled, scheduleReconnect, cancelReconnect };
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

const WELCOME = {
  type: "welcome",
  welcome: { keepaliveSec: 15, sessionId: "session" },
  id: "welcome-1",
  timestamp: "2026-09-11T16:09:08.000Z",
};

const parsedSent = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);

const currentSubscriptionId = (socket: FakeSocket): string => {
  const subscribe = parsedSent(socket).find((frame) => frame.type === "subscribe");
  const body = subscribe?.subscribe;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { id?: unknown }).id !== "string") {
    throw new Error("missing community-points subscription id");
  }
  return (body as { id: string }).id;
};

const completeHandshake = (socket: FakeSocket): void => {
  socket.message(WELCOME);
  const authenticate = JSON.parse(socket.sent[0]!);
  socket.message({
    type: "authenticateResponse",
    authenticateResponse: { result: "ok" },
    parentId: authenticate.id,
    id: "auth-ok",
    timestamp: "2026-09-11T16:09:08.100Z",
  });
  const subscribe = JSON.parse(socket.sent[1]!);
  socket.message({
    type: "subscribeResponse",
    subscribeResponse: { subscription: { id: subscribe.subscribe.id }, result: "ok" },
    parentId: subscribe.id,
    id: "sub-ok",
    timestamp: "2026-09-11T16:09:08.200Z",
  });
};

const handshake = async (
  socket: FakeSocket,
  controller: TwitchChannelPointsPushController,
  onClaim: (notice: { claimId: string; channelId: string }) => void,
): Promise<void> => {
  await controller.start(onClaim);
  completeHandshake(socket);
};

const afterReconnect = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const pubsubNotification = (subscriptionId: string, inner: unknown) => ({
  type: "notification",
  notification: {
    subscription: { id: subscriptionId },
    type: "pubsub",
    pubsub: typeof inner === "string" ? inner : JSON.stringify(inner),
  },
});

describe("Twitch channel-points push", () => {
  it("authenticates then subscribes to the user community-points topic", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const controller = createPushController({
      createWebSocket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => "78020132",
    });
    await controller.start(() => undefined);

    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://hermes.twitch.tv/v1?clientId=kimne78kx3ncx6brgo4mv6wki5h1ko",
    );
    expect(socket.sent).toEqual([]);
    socket.message(WELCOME);

    const authenticate = JSON.parse(socket.sent[0]!);
    expect(authenticate).toMatchObject({
      type: "authenticate",
      authenticate: { token: "auth-token-value" },
    });
    expect(controller.subscribed).toBe(false);

    socket.message({
      type: "authenticateResponse",
      authenticateResponse: { result: "ok" },
      parentId: authenticate.id,
      id: "auth-ok",
      timestamp: "2026-09-11T16:09:08.100Z",
    });

    const subscribe = JSON.parse(socket.sent[1]!);
    expect(subscribe).toMatchObject({
      type: "subscribe",
      subscribe: {
        type: "pubsub",
        pubsub: { topic: "community-points-user-v1.78020132" },
      },
    });
    expect(controller.subscribed).toBe(false);

    socket.message({
      type: "subscribeResponse",
      subscribeResponse: { subscription: { id: subscribe.subscribe.id }, result: "ok" },
      parentId: subscribe.id,
      id: "sub-ok",
      timestamp: "2026-09-11T16:09:08.200Z",
    });
    expect(controller.subscribed).toBe(true);
    expect(JSON.stringify(controller.drainEvents())).not.toContain("auth-token-value");
  });

  it("logs debug and schedules reconnect when the auth token is empty", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket,
      getAuthToken: async () => undefined,
      resolveUserId: async () => "78020132",
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start(() => undefined);

    expect(createWebSocket).not.toHaveBeenCalled();
    expect(reconnect.scheduled).toHaveLength(1);
    expect(controller.subscribed).toBe(false);
    const events = controller.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "debug",
    }));
    expect(JSON.stringify(events)).not.toMatch(/OAuth /);
  });

  it("logs debug and schedules reconnect when the user id is empty after authenticate ok", async () => {
    const socket = new FakeSocket();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => undefined,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start(() => undefined);
    socket.message(WELCOME);

    const authenticate = JSON.parse(socket.sent[0]!);
    expect(authenticate).toMatchObject({
      type: "authenticate",
      authenticate: { token: "auth-token-value" },
    });
    socket.message({
      type: "authenticateResponse",
      authenticateResponse: { result: "ok" },
      parentId: authenticate.id,
      id: "auth-ok",
      timestamp: "2026-09-11T16:09:08.100Z",
    });

    expect(parsedSent(socket).some((frame) => frame.type === "subscribe")).toBe(false);
    expect(controller.subscribed).toBe(false);
    expect(reconnect.scheduled).toHaveLength(1);
    const events = controller.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "debug",
    }));
    expect(JSON.stringify(events)).not.toContain("auth-token-value");
  });

  it("warns and reconnects when getAuthToken rejects, then connects after recovery", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const reconnect = reconnectScheduler();
    const getAuthToken = vi.fn()
      .mockRejectedValueOnce(new Error("cookie store failed"))
      .mockResolvedValue("auth-token-value");
    const controller = createPushController({
      createWebSocket,
      getAuthToken,
      resolveUserId: async () => "78020132",
      scheduleReconnect: reconnect.scheduleReconnect,
    });

    await controller.start(() => undefined);

    expect(createWebSocket).not.toHaveBeenCalled();
    expect(reconnect.scheduled).toHaveLength(1);
    expect(controller.subscribed).toBe(false);
    const events = controller.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: expect.stringMatching(/auth token/i),
    }));
    expect(JSON.stringify(events)).not.toContain("auth-token-value");

    reconnect.scheduled[0]!.callback();
    await afterReconnect();
    expect(createWebSocket).toHaveBeenCalledOnce();

    await controller.start(() => undefined);
    expect(createWebSocket).toHaveBeenCalledOnce();
  });

  it("warns and reconnects when resolveUserId rejects, then connects after recovery", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const reconnect = reconnectScheduler();
    const resolveUserId = vi.fn()
      .mockRejectedValueOnce(new Error("CurrentUser failed"))
      .mockResolvedValue("78020132");
    const controller = createPushController({
      createWebSocket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId,
      scheduleReconnect: reconnect.scheduleReconnect,
    });

    await controller.start(() => undefined);

    expect(createWebSocket).not.toHaveBeenCalled();
    expect(reconnect.scheduled).toHaveLength(1);
    expect(controller.subscribed).toBe(false);
    const events = controller.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: expect.stringMatching(/user id/i),
    }));
    expect(JSON.stringify(events)).not.toContain("auth-token-value");

    reconnect.scheduled[0]!.callback();
    await afterReconnect();
    expect(createWebSocket).toHaveBeenCalledOnce();

    await controller.start(() => undefined);
    expect(createWebSocket).toHaveBeenCalledOnce();
  });

  it("notifies only for claim-available on the community-points subscription", async () => {
    const socket = new FakeSocket();
    const onClaim = vi.fn();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
    });
    await handshake(socket, controller, onClaim);

    socket.message({
      type: "notification",
      notification: {
        subscription: { id: currentSubscriptionId(socket) },
        type: "pubsub",
        pubsub: JSON.stringify({
          type: "points-earned",
          data: { channel_id: "119415848" },
        }),
      },
    });
    socket.message({
      type: "notification",
      notification: {
        subscription: { id: currentSubscriptionId(socket) },
        type: "pubsub",
        pubsub: JSON.stringify({
          type: "claim-available",
          data: {
            claim: {
              id: "fd29a0b3-f804-4f58-905d-b33f235951c8",
              channel_id: "119415848",
            },
          },
        }),
      },
    });
    expect(onClaim).toHaveBeenCalledOnce();
    expect(onClaim).toHaveBeenCalledWith({
      claimId: "fd29a0b3-f804-4f58-905d-b33f235951c8",
      channelId: "119415848",
    });
  });

  it("ignores malformed, incomplete, claimed, and foreign notifications", async () => {
    const socket = new FakeSocket();
    const onClaim = vi.fn();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
    });
    await handshake(socket, controller, onClaim);
    const subscriptionId = currentSubscriptionId(socket);

    socket.message(pubsubNotification(subscriptionId, "{not json"));
    socket.message(pubsubNotification(subscriptionId, {
      type: "claim-available",
      data: { claim: { channel_id: "119415848" } },
    }));
    socket.message(pubsubNotification(subscriptionId, {
      type: "claim-available",
      data: { claim: { id: "fd29a0b3-f804-4f58-905d-b33f235951c8" } },
    }));
    socket.message(pubsubNotification(subscriptionId, {
      type: "claim-claimed",
      data: {
        claim: {
          id: "fd29a0b3-f804-4f58-905d-b33f235951c8",
          channel_id: "119415848",
        },
      },
    }));
    socket.message(pubsubNotification("other-subscription", {
      type: "claim-available",
      data: {
        claim: {
          id: "fd29a0b3-f804-4f58-905d-b33f235951c8",
          channel_id: "119415848",
        },
      },
    }));

    expect(onClaim).not.toHaveBeenCalled();
  });

  it("warns when the claim callback throws and never includes the token", async () => {
    const socket = new FakeSocket();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => "78020132",
    });
    await handshake(socket, controller, () => {
      throw new Error("claim callback failed");
    });
    socket.message(pubsubNotification(currentSubscriptionId(socket), {
      type: "claim-available",
      data: {
        claim: {
          id: "fd29a0b3-f804-4f58-905d-b33f235951c8",
          channel_id: "119415848",
        },
      },
    }));

    const events = controller.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: expect.stringMatching(/claim callback failed/i),
    }));
    expect(JSON.stringify(events)).not.toContain("auth-token-value");
  });
});

describe("keepalive, reconnect, and stop", () => {
  it("closes and reconnects when the socket never welcomes", async () => {
    const socket = new FakeSocket();
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start(() => undefined);

    expect(keepAlive.scheduled).toHaveLength(1);
    expect(keepAlive.scheduled[0]?.delayMs).toBe(2 * 15 * 1000);

    keepAlive.scheduled[0]!.callback();
    expect(socket.closed).toBe(true);
    expect(controller.subscribed).toBe(false);
    expect(reconnect.scheduled).toHaveLength(1);
    expect(reconnect.scheduled[0]?.delayMs).toBe(1000);
  });

  it("resets silence timeout on keepalive and reconnects after silence", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => sockets.shift()!,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await handshake(firstSocket, controller, () => undefined);

    expect(keepAlive.scheduled[0]?.cancelled).toBe(true);
    expect(keepAlive.scheduled[1]?.delayMs).toBe(2 * 15 * 1000);
    expect(parsedSent(firstSocket).some((frame) => frame.type === "ping" || frame.type === "pong")).toBe(false);

    firstSocket.message({ type: "keepalive", id: "ka-1", timestamp: "2026-09-11T16:09:18.000Z" });
    expect(keepAlive.scheduled[1]?.cancelled).toBe(true);
    expect(keepAlive.scheduled[2]?.delayMs).toBe(30_000);
    expect(parsedSent(firstSocket).some((frame) => frame.type === "ping" || frame.type === "pong")).toBe(false);

    keepAlive.scheduled[2]!.callback();
    expect(firstSocket.closed).toBe(true);
    expect(controller.subscribed).toBe(false);
    expect(reconnect.scheduled).toHaveLength(1);
    expect(reconnect.scheduled[0]?.delayMs).toBe(1000);

    firstSocket.emit("close");
    expect(reconnect.scheduled).toHaveLength(1);

    reconnect.scheduled[0]!.callback();
    await afterReconnect();
    completeHandshake(secondSocket);
    expect(controller.subscribed).toBe(true);
    expect(sockets).toEqual([]);
  });

  it("resolves the user id again across a silence-timeout reconnect", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const userIds = ["78020132", "99031425"];
    const resolveUserId = vi.fn(async () => userIds.shift());
    const controller = createPushController({
      createWebSocket: () => sockets.shift()!,
      getAuthToken: async () => "token",
      resolveUserId,
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await handshake(firstSocket, controller, () => undefined);
    expect(resolveUserId).toHaveBeenCalledOnce();

    keepAlive.scheduled.at(-1)!.callback();
    expect(firstSocket.closed).toBe(true);
    reconnect.scheduled[0]!.callback();
    await afterReconnect();
    completeHandshake(secondSocket);

    expect(controller.subscribed).toBe(true);
    expect(resolveUserId).toHaveBeenCalledTimes(2);
    expect(parsedSent(secondSocket)).toContainEqual(expect.objectContaining({
      type: "subscribe",
      subscribe: expect.objectContaining({
        pubsub: { topic: "community-points-user-v1.99031425" },
      }),
    }));
  });

  it("stop closes the socket, cancels timers, and does not reconnect", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const createWebSocket = vi.fn(() => sockets.shift()!);
    const controller = createPushController({
      createWebSocket,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
      cancelReconnect: reconnect.cancelReconnect,
    });
    await handshake(firstSocket, controller, () => undefined);

    await controller.stop();
    expect(firstSocket.closed).toBe(true);
    expect(controller.subscribed).toBe(false);
    expect(keepAlive.scheduled[1]?.cancelled).toBe(true);
    expect(reconnect.scheduled).toHaveLength(0);

    keepAlive.scheduled[1]!.callback();
    firstSocket.emit("close");
    expect(reconnect.scheduled).toHaveLength(0);
    expect(createWebSocket).toHaveBeenCalledOnce();

    await controller.start(() => undefined);
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    expect(sockets).toEqual([]);
  });

  it("start while already running does not open a second socket but replaces onClaimAvailable", async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const firstClaim = vi.fn();
    const nextClaim = vi.fn();
    const keepAlive = keepAliveScheduler();
    const controller = createPushController({
      createWebSocket,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
    });
    await handshake(socket, controller, firstClaim);
    await controller.start(nextClaim);

    expect(createWebSocket).toHaveBeenCalledOnce();
    socket.message(pubsubNotification(currentSubscriptionId(socket), {
      type: "claim-available",
      data: {
        claim: {
          id: "fd29a0b3-f804-4f58-905d-b33f235951c8",
          channel_id: "119415848",
        },
      },
    }));
    expect(firstClaim).not.toHaveBeenCalled();
    expect(nextClaim).toHaveBeenCalledOnce();
    expect(nextClaim).toHaveBeenCalledWith({
      claimId: "fd29a0b3-f804-4f58-905d-b33f235951c8",
      channelId: "119415848",
    });
  });

  it("reconnects with exponential backoff after unexpected close", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const thirdSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket, thirdSocket];
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => sockets.shift()!,
      getAuthToken: async () => "token",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await handshake(firstSocket, controller, () => undefined);
    expect(controller.subscribed).toBe(true);

    firstSocket.emit("close");
    expect(controller.subscribed).toBe(false);
    expect(reconnect.scheduled[0]?.delayMs).toBe(1000);

    reconnect.scheduled[0]!.callback();
    await afterReconnect();
    secondSocket.emit("close");
    expect(reconnect.scheduled[1]?.delayMs).toBe(2000);

    reconnect.scheduled[1]!.callback();
    await afterReconnect();
    completeHandshake(thirdSocket);
    expect(controller.subscribed).toBe(true);

    thirdSocket.emit("close");
    expect(controller.subscribed).toBe(false);
    expect(reconnect.scheduled[2]?.delayMs).toBe(1000);
    expect(sockets).toEqual([]);
  });

  it("closes and reconnects when authenticateResponse is not ok", async () => {
    const socket = new FakeSocket();
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start(() => undefined);
    socket.message(WELCOME);
    const authenticate = JSON.parse(socket.sent[0]!);
    socket.message({
      type: "authenticateResponse",
      authenticateResponse: { result: "unauthenticated" },
      parentId: authenticate.id,
      id: "auth-fail",
      timestamp: "2026-09-11T16:09:08.100Z",
    });

    expect(parsedSent(socket).some((frame) => frame.type === "subscribe")).toBe(false);
    expect(controller.subscribed).toBe(false);
    expect(socket.closed).toBe(true);
    expect(reconnect.scheduled).toHaveLength(1);
    expect(reconnect.scheduled[0]?.delayMs).toBe(1000);
    expect(JSON.stringify(controller.drainEvents())).not.toContain("auth-token-value");
  });

  it.each([
    { name: "rejected", response: { result: "unauthorized" } },
    { name: "malformed", response: undefined },
  ])("closes and reconnects when subscribeResponse is $name", async ({ response }) => {
    const socket = new FakeSocket();
    const keepAlive = keepAliveScheduler();
    const reconnect = reconnectScheduler();
    const controller = createPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => "78020132",
      scheduleKeepAlive: keepAlive.scheduleKeepAlive,
      cancelKeepAlive: keepAlive.cancelKeepAlive,
      scheduleReconnect: reconnect.scheduleReconnect,
    });
    await controller.start(() => undefined);
    socket.message(WELCOME);
    const authenticate = JSON.parse(socket.sent[0]!);
    socket.message({
      type: "authenticateResponse",
      authenticateResponse: { result: "ok" },
      parentId: authenticate.id,
    });
    const subscribe = JSON.parse(socket.sent[1]!);
    socket.message({
      type: "subscribeResponse",
      subscribeResponse: response,
      parentId: subscribe.id,
    });

    expect(controller.subscribed).toBe(false);
    expect(socket.closed).toBe(true);
    expect(reconnect.scheduled).toHaveLength(1);
    expect(reconnect.scheduled[0]?.delayMs).toBe(1000);
    expect(JSON.stringify(controller.drainEvents())).not.toContain("auth-token-value");
  });
});

describe("Twitch channel-points push adapter factory", () => {
  it("exposes a Hermes observer only when websocket and auth token deps exist", () => {
    const fetcher = { fetchJson: async <T,>(): Promise<T> => ({}) as T };
    expect(twitchAdapter(fetcher).createChannelPointsPushController).toBeUndefined();

    const observer = twitchAdapter(
      fetcher,
      undefined,
      undefined,
      { webSocketFactory: () => new FakeSocket(), getAuthToken: async () => "token" },
    ).createChannelPointsPushController?.();

    expect(observer).toBeInstanceOf(TwitchChannelPointsPushController);
  });
});
