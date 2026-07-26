import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapterConstruction = vi.hoisted(() => ({
  failKick: false,
}));

vi.mock("@lurkloot/core/kick", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lurkloot/core/kick")>();
  const KickAdapter = new Proxy(actual.KickAdapter, {
    construct(target, args) {
      if (adapterConstruction.failKick) throw new Error("Kick adapter construction failed");
      return Reflect.construct(target, args, target);
    },
  });
  return { ...actual, KickAdapter };
});

vi.mock("@lurkloot/core/twitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lurkloot/core/twitch")>();
  const TwitchAdapter = new Proxy(actual.TwitchAdapter, {
    construct(target, args) {
      const adapter = Reflect.construct(target, args, target) as InstanceType<typeof actual.TwitchAdapter>;
      adapter.checkAuthHealth = async () => ({
        status: "healthy",
        checkedAt: "2026-07-26T12:00:00.000Z",
        message: { key: "authHealthy" },
      });
      return adapter;
    },
  });
  return { ...actual, TwitchAdapter };
});

import type { SchedulerState } from "@lurkloot/shared/models";
import { createHttpTransport } from "../src/transport/http";
import { createImpersonateTransport } from "../src/transport/impersonate";
import type { TransportHandle } from "../src/transport";
import type { CycleTLSClient } from "../src/transport/cycle";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";
import { runLoop } from "../src/runtime/run";
import type { Logger } from "../src/logger";

const logger: Logger = {
  level: "error",
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCycleClient(): CycleTLSClient {
  const client = async () => ({ status: 200, data: {} });
  return Object.assign(client, {
    exit: async () => undefined,
    ws: async () => ({
      send() {},
      close() {},
      onMessage() {},
      onClose() {},
      onError() {},
    }),
  }) as unknown as CycleTLSClient;
}

const transports: Array<[string, () => Promise<TransportHandle>]> = [
  [
    "http",
    async () => createHttpTransport({}, { twitch: true, kick: false }),
  ],
  [
    "impersonate",
    async () => createImpersonateTransport(
      {},
      { twitch: true, kick: false },
      { initClient: async () => fakeCycleClient() },
    ),
  ],
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-bootstrap-"));
  adapterConstruction.failKick = true;
});

afterEach(async () => {
  adapterConstruction.failKick = false;
  await rm(dir, { recursive: true, force: true });
});

describe.each(transports)("%s transport bootstrap", (_name, createTransport) => {
  it("starts and persists Twitch auth health when disabled Kick cannot construct", async () => {
    const statePath = join(dir, "state.json");
    const transport = await createTransport();

    expect(transport.adapters.twitch.platform).toBe("twitch");
    await runLoop({
      settings: {
        ...DEFAULT_CLI_SETTINGS,
        platform: {
          ...DEFAULT_CLI_SETTINGS.platform,
          twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: false },
        },
      },
      statePath,
      transport,
      logger,
      once: true,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });

    const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
    expect(state.authHealth.twitch).toMatchObject({
      status: "healthy",
      checkedAt: "2026-07-26T12:00:00.000Z",
    });
  });
});
