import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { KICK_REALTIME_AUTH_URL, KICK_REALTIME_CONNECTION_URL } from "@lurkloot/core/kick/realtime";
import type { WebSocketLike } from "@lurkloot/core/webSocket";
import type { ChannelCandidate, DropCampaign } from "@lurkloot/shared/models";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import { type FarmingController, runLoop } from "../src/runtime/run";
import { serveLoop } from "../src/runtime/serve";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { createCredentialRefreshingTransport, createTransport } from "../src/transport";
import type { CycleTlsClient } from "../src/transport/cycle";
import { fakeCycleTls } from "./helpers/fakeCycleTls";
import { createImpersonateTransport } from "../src/transport/impersonate";

const createSocket = vi.hoisted(() => vi.fn());
vi.mock("ws", () => ({
  default: class {
    constructor(url: string, options: ClientOptions) {
      return createSocket(url, options);
    }
  },
}));

const SOCKET_URL = "wss://realtime.us.platform.kick.com/connection/websocket";
const PUSHER_URL =
  "wss://ws-us2.pusher.com/app/test?protocol=7&client=js&version=8.4.0&flash=false";
const CHAT_URL = "https://web.kick.com/api/v1/realtime/channels/42/chat/connection";
const ENABLED = { twitch: false, kick: true };
const CHANNEL: ChannelCandidate = {
  platform: "kick",
  username: "creator",
  url: "https://kick.com/creator",
  categoryId: "7",
};
const CAMPAIGN: DropCampaign = {
  id: "campaign",
  platform: "kick",
  name: "Campaign",
  categoryId: "7",
  status: "active",
  rewards: [
    {
      id: "reward",
      name: "Reward",
      requiredMinutes: 60,
      watchedMinutes: 10,
      status: "in_progress",
    },
  ],
};

let dir: string;
beforeEach(async () => {
  createSocket.mockReset();
  dir = await mkdtemp(join(tmpdir(), "lurkloot-chat-presence-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function runOptions() {
  const settings = structuredClone(DEFAULT_CLI_SETTINGS);
  settings.platform.twitch.enabled = false;
  settings.platform.kick.enabled = true;
  settings.platform.kick.alwaysEnterChat = true;
  let state = structuredClone(DEFAULT_STATE);
  return {
    settings,
    statePath: join(dir, "state.json"),
    stateStore: {
      load: async () => state,
      save: async (next: typeof state) => {
        state = next;
      },
    },
    logger: createLogger("error"),
  };
}

function mockRealtime(endpoint = SOCKET_URL) {
  const close = vi.fn();
  const subscribed: string[] = [];
  const requests = vi.fn(async (url: string, _options?: { body?: string }) => {
    if (url === KICK_REALTIME_CONNECTION_URL) {
      return {
        status: 200,
        data: {
          data: { connections: [{ provider: "pusher", credentials: { app_key: "test" } }] },
        },
      };
    }
    if (url === CHAT_URL) {
      return {
        status: 200,
        data: {
          data: { connections: [{ provider: "centrifugo", credentials: { url: endpoint } }] },
        },
      };
    }
    if (url === KICK_REALTIME_AUTH_URL) return { status: 200, data: { token: "realtime-token" } };
    if (url === "https://kick.com/api/v2/channels/creator")
      return { status: 200, data: { id: 42, chatroom: { id: 43 } } };
    throw new Error(`Unexpected request ${url}`);
  });
  const exit = vi.fn(async () => undefined);
  const client = fakeCycleTls(requests, exit);

  createSocket.mockImplementation((url: string) => {
    const listeners = new Map<string, (event: { data?: string }) => void>();
    const receive = (frame: object) =>
      queueMicrotask(() => listeners.get("message")?.({ data: JSON.stringify(frame) }));
    queueMicrotask(() => listeners.get("open")?.({}));
    if (url === PUSHER_URL) receive({ event: "pusher:connection_established" });
    return {
      readyState: 1,
      close: () => close(url),
      addEventListener: (type, listener) => listeners.set(type, listener),
      send: (data) => {
        const frame = JSON.parse(data);
        if (frame.subscribe) subscribed.push(frame.subscribe.channel);
        if (frame.connect || frame.subscribe) {
          const reply = frame.connect ? { connect: {} } : { subscribe: {} };
          receive({ id: frame.id, ...reply });
        }
        if (frame.event === "pusher:subscribe") {
          subscribed.push(frame.data.channel);
          receive({ event: "pusher_internal:subscription_succeeded", channel: frame.data.channel });
        }
      },
    } satisfies WebSocketLike;
  });

  return { client, close, subscribed, requests, exit };
}

async function refreshingImpersonate(client: CycleTlsClient) {
  const creds = { kick: { sessionToken: "example-token" } };
  const transport = await createImpersonateTransport(creds, ENABLED, {
    initClient: async () => client,
  });
  return createCredentialRefreshingTransport(transport, creds, "/unused", {
    SA_KICK_SESSION_TOKEN: "example-token",
  });
}

it("does not offer a Kick chat client on HTTP", async () => {
  const transport = await createTransport("http", {}, "/unused", ENABLED);
  try {
    expect(transport.adapters.kick.createChatPresenceClient).toBeUndefined();
    expect(transport.adapters.twitch.createChatPresenceClient).toBeDefined();
  } finally {
    await transport.dispose();
  }
});

it("does not send the Kick Origin to an unrecognized realtime endpoint", async () => {
  const { client } = mockRealtime("wss://realtime.example.com/connection/websocket");
  const transport = await refreshingImpersonate(client);
  const { adapter } = transport.createAdapter(
    "kick",
    () => {},
    toEngineSettings(runOptions().settings),
  );
  const presence = adapter.createChatPresenceClient!();
  try {
    await presence.follow({ username: "creator" });
    await vi.waitFor(() => expect(presence.status().state).toBe("error"));
    expect(createSocket).not.toHaveBeenCalled();
  } finally {
    await presence.stop();
    await transport.dispose();
  }
});

it("disposes the Kick chat socket even when the presence owner has not stopped", async () => {
  const { client, close, exit } = mockRealtime();
  const transport = await refreshingImpersonate(client);
  const { adapter } = transport.createAdapter(
    "kick",
    () => {},
    toEngineSettings(runOptions().settings),
  );
  const presence = adapter.createChatPresenceClient!();

  try {
    await presence.follow({ username: "creator" });
    await vi.waitFor(() => expect(presence.status().state).toBe("joined"));
    expect(close).not.toHaveBeenCalled();
  } finally {
    await transport.dispose();
  }

  expect(close).toHaveBeenCalledExactlyOnceWith(SOCKET_URL);
  expect(exit).toHaveBeenCalledOnce();
});

it.each([
  { shutdown: "--once", chat: true },
  { shutdown: "SIGTERM", chat: true },
  { shutdown: "stdin EOF", chat: true },
  { shutdown: "--once", chat: false },
] as const)(
  "keeps Kick discovery and chat separate ($shutdown, chat=$chat)",
  async ({ shutdown, chat }) => {
    const { client, close, subscribed, requests, exit } = mockRealtime();
    const transport = await refreshingImpersonate(client);
    const options = runOptions();
    options.settings.platform.kick.alwaysEnterChat = chat;

    expect(transport.adapters.kick.createChatPresenceClient).toBeDefined();
    const createAdapter = transport.createAdapter;
    const dispose = transport.dispose;
    const closedBeforeDispose = vi.fn();
    transport.createAdapter = (platform, emit, settings) => {
      const construction = createAdapter(platform, emit, settings);
      if (platform === "kick") {
        // Keep real discovery signals and chat presence, with a deterministic
        // campaign and viewer heartbeat so the viewer socket stays out of the test.
        Object.assign(construction.adapter, {
          checkAuthHealth: async () => ({ status: "healthy" }),
          refreshCampaigns: async () => [CAMPAIGN],
          listCandidateChannels: async () => [CHANNEL],
          checkChannels: undefined,
          checkChannel: async () => ({
            live: true,
            campaignMatches: true,
            categoryMatches: true,
            candidate: CHANNEL,
          }),
          createTablessWatcher: () => ({
            platform: "kick",
            channelUrl: CHANNEL.url,
            start: async () => {},
            tick: async () => ({ ok: true, live: true }),
            stop: async () => {},
            drainEvents: () => [],
          }),
        });
      }
      return construction;
    };
    transport.dispose = async () => {
      closedBeforeDispose(close.mock.calls.length);
      await dispose();
    };
    let controller: FarmingController | undefined;
    const input = shutdown === "stdin EOF" ? new PassThrough() : undefined;
    const running = input
      ? serveLoop({
          ...options,
          transport,
          binding: { host: "127.0.0.1", port: 0 },
          appRoot: null,
          describeCredentials: () => describeCredentialHealth("/unused", {}),
          exitWithInput: input,
        })
      : runLoop({
          ...options,
          transport,
          once: shutdown === "--once",
          startHost: async (started) => {
            controller = started;
            return { close: async () => {} };
          },
        });
    if (input) {
      try {
        await vi.waitFor(() => expect(subscribed).toContain("chatrooms.43.v2"));
      } finally {
        input.end();
        await running;
      }
    } else if (shutdown === "SIGTERM") {
      try {
        await vi.waitFor(async () => {
          const snapshot = await controller?.handleMessage({ type: "getSnapshot" });
          expect(snapshot).toMatchObject({
            state: { chatPresence: { kick: { state: "joined", channel: "creator" } } },
          });
        });
      } finally {
        process.emit("SIGTERM");
        await running;
      }
    } else {
      await running;
    }

    expect(createSocket).toHaveBeenCalledWith(PUSHER_URL, {
      headers: {
        Origin: "https://kick.com",
        Referer: "https://kick.com/",
        "User-Agent": expect.any(String),
      },
      handshakeTimeout: 10_000,
    });
    expect(requests).toHaveBeenCalledWith(
      KICK_REALTIME_CONNECTION_URL,
      expect.objectContaining({
        body: expect.any(String),
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }),
      "post",
    );
    const discoveryOptions = requests.mock.calls.find(
      ([url]) => url === KICK_REALTIME_CONNECTION_URL,
    )?.[1];
    expect(JSON.parse(discoveryOptions?.body ?? "")).toMatchObject({
      capabilities: { accepted_providers: [{ provider: "pusher" }] },
    });
    expect(subscribed).toContain("drops_category_7");

    if (chat) {
      expect(createSocket).toHaveBeenCalledWith(SOCKET_URL, {
        headers: { Origin: "https://kick.com" },
        handshakeTimeout: 10_000,
      });
      expect(subscribed).toContain("chatrooms.43.v2");
      for (const url of [CHAT_URL, KICK_REALTIME_AUTH_URL]) {
        expect(requests).toHaveBeenCalledWith(
          url,
          expect.objectContaining({
            headers: expect.objectContaining({ "content-type": "application/json" }),
          }),
          "post",
        );
      }
      expect(close).toHaveBeenCalledWith(SOCKET_URL);
    } else {
      expect(requests.mock.calls.map(([url]) => url)).not.toContain(CHAT_URL);
      expect(subscribed).not.toContain("chatrooms.43.v2");
    }
    const expectedSockets = chat ? 2 : 1;
    expect(createSocket).toHaveBeenCalledTimes(expectedSockets);
    expect(closedBeforeDispose).toHaveBeenCalledExactlyOnceWith(expectedSockets);
    expect(close).toHaveBeenCalledWith(PUSHER_URL);
    expect(close).toHaveBeenCalledTimes(expectedSockets);
    expect(exit).toHaveBeenCalledOnce();
  },
);
