import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CAPABILITIES, createBackgroundController } from "@lurkloot/core/controller";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type {
  ChannelCandidate,
  ChannelCheck,
  EngineSettings,
  Platform,
  PlatformAuthHealth,
} from "@lurkloot/shared/models";
import { loadCredentials, saveCredentials, type PlatformCredentials } from "../src/authStore";
import { createLogger } from "../src/logger";
import { runLoop } from "../src/runtime/run";
import { DEFAULT_CLI_SETTINGS, toEngineSettings, type CliSettings } from "../src/settings";
import { createCredentialRefreshingTransport, type TransportHandle } from "../src/transport";
import { createCliAdapters } from "../src/transport/common";
import {
  createNodeTwitchHermesWebSocketFactory,
  type HermesSocketOptions,
} from "../src/transport/twitchHermes";
import { TWITCH_ANDROID_CLIENT_ID, TWITCH_WEB_CLIENT_ID } from "../src/twitch";

const HEALTHY: PlatformAuthHealth = {
  status: "healthy",
  message: { key: "authHealthy" },
  accountId: "123",
};

class FakeHermesSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.listeners.get("close")?.forEach((listener) => listener({}));
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  message(frame: Record<string, unknown>): void {
    this.listeners.get("message")?.forEach((listener) => listener({ data: JSON.stringify(frame) }));
  }

  authenticate(result = "ok"): void {
    this.readyState = 1;
    this.message({ type: "welcome" });
    this.message({
      type: "authenticateResponse",
      parentId: this.sent.at(-1)?.id,
      authenticateResponse: { result },
    });
  }

  requestedSubscription(topicPrefix: string): Record<string, unknown> | undefined {
    return this.sent.find((message) => {
      const subscription = message.subscribe as { pubsub?: { topic: string } } | undefined;
      return subscription?.pubsub?.topic.startsWith(topicPrefix);
    });
  }

  respondToSubscription(topicPrefix: string, result: "ok" | "denied" = "ok"): void {
    const frame = this.requestedSubscription(topicPrefix);
    expect(frame).toBeDefined();
    const subscription = frame!.subscribe as { id: string };
    this.message({
      type: "subscribeResponse",
      parentId: frame!.id,
      subscribeResponse:
        result === "ok" ? { result, subscription: { id: subscription.id } } : { result },
    });
  }
}

function fakeAdapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => HEALTHY,
    refreshCampaigns: async () => [],
    listCandidateChannels: async () => [],
    checkChannel: async (candidate: ChannelCandidate): Promise<ChannelCheck> => ({
      live: false,
      categoryMatches: false,
      candidate,
    }),
    claimReward: async () => false,
  };
}

const WEB: PlatformCredentials = {
  twitch: { authToken: "web-token", clientId: TWITCH_WEB_CLIENT_ID, deviceId: "device" },
};
const ANDROID: PlatformCredentials = {
  twitch: { authToken: "android-token", clientId: TWITCH_ANDROID_CLIENT_ID },
};

// Discovery is offline, but the push factory and credential reload path are
// the same ones used in run and serve.
function hermesTransport(
  creds: PlatformCredentials = WEB,
  createSocket?: (url: string, options: HermesSocketOptions) => WebSocketLike,
  isLive = () => false,
): { transport: TransportHandle; sockets: FakeHermesSocket[] } {
  const sockets: FakeHermesSocket[] = [];
  const viewerId = () => (creds.twitch?.authToken === "new-web-token" ? "456" : "123");
  const cli = createCliAdapters(creds, {
    twitchFetcher: () => ({
      fetchJson: async <T>() =>
        ({ data: { currentUser: { id: viewerId(), login: "viewer" } } }) as T,
    }),
    twitchHeartbeat: () => ({
      heartbeatFetchText: async () => "",
      heartbeatPost: async () => ({ status: 200 }),
      heartbeatExchange: async () => ({ status: 200, body: "" }),
    }),
    kickFetcher: () => ({ fetchJson: async <T>() => ({}) as T }),
    twitchHermesWebSocketFactory: () =>
      createNodeTwitchHermesWebSocketFactory(
        createSocket
          ?? ((url) => {
            const socket = new FakeHermesSocket(url);
            sockets.push(socket);
            return socket;
          }),
      ),
  });
  const twitch = fakeAdapter("twitch");
  const kick = fakeAdapter("kick");
  const build = (platform: Platform, emit: EventEmitter, settings: EngineSettings) => {
    const built = cli.createAdapter(platform, emit, settings).adapter;
    if (platform === "kick") return kick;
    return {
      ...twitch,
      checkAuthHealth: async () => ({ ...HEALTHY, accountId: viewerId() }),
      createChannelPointsPushController: built.createChannelPointsPushController,
      channelPointsPushRevision: built.channelPointsPushRevision,
      checkChannel: async (candidate: ChannelCandidate) => ({
        live: isLive(),
        categoryMatches: true,
        candidate: { ...candidate, channelId: "22", broadcastId: "33" },
      }),
      supportsTabless: true,
      createTablessWatcher: built.createTablessWatcher?.bind(built),
    };
  };
  const compatibility = resolveCompatibility(DEFAULT_CLI_SETTINGS.compatibility, {
    host: "cli",
    twitchIdentity: "web",
  });
  return {
    sockets,
    transport: {
      adapters: { twitch, kick },
      createAdapter: (platform, emit, settings) => ({
        adapter: build(platform, emit, settings),
        ...compatibility,
      }),
      createAdapters: (emit, settings) => ({
        adapters: { twitch: build("twitch", emit, settings), kick: build("kick", emit, settings) },
        ...compatibility,
      }),
      dispose: async () => {},
    },
  };
}

function controllerFor(transport: TransportHandle) {
  const settings = toEngineSettings(SETTINGS);
  let state = structuredClone(DEFAULT_STATE);
  const events: EngineEvent[] = [];
  const controller = createBackgroundController({
    capabilities: CLI_CAPABILITIES,
    storage: {
      loadSettings: async () => settings,
      saveSettings: async () => {},
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      },
    },
    adapters: transport,
    events: {
      report: async (batch) => {
        events.push(...batch);
      },
      notify: async () => {},
    },
    jobs: { ensure: async () => {}, cancel: async () => false, get: async () => undefined },
    twitch: {},
  });
  return { controller, events, state: () => state };
}

// A maintained watch streak wants the channel-points topic whatever the claim
// settings say, so the push starts once the tick commits healthy auth.
const SETTINGS: CliSettings = {
  ...DEFAULT_CLI_SETTINGS,
  platform: {
    twitch: {
      ...DEFAULT_CLI_SETTINGS.platform.twitch,
      enabled: true,
      watchlistChannels: ["ordinary", "streaker"],
      watchlistStreakChannels: ["streaker"],
    },
    kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-run-hermes-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("runLoop and the Twitch Hermes socket", () => {
  it("closes the socket a one-shot run opened before it returns", async () => {
    const sockets: FakeHermesSocket[] = [];
    const { transport } = hermesTransport(WEB, (url) => {
      const socket = new FakeHermesSocket(url);
      const close = socket.close.bind(socket);
      socket.close = () => {
        socket.readyState = WebSocket.CLOSING;
        setTimeout(close, 10);
      };
      sockets.push(socket);
      return socket;
    });
    await runLoop({
      settings: SETTINGS,
      statePath: join(dir, "state.json"),
      transport,
      logger: createLogger("error"),
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    expect(sockets.map((socket) => socket.url)).toEqual([
      `wss://hermes.twitch.tv/v1?clientId=${TWITCH_WEB_CLIENT_ID}`,
    ]);
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  it.each(["SIGTERM", "stdin EOF"])("waits for a real socket to close on %s", async (reason) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (peer) => peer.pause());
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    let socket: WebSocket | undefined;
    const { transport } = hermesTransport(WEB, (_url, options) => {
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1`, options);
      return socket as unknown as WebSocketLike;
    });
    const stop = new AbortController();
    const running = runLoop({
      settings: SETTINGS,
      statePath: join(dir, "state.json"),
      transport,
      logger: createLogger("error"),
      stopSignal: stop.signal,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    try {
      await vi.waitFor(() => expect(socket?.readyState).toBe(WebSocket.OPEN));
      if (reason === "SIGTERM") process.emit("SIGTERM");
      else stop.abort("stdin EOF");
      await running;
      expect(socket?.readyState).toBe(WebSocket.CLOSED);
    } finally {
      stop.abort();
      await running;
      for (const peer of server.clients) {
        peer.terminate();
        peer.resume();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([WEB, ANDROID])(
    "follows the new web account after a credential reload ($twitch.clientId)",
    async (initial) => {
      saveCredentials(dir, initial);
      const creds = loadCredentials(dir, {});
      const { transport, sockets } = hermesTransport(creds);
      const { controller } = controllerFor(
        createCredentialRefreshingTransport(transport, creds, dir, {}),
      );
      try {
        await controller.tick(["twitch"]);
        const wasWeb = initial === WEB;
        expect(sockets).toHaveLength(wasWeb ? 1 : 0);
        const original = sockets[0];
        original?.authenticate();
        original?.respondToSubscription("community-points-user-v1.");
        await controller.tick(["twitch"]);
        expect(sockets).toHaveLength(wasWeb ? 1 : 0);
        saveCredentials(dir, { twitch: { ...WEB.twitch, authToken: "new-web-token" } });
        await controller.tick(["twitch"]);
        expect(sockets).toHaveLength(wasWeb ? 2 : 1);
        if (original) expect(original.readyState).toBe(WebSocket.CLOSED);
        const current = sockets.at(-1)!;
        current.authenticate();
        expect(current.sent).toContainEqual(
          expect.objectContaining({
            type: "authenticate",
            authenticate: { token: "new-web-token" },
          }),
        );
        expect(current.sent).toContainEqual(
          expect.objectContaining({
            type: "subscribe",
            subscribe: expect.objectContaining({
              pubsub: { topic: "community-points-user-v1.456" },
            }),
          }),
        );
      } finally {
        await controller.shutdown();
      }
    },
  );

  it.each(["upgrade", "authenticate", "points subscription"])(
    "suspends streaks across hours of %s refusals and recovers on confirmation",
    async (failure) => {
      vi.useFakeTimers();
      let refused = true;
      let live = false;
      let playbackConfirmations = 0;
      const sockets: FakeHermesSocket[] = [];
      const { transport } = hermesTransport(
        WEB,
        (url) => {
          const socket = new FakeHermesSocket(url);
          sockets.push(socket);
          setTimeout(() => {
            if (socket.readyState === WebSocket.CLOSED) return;
            if (refused && failure === "upgrade") {
              socket.close();
              return;
            }
            socket.authenticate(refused && failure === "authenticate" ? "denied" : "ok");
            if (refused && failure === "points subscription") {
              // There is no playback topic until the ordinary Watchlist channel starts.
              if (socket.requestedSubscription("video-playback-by-id.")) {
                socket.respondToSubscription("video-playback-by-id.");
                playbackConfirmations += 1;
              }
              socket.respondToSubscription("community-points-user-v1.", "denied");
            }
          }, 0);
          return socket;
        },
        () => live,
      );
      const { controller, events, state } = controllerFor(transport);
      const streaks = () => state().watchStreaks?.twitch;
      try {
        await controller.tick(["twitch"]);
        for (let minute = 0; minute < 180; minute += 1) {
          await vi.advanceTimersByTimeAsync(60_000);
          await controller.tick(["twitch"]);
          if (minute === 0) {
            expect(streaks()?.observerAvailable).toBe(false);
            live = true;
          }
          expect(streaks()?.attempts).toEqual([]);
        }
        expect(sockets.length).toBeGreaterThanOrEqual(3);
        expect(sockets.length).toBeLessThanOrEqual(13);
        if (failure === "points subscription") expect(playbackConfirmations).toBeGreaterThan(0);
        expect(streaks()?.observerAvailable).toBe(false);
        expect(state().sessions.twitch.channel?.username).toBe("ordinary");
        const warnings = events.filter(
          (event) =>
            event.category === "diagnostic"
            && event.level === "warn"
            && event.message.includes("Twitch channel-points push is unavailable"),
        );
        expect(warnings).toHaveLength(1);

        refused = false;
        const attemptsBeforeRecovery = sockets.length;
        for (
          let elapsed = 0;
          elapsed < 30 * 60_000 && sockets.length === attemptsBeforeRecovery;
          elapsed += 10_000
        ) {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(sockets).toHaveLength(attemptsBeforeRecovery + 1);
        const recovered = sockets.at(-1)!;
        recovered.respondToSubscription("video-playback-by-id.");
        await controller.tick(["twitch"]);
        expect(streaks()?.observerAvailable).toBe(false);
        recovered.respondToSubscription("community-points-user-v1.");
        await controller.tick(["twitch"]);
        expect(streaks()?.observerAvailable).toBe(true);
        expect(streaks()?.attempts).toHaveLength(1);
        expect(state().sessions.twitch.channel?.username).toBe("streaker");
      } finally {
        await controller.shutdown();
      }
    },
  );
});
