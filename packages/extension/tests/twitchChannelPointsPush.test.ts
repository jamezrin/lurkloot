import { describe, expect, it, vi } from "vitest";
import { TwitchChannelPointsPushController } from "@lurkloot/core/twitch/channelPointsPush";
import type { WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";

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

void keepAliveScheduler;

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

const handshake = async (
  socket: FakeSocket,
  controller: TwitchChannelPointsPushController,
  onClaim: (notice: { claimId: string; channelId: string }) => void,
): Promise<void> => {
  await controller.start(onClaim);
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
    const controller = new TwitchChannelPointsPushController({
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
    const controller = new TwitchChannelPointsPushController({
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
    const controller = new TwitchChannelPointsPushController({
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

  it("does not subscribe when authenticateResponse is not ok", async () => {
    const socket = new FakeSocket();
    const controller = new TwitchChannelPointsPushController({
      createWebSocket: () => socket,
      getAuthToken: async () => "auth-token-value",
      resolveUserId: async () => "78020132",
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
  });

  it("notifies only for claim-available on the community-points subscription", async () => {
    const socket = new FakeSocket();
    const onClaim = vi.fn();
    const controller = new TwitchChannelPointsPushController({
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
    const controller = new TwitchChannelPointsPushController({
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
    const controller = new TwitchChannelPointsPushController({
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
