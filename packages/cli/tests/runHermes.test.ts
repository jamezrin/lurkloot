import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type {
  ChannelCandidate,
  ChannelCheck,
  EngineSettings,
  Platform,
  PlatformAuthHealth,
} from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../src/authStore";
import { createLogger, type Logger } from "../src/logger";
import { runLoop } from "../src/runtime/run";
import { DEFAULT_CLI_SETTINGS, type CliSettings } from "../src/settings";
import type { TransportHandle } from "../src/transport";
import { createCliAdapters } from "../src/transport/common";
import { createNodeTwitchHermesWebSocketFactory } from "../src/transport/twitchHermes";
import { TWITCH_ANDROID_CLIENT_ID, TWITCH_WEB_CLIENT_ID } from "../src/twitch";

const HEALTHY: PlatformAuthHealth = {
  status: "healthy",
  message: { key: "authHealthy" },
  accountId: "123",
};

interface HermesSocket extends WebSocketLike {
  url: string;
  closed: boolean;
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

// Discovery is a fake that finds nothing, so the tick is quick and offline.
// Every adapter build still goes through the CLI's own construction, so the
// Twitch push factory, and the warning a sign-in without one logs, are the
// CLI's. The Hermes factory is the CLI's too, over a socket that never
// connects.
function hermesTransport(creds: PlatformCredentials = WEB): {
  transport: TransportHandle;
  sockets: HermesSocket[];
} {
  const sockets: HermesSocket[] = [];
  const cli = createCliAdapters(creds, {
    twitchFetcher: () => ({
      fetchJson: async <T>() => ({ data: { currentUser: { id: "123", login: "viewer" } } }) as T,
    }),
    twitchHeartbeat: () => ({
      heartbeatFetchText: async () => "",
      heartbeatPost: async () => ({ status: 200 }),
      heartbeatExchange: async () => ({ status: 200, body: "" }),
    }),
    kickFetcher: () => ({ fetchJson: async <T>() => ({}) as T }),
    twitchHermesWebSocketFactory: () =>
      createNodeTwitchHermesWebSocketFactory((url) => {
        const socket: HermesSocket = {
          url,
          closed: false,
          readyState: 0,
          send: () => {},
          close: () => {
            socket.closed = true;
            socket.readyState = 3;
          },
          addEventListener: () => {},
        };
        sockets.push(socket);
        return socket;
      }),
  });
  const twitch = fakeAdapter("twitch");
  const kick = fakeAdapter("kick");
  const build = (platform: Platform, emit: EventEmitter, settings: EngineSettings) => {
    const built = cli.createAdapter(platform, emit, settings).adapter;
    if (platform === "kick") return kick;
    twitch.createChannelPointsPushController = built.createChannelPointsPushController;
    return twitch;
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

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (level: LogLevel, message: string, scope?: string) =>
    lines.push(`${level} ${scope ?? ""} ${message}`);
  return {
    lines,
    level: "debug",
    log: record,
    debug: (message, scope) => record("debug", message, scope),
    info: (message, scope) => record("info", message, scope),
    warn: (message, scope) => record("warn", message, scope),
    error: (message, scope) => record("error", message, scope),
  };
}

// A maintained watch streak wants the channel-points topic whatever the claim
// settings say, so the push starts once the tick commits healthy auth.
const SETTINGS: CliSettings = {
  ...DEFAULT_CLI_SETTINGS,
  platform: {
    twitch: {
      ...DEFAULT_CLI_SETTINGS.platform.twitch,
      enabled: true,
      watchlistChannels: ["streaker"],
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
  await rm(dir, { recursive: true, force: true });
});

describe("runLoop and the Twitch Hermes socket", () => {
  it("closes the socket a one-shot run opened before it returns", async () => {
    const { transport, sockets } = hermesTransport();
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
    expect(sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("closes the socket on SIGTERM before the loop returns", async () => {
    const { transport, sockets } = hermesTransport();
    const running = runLoop({
      settings: SETTINGS,
      statePath: join(dir, "state.json"),
      transport,
      logger: createLogger("error"),
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(sockets[0]!.closed).toBe(false);
    } finally {
      process.emit("SIGTERM");
      await running;
    }
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("logs once that an Android sign-in keeps polling, and opens no socket", async () => {
    const { transport, sockets } = hermesTransport(ANDROID);
    const logger = recordingLogger();
    await runLoop({
      settings: SETTINGS,
      statePath: join(dir, "state.json"),
      transport,
      logger,
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    const warnings = logger.lines.filter((line) => line.includes("Twitch push (Hermes) is off"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^warn twitch /);
    expect(sockets).toEqual([]);
  });
});
