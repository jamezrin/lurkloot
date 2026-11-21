import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type {
  ChannelCandidate,
  ChannelCheck,
  EngineSettings,
  Platform,
} from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../src/authStore";
import { createLogger } from "../src/logger";
import { runLoop, type FarmingController } from "../src/runtime/run";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import type { TransportHandle } from "../src/transport";
import { createCliAdapters } from "../src/transport/common";
import { createNodeTwitchHermesWebSocketFactory } from "../src/transport/twitchHermes";
import { TWITCH_ANDROID_CLIENT_ID, TWITCH_WEB_CLIENT_ID } from "../src/twitch";
import { memoryStateStore } from "./helpers/fakeFarming";

// #1105: with a web sign-in, the CLI subscribes the watching Twitch Extension
// provider's Hermes broadcast topic with the provider session's JWT, and a
// refresh-worthy message refreshes the provider at once, as the extension does.

const login = "sample_viewer";
const channelId = "123";
const streamer = "sample_stream";
const nopixel = twitchExtensionProvider("nopixel")!;
const TOPIC = `channel-ext-v1.${channelId}-${nopixel.extensionId}-broadcast`;
const installation = {
  extension: { id: nopixel.extensionId, version: "1.1.4" },
  activationConfig: { state: "ACTIVE" },
};
const payload = Buffer.from(
  JSON.stringify({
    opaque_user_id: "Utest",
    user_id: "456",
    role: "viewer",
    channel_id: channelId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const JWT = `jwt-header.${payload}.jwt-signature`;

const WEB: PlatformCredentials = {
  twitch: { authToken: "web-oauth-value", clientId: TWITCH_WEB_CLIENT_ID, deviceId: "device" },
};
const ANDROID: PlatformCredentials = {
  twitch: { authToken: "android-oauth-value", clientId: TWITCH_ANDROID_CLIENT_ID },
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
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  message(frame: Record<string, unknown>): void {
    this.listeners.get("message")?.forEach((listener) => listener({ data: JSON.stringify(frame) }));
  }

  authenticate(): void {
    this.readyState = 1;
    this.message({ type: "welcome" });
    this.message({
      type: "authenticateResponse",
      parentId: this.sent.at(-1)?.id,
      authenticateResponse: { result: "ok" },
    });
  }

  extensionSubscription():
    | { id: string; subscribe: { id: string; type: string; extension: unknown } }
    | undefined {
    return this.sent.find(
      (frame) =>
        frame.type === "subscribe"
        && (frame.subscribe as { type?: string } | undefined)?.type === "extension",
    ) as never;
  }

  broadcast(subscriptionId: string, event: string): void {
    this.message({
      type: "notification",
      notification: {
        subscription: { id: subscriptionId },
        type: "pubsub",
        pubsub: JSON.stringify({
          content: [JSON.stringify({ event, payload: { secret: "payload-not-read" } })],
        }),
      },
    });
  }
}

// Twitch GQL as both the Hermes viewer lookup and the provider lane see it.
function gql(init?: RequestInit): unknown {
  const body = JSON.parse(String(init?.body ?? "{}"));
  switch ((Array.isArray(body) ? body[0] : body)?.operationName) {
    case "ExtensionDirectory":
      return {
        data: {
          game: {
            streams: {
              edges: [{ node: { id: "42", broadcaster: { id: channelId, login: streamer } } }],
            },
          },
        },
      };
    case "ExtensionInstallations":
      return {
        data: {
          users: [
            {
              id: channelId,
              login: streamer,
              channel: { selfInstalledExtensions: [{ installation }] },
            },
          ],
        },
      };
    case "CoordinatorExtensionsForChannel":
      return {
        data: {
          user: {
            channel: { selfInstalledExtensions: [{ installation, token: { jwt: JWT } }] },
          },
        },
      };
    default:
      return { data: { currentUser: { id: "456", login } } };
  }
}

function idle(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: async () => ({
      status: "healthy",
      message: { key: "authHealthy" },
      accountId: "456",
    }),
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

// The real CLI adapter factory supplies Hermes (web sign-ins only) and the
// lane's GQL access; discovery, watching and chat are offline fakes.
function transportFor(creds: PlatformCredentials) {
  const sockets: FakeHermesSocket[] = [];
  const cli = createCliAdapters(creds, {
    twitchFetcher: () => ({
      fetchJson: async <T>(_url: string, init?: RequestInit) => gql(init) as T,
    }),
    twitchHeartbeat: () => ({
      heartbeatFetchText: async () => "",
      heartbeatPost: async () => ({ status: 200 }),
      heartbeatExchange: async () => ({ status: 200, body: "" }),
    }),
    kickFetcher: () => ({ fetchJson: async <T>() => ({}) as T }),
    twitchHermesWebSocketFactory: () =>
      createNodeTwitchHermesWebSocketFactory((url) => {
        const socket = new FakeHermesSocket(url);
        sockets.push(socket);
        setTimeout(() => socket.authenticate(), 0);
        return socket;
      }),
  });
  let watching: string | undefined;
  const build = (
    platform: Platform,
    emit: Parameters<TransportHandle["createAdapter"]>[1],
    settings: EngineSettings,
  ) => {
    const built = cli.createAdapter(platform, emit, settings);
    if (platform === "kick") return { ...built, adapter: idle("kick") };
    const twitch: PlatformAdapter = {
      ...idle("twitch"),
      createChannelPointsPushController: built.adapter.createChannelPointsPushController,
      channelPointsPushRevision: built.adapter.channelPointsPushRevision,
      supportsTabless: true,
      createTablessWatcher: () => ({
        platform: "twitch",
        get channelUrl() {
          return watching;
        },
        start: async (channel) => {
          watching = channel.url;
        },
        tick: async () => ({ ok: true, live: true }),
        stop: async () => {
          watching = undefined;
        },
        drainEvents: () => [],
      }),
      createChatPresenceClient: () => ({
        follow: async () => {},
        stop: async () => {},
        status: () => ({ state: "left" }),
        drainEvents: () => [],
      }),
    };
    return { ...built, adapter: twitch };
  };
  const transport: TransportHandle = {
    adapters: { twitch: idle("twitch"), kick: idle("kick") },
    createAdapter: (platform, emit, settings) => build(platform, emit, settings),
    createAdapters: (emit, settings) => {
      const twitch = build("twitch", emit, settings);
      return {
        adapters: { twitch: twitch.adapter, kick: build("kick", emit, settings).adapter },
        compatibility: twitch.compatibility,
        warnings: twitch.warnings,
      };
    },
    twitchExtensionAccess: cli.twitchExtensionAccess,
    dispose: vi.fn(async () => undefined),
  };
  return { transport, sockets };
}

// The NoPixelV backend. Daily watch time is never complete, so the provider
// keeps the watch slot; every driver refresh reads `/channel/setup` first.
function stubNoPixel() {
  const setups = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const target = new URL(url);
      expect(target.origin).toBe("https://nopixel.streamingtoolsmith.com");
      if (target.pathname === "/channel/setup") {
        setups();
        return Response.json({
          is_channel_eligible_for_pack_giveaways: false,
          is_channel_eligible_for_watchtime_tracking: true,
          is_channel_connected_for_watchtime_tracking: true,
        });
      }
      if (target.pathname.endsWith("/progress"))
        return Response.json({ watch_time_earned: 10, watch_time_required: 60 });
      if (target.pathname === "/cards/packs") return Response.json([]);
      return new Response(null, { status: 204 });
    }),
  );
  return setups;
}

function settings() {
  const value = structuredClone(DEFAULT_CLI_SETTINGS);
  value.platform.kick.enabled = false;
  value.twitchExtensions.nopixel = { enabled: true, autoOpenPacks: true };
  return value;
}

async function snapshotOf(controller: FarmingController | undefined) {
  return (await controller?.handleMessage({ type: "getSnapshot" })) as
    | RuntimeSnapshot<EngineSettings>
    | undefined;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-extension-broadcast-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("runLoop and the Twitch Extension broadcast topic", () => {
  it("subscribes NoPixelV's topic with its session JWT and refreshes on a giveaway event", async () => {
    const setups = stubNoPixel();
    const { transport, sockets } = transportFor(WEB);
    const logger = createLogger("debug");
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const stop = new AbortController();
    let controller: FarmingController | undefined;
    const done = runLoop({
      statePath: join(dir, "state.json"),
      settings: settings(),
      transport,
      logger,
      stopSignal: stop.signal,
      stateStore: memoryStateStore(),
      checkCredentialAvailability: async () => ({ status: "available" }),
      startHost: async (running) => {
        controller = running;
        return { close: async () => {} };
      },
    });
    try {
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(controller);
        expect(snapshot?.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
        expect(sockets.at(-1)?.extensionSubscription()).toBeDefined();
      });
      const socket = sockets.at(-1)!;
      const frame = socket.extensionSubscription()!;
      expect(frame.subscribe.extension).toEqual({ topic: TOPIC, token: JWT });
      socket.message({
        type: "subscribeResponse",
        parentId: frame.id,
        subscribeResponse: { result: "ok", subscription: { id: frame.subscribe.id } },
      });
      await vi.waitFor(() => expect(setups).toHaveBeenCalled());
      await settle();

      // An event that is not one of the provider's refresh events changes nothing.
      const before = setups.mock.calls.length;
      socket.broadcast(frame.subscribe.id, "map.event.updated");
      await settle();
      expect(setups).toHaveBeenCalledTimes(before);

      socket.broadcast(frame.subscribe.id, "cards.giveaway.started");
      await vi.waitFor(() => expect(setups).toHaveBeenCalledTimes(before + 1));
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "debug",
          expect.stringContaining("nopixel announced cards.giveaway.started"),
          "twitch",
        ),
      );
      const snapshot = await snapshotOf(controller);
      expect(JSON.stringify(snapshot)).not.toContain(JWT);
    } finally {
      stop.abort();
      await done;
    }
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(JWT);
    expect(logged).not.toContain(payload);
    expect(logged).not.toContain("payload-not-read");
    expect(log.mock.calls.filter(([level]) => level === "warn" || level === "error")).toEqual([]);
    expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  });

  it("keeps polling NoPixelV on an Android sign-in, with no Hermes and no warning", async () => {
    const setups = stubNoPixel();
    const { transport, sockets } = transportFor(ANDROID);
    const logger = createLogger("debug");
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const stop = new AbortController();
    let controller: FarmingController | undefined;
    const done = runLoop({
      statePath: join(dir, "state.json"),
      settings: settings(),
      transport,
      logger,
      stopSignal: stop.signal,
      stateStore: memoryStateStore(),
      checkCredentialAvailability: async () => ({ status: "available" }),
      startHost: async (running) => {
        controller = running;
        return { close: async () => {} };
      },
    });
    try {
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(controller);
        expect(snapshot?.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
        expect(setups).toHaveBeenCalled();
      });
      await settle();
    } finally {
      stop.abort();
      await done;
    }
    expect(sockets).toEqual([]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(JWT);
    expect(logged).not.toContain("broadcast");
    expect(log.mock.calls.filter(([level]) => level === "warn" || level === "error")).toEqual([]);
  });
});
