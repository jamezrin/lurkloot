import { afterEach, describe, expect, it, vi } from "vitest";
import { tickCapabilities } from "@lurkloot/core/background/tickEffects";
import type { CycleTLSClient } from "cycletls";
import type { PlatformCredentials } from "../src/authStore";
import { createHttpTransport } from "../src/transport/http";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { HERMES_CLOSE_TIMEOUT_MS } from "../src/transport/twitchHermes";
import {
  TWITCH_ANDROID_CLIENT_ID,
  TWITCH_SMARTBOX_CLIENT_ID,
  TWITCH_WEB_CLIENT_ID,
} from "../src/twitch";

// Every `ws` socket the CLI builds in this file, so the test sees the options
// the transports' default factories pass without opening a connection.
const created = vi.hoisted(
  () =>
    [] as Array<{
      url: string;
      options: unknown;
      readyState: number;
      sent: string[];
      closed: boolean;
      listeners: Map<string, Array<(event: { data?: unknown }) => void>>;
    }>,
);

vi.mock("ws", () => {
  class FakeWebSocket {
    static readonly CLOSED = 3;
    readyState = 0;
    sent: string[] = [];
    closed = false;
    listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    constructor(
      public url: string,
      public options: unknown,
    ) {
      created.push(this);
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      for (const listener of this.listeners.get("close") ?? []) listener({});
    }
  }
  return { default: FakeWebSocket };
});

const ENABLED = { twitch: true, kick: true };
const WEB: PlatformCredentials = {
  twitch: { authToken: "web-token", clientId: TWITCH_WEB_CLIENT_ID, deviceId: "device" },
};
const ANDROID: PlatformCredentials = {
  twitch: { authToken: "android-token", clientId: TWITCH_ANDROID_CLIENT_ID },
};
const SMART_TV: PlatformCredentials = {
  twitch: { authToken: "tv-token", clientId: TWITCH_SMARTBOX_CLIENT_ID },
};

const HERMES_URL = `wss://hermes.twitch.tv/v1?clientId=${TWITCH_WEB_CLIENT_ID}`;

function stubCurrentUser(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { currentUser: { id: "123", login: "viewer" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function fakeCycleClient(): CycleTLSClient {
  const client = vi.fn(async () => ({ status: 200, data: {} })) as unknown as CycleTLSClient;
  (client as unknown as { exit: () => Promise<void> }).exit = vi.fn(async () => undefined);
  return client;
}

afterEach(() => {
  created.splice(0);
  vi.unstubAllGlobals();
});

describe("CLI Twitch push (Hermes)", () => {
  it.each(["http", "impersonate"] as const)(
    "gives the %s transport's web sign-in a Hermes socket with only the web Origin",
    async (transport) => {
      stubCurrentUser();
      const handle =
        transport === "http"
          ? createHttpTransport(WEB, ENABLED)
          : await createImpersonateTransport(WEB, ENABLED, {
              initClient: async () => fakeCycleClient(),
            });
      try {
        const adapter = handle.adapters.twitch;
        expect(tickCapabilities(adapter, false).observeWatchStreaks).toBe(true);
        const controller = adapter.createChannelPointsPushController!();
        await controller.start({ onClaimAvailable: () => {} });

        const hermes = created.filter((socket) => socket.url.startsWith("wss://hermes."));
        expect(hermes).toHaveLength(1);
        const [socket] = hermes;
        expect(socket!.url).toBe(HERMES_URL);
        expect(socket!.options).toEqual({
          headers: { Origin: "https://www.twitch.tv" },
          handshakeTimeout: 10_000,
          closeTimeout: HERMES_CLOSE_TIMEOUT_MS,
        });
        expect(socket!.listeners.has("error")).toBe(true);

        // Hermes greets; the controller authenticates with the stored token.
        socket!.readyState = 1;
        for (const listener of socket!.listeners.get("message") ?? [])
          listener({ data: JSON.stringify({ type: "welcome", welcome: { keepaliveSec: 15 } }) });
        expect(JSON.parse(socket!.sent[0]!)).toMatchObject({
          type: "authenticate",
          authenticate: { token: "web-token" },
        });

        await controller.stop();
        expect(socket!.closed).toBe(true);
      } finally {
        await handle.dispose();
      }
    },
  );

  it("keeps chat presence on its own plain socket", async () => {
    stubCurrentUser();
    const handle = createHttpTransport(WEB, ENABLED);
    try {
      const client = handle.adapters.twitch.createChatPresenceClient!();
      await client.follow({ username: "prod" });
      await vi.waitFor(() =>
        expect(created.map((socket) => socket.url)).toContain("wss://irc-ws.chat.twitch.tv/"),
      );
      const chat = created.find((socket) => socket.url === "wss://irc-ws.chat.twitch.tv/");
      expect(chat!.options).toEqual({ handshakeTimeout: 10_000 });
      await client.stop();
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    ["Android (browser-login)", ANDROID],
    ["Smart TV (device-login)", SMART_TV],
  ])("leaves Hermes off for the %s sign-in on both transports", async (_name, creds) => {
    const http = createHttpTransport(creds, ENABLED);
    const impersonate = await createImpersonateTransport(creds, ENABLED, {
      initClient: async () => fakeCycleClient(),
    });
    try {
      for (const handle of [http, impersonate]) {
        const adapter = handle.adapters.twitch;
        expect(adapter.createChannelPointsPushController).toBeUndefined();
        expect(tickCapabilities(adapter, false).observeWatchStreaks).toBe(false);
        // Chat presence does not depend on Hermes.
        expect(adapter.createChatPresenceClient).toBeDefined();
      }
    } finally {
      await http.dispose();
      await impersonate.dispose();
    }
  });
});
