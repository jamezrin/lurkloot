import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import { runLoop } from "../src/runtime/run";
import { createLogger } from "../src/logger";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";
import type { EventEmitter } from "node:events";
import { FORTNITE_SOCKET_URL } from "@lurkloot/core/extensions/fortnite/socket";
import { beforeEach, expect, it, vi } from "vitest";
import { createFortniteSockets } from "../src/runtime/fortniteSockets";

const { upgrades, socketState } = vi.hoisted(() => ({
  upgrades: vi.fn(),
  socketState: { defer: false, close: vi.fn(), finish: undefined as (() => void) | undefined },
}));
beforeEach(() => {
  upgrades.mockClear();
  socketState.close.mockClear();
  socketState.defer = false;
  socketState.finish = undefined;
});
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class FakeWebSocket extends EventEmitter {
      constructor(url: URL, options: unknown) {
        super();
        upgrades(url.href, options);
      }
      readyState = 0;
      addEventListener = this.on.bind(this);
      removeEventListener = this.off.bind(this);
      close() {
        if (this.readyState !== 0) return;
        this.readyState = 2;
        socketState.close();
        const finish = () => {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.emit("error", new Error("upgrade cancelled"));
          this.emit("close");
        };
        if (socketState.defer) socketState.finish = finish;
        else queueMicrotask(finish);
      }
    },
  };
});

it("only opens the provider endpoint with its frame Origin and drains close", async () => {
  const factory = createFortniteSockets();
  const badUrls = [
    "wss://viewer:password@backend.p-n6412w7dsu.exmggames.com/handler",
    "wss://backend.p-n6412w7dsu.exmggames.com:81/handler",
    "wss://backend.p-n6412w7dsu.exmggames.com.evil.example/handler",
    FORTNITE_SOCKET_URL.replace("wss:", "ws:"),
    FORTNITE_SOCKET_URL.replace("/handler", "/other"),
    `${FORTNITE_SOCKET_URL}?token=unexpected`,
  ];
  for (const url of badUrls) expect(() => factory.createSocket(url)).toThrow("not allowed");
  expect(upgrades).not.toHaveBeenCalled();
  const socket = factory.createSocket(FORTNITE_SOCKET_URL) as unknown as EventEmitter;
  expect(upgrades).toHaveBeenCalledExactlyOnceWith(FORTNITE_SOCKET_URL, {
    origin: "https://x2nfeda4neuzvsp2zdqfln9nwxc7tp.ext-twitch.tv",
    handshakeTimeout: 10_000,
    closeTimeout: 2_000,
  });
  const closed = vi.fn();
  socket.once("close", closed);
  await factory.close();
  expect(closed).toHaveBeenCalledOnce();
  expect(() => factory.createSocket(FORTNITE_SOCKET_URL)).toThrow("not allowed");
});

it("cancels a Fortnite upgrade on loop shutdown and waits for the socket before disposal", async () => {
  socketState.defer = true;
  const settings = structuredClone(DEFAULT_CLI_SETTINGS);
  settings.platform.kick.enabled = false;
  settings.twitchExtensions.fortnite.enabled = true;
  const transport = idleTransport();
  transport.adapters.twitch.supportsTabless = true;
  const provider = twitchExtensionProvider("fortnite")!;
  const installation = {
    extension: { id: provider.extensionId, version: "1.1.2" },
    activationConfig: { state: "ACTIVE" },
  };
  const token = {
    jwt: `test.${Buffer.from(
      JSON.stringify({
        channel_id: "123",
        exp: Math.floor(Date.now() / 1000) + 3600,
        role: "viewer",
        opaque_user_id: "Utest",
        user_id: "456",
      }),
    ).toString("base64url")}.test`,
  };
  const access = {
    source: {
      now: Date.now,
      hasSession: async () => true,
      query: async (query: string) => {
        if (query.includes("ExtensionDirectory"))
          return {
            data: {
              game: {
                streams: {
                  edges: [
                    {
                      node: {
                        id: "42",
                        broadcaster: { id: "123", login: "streamer" },
                      },
                    },
                  ],
                },
              },
            },
          };
        if (query.includes("ExtensionInstallations"))
          return {
            data: {
              users: [
                {
                  id: "123",
                  login: "streamer",
                  channel: {
                    selfInstalledExtensions: [{ installation }],
                  },
                },
              ],
            },
          };
        return {
          data: { user: { channel: { selfInstalledExtensions: [{ installation, token }] } } },
        };
      },
    },
    viewerLogin: async () => "viewer",
  };
  transport.twitchExtensionAccess = () => access;
  const stop = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-fortnite-shutdown-"));
  const done = runLoop({
    statePath: join(dir, "state.json"),
    settings,
    transport,
    stopSignal: stop.signal,
    stateStore: memoryStateStore(),
    logger: createLogger("error"),
  });
  try {
    await vi.waitFor(() => expect(upgrades).toHaveBeenCalledTimes(1));
    stop.abort();
    await vi.waitFor(() => expect(socketState.close).toHaveBeenCalledOnce());
    expect(transport.dispose).not.toHaveBeenCalled();
    socketState.finish?.();
    await done;
    expect(transport.dispose).toHaveBeenCalledOnce();
  } finally {
    stop.abort();
    socketState.defer = false;
    socketState.finish?.();
    await done;
    await rm(dir, { recursive: true, force: true });
  }
});
