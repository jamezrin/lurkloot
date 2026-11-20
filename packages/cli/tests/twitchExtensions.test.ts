import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, SchedulerState } from "@lurkloot/shared/models";
import { createLogger } from "../src/logger";
import { runLoop, type FarmingController } from "../src/runtime/run";
import { createCliTwitchExtensionLane } from "../src/runtime/twitchExtensions";
import { createTwitchExtensionMemory } from "../src/runtime/twitchExtensionMemory";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { createHttpTransport } from "../src/transport/http";
import {
  TWITCH_ANDROID_CLIENT_ID,
  TWITCH_SMARTBOX_CLIENT_ID,
  TWITCH_WEB_CLIENT_ID,
} from "../src/twitch";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";

const login = "sample_viewer";
const channelId = "123";
const streamer = "sample_stream";
const credentials = "test-oauth-value";
const nopixel = twitchExtensionProvider("nopixel")!;
const installation = {
  extension: { id: nopixel.extensionId, version: "1.1.4" },
  activationConfig: { state: "ACTIVE" },
};
function directory() {
  return {
    data: {
      game: {
        streams: {
          edges: [
            {
              node: {
                id: "42",
                broadcaster: { id: channelId, login: streamer },
              },
            },
          ],
        },
      },
    },
  };
}
function installations() {
  return {
    data: {
      users: [
        {
          id: channelId,
          login: streamer,
          channel: {
            selfInstalledExtensions: [{ installation }],
          },
        },
      ],
    },
  };
}
function viewerSession() {
  const payload = Buffer.from(
    JSON.stringify({
      opaque_user_id: "Utest",
      user_id: "456",
      role: "viewer",
      channel_id: channelId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  return {
    data: {
      user: {
        channel: {
          selfInstalledExtensions: [{ installation, token: { jwt: `test.${payload}.test` } }],
        },
      },
    },
  };
}
function authTransport(clientId: string) {
  return createHttpTransport(
    { twitch: { clientId, authToken: credentials } },
    {
      twitch: true,
      kick: false,
    },
  );
}
function farmingSettings() {
  const settings = structuredClone(DEFAULT_CLI_SETTINGS);
  settings.platform.kick.enabled = false;
  settings.twitchExtensions.nopixel = { enabled: true, autoOpenPacks: true };
  return settings;
}
function healthyState(): SchedulerState {
  const state = structuredClone(DEFAULT_STATE);
  state.authHealth.twitch = { status: "healthy", checkedAt: new Date().toISOString() };
  return state;
}

let statePath: string;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-extension-lane-"));
  statePath = join(dir, "state.json");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

it("farms a NoPixel lane with chat, publishes a pack, snapshots completion and restores it on restart", async () => {
  let opened = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === "https://gql.twitch.tv/gql") {
      const headers = new Headers(init.headers);
      expect(headers.get("Client-ID")).toBe(TWITCH_WEB_CLIENT_ID);
      expect(headers.get("Authorization")).toBe(`OAuth ${credentials}`);
      switch (JSON.parse(String(init.body)).operationName) {
        case "CurrentUserLogin":
          return Response.json({ data: { currentUser: { login } } });
        case "ExtensionDirectory":
          return Response.json(directory());
        case "ExtensionInstallations":
          return Response.json(installations());
        case "CoordinatorExtensionsForChannel":
          return Response.json(viewerSession());
      }
    }
    const target = new URL(url);
    expect(target.origin).toBe("https://nopixel.streamingtoolsmith.com");
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Bearer test\./);
    if (target.pathname === "/channel/setup")
      return Response.json({
        is_channel_eligible_for_pack_giveaways: false,
        is_channel_eligible_for_watchtime_tracking: true,
        is_channel_connected_for_watchtime_tracking: true,
      });
    if (target.pathname.endsWith("/progress"))
      return Response.json({ watch_time_earned: 60, watch_time_required: 60 });
    if (target.pathname === "/cards/packs")
      return Response.json(opened ? [] : [{ id: "pack-123" }]);
    if (target.pathname.endsWith("/open")) {
      opened = true;
      return Response.json([{ card_id: "card-1", edition: "gold" }]);
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  const transport = {
    ...idleTransport(),
    twitchExtensionAccess: authTransport(TWITCH_WEB_CLIENT_ID).twitchExtensionAccess,
  };
  let channelUrl: string | undefined;
  transport.adapters.twitch.supportsTabless = true;
  transport.adapters.twitch.createTablessWatcher = () => ({
    platform: "twitch",
    get channelUrl() {
      return channelUrl;
    },
    start: async (channel) => {
      channelUrl = channel.url;
    },
    tick: async () => ({ ok: true, live: true }),
    stop: async () => {
      channelUrl = undefined;
    },
    drainEvents: () => [],
  });
  const follow = vi.fn(async () => {});
  const stopChat = vi.fn(async () => {});
  transport.adapters.twitch.createChatPresenceClient = () => ({
    follow,
    stop: stopChat,
    status: () => ({ state: "left" }),
    drainEvents: () => [],
  });
  const settings = farmingSettings();
  const logger = createLogger("error");
  const log = vi.spyOn(logger, "log");
  const stop = new AbortController();
  let controller: FarmingController | undefined;
  const done = runLoop({
    statePath,
    settings,
    transport,
    logger,
    stopSignal: stop.signal,
    stateStore: memoryStateStore(),
    startHost: async (running) => {
      controller = running;
      return { close: async () => {} };
    },
  });
  try {
    await vi.waitFor(async () => {
      const snapshot = (await controller?.handleMessage({ type: "getSnapshot" })) as
        | RuntimeSnapshot<EngineSettings>
        | undefined;
      expect(snapshot?.state.sessions.twitch.supplementalWatch?.id).toBe("nopixel");
      expect(snapshot?.state.twitchExtensions?.nopixel?.status).toBe("complete");
      expect(JSON.stringify(snapshot)).not.toContain(credentials);
      expect(JSON.stringify(snapshot)).not.toContain("test.");
    });
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ username: streamer }));
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("nopixel pack"), "twitch");
  } finally {
    stop.abort();
    await done;
  }
  expect(transport.dispose).toHaveBeenCalledOnce();
  expect(stopChat).toHaveBeenCalled();
  const memory = await createTwitchExtensionMemory(statePath).load();
  expect(memory).toMatchObject({
    owner: login,
    knownComplete: { nopixel: expect.any(Number) },
    completedUntil: { nopixel: expect.any(Number) },
  });
  const requestCount = fetch.mock.calls.length;
  const restarted = createCliTwitchExtensionLane({
    transport,
    statePath,
    loadSettings: async () => toEngineSettings(settings),
    loadState: async () => healthyState(),
    savePatch: async () => {},
    requestTick: vi.fn(),
    publish: vi.fn(),
    onSessionReady: vi.fn(),
  });
  try {
    expect(
      await restarted.select(healthyState(), toEngineSettings(settings), undefined, "nopixel"),
    ).toBeUndefined();
    const operations = fetch.mock.calls
      .slice(requestCount)
      .map(([, init]) => JSON.parse(String(init.body)).operationName);
    expect(operations).toEqual(["CurrentUserLogin"]);
  } finally {
    await restarted.close();
  }
});

describe("non-web session refusal", () => {
  it.each([
    { clientId: TWITCH_ANDROID_CLIENT_ID, operation: "ExtensionInstallations" },
    { clientId: TWITCH_SMARTBOX_CLIENT_ID, operation: "CoordinatorExtensionsForChannel" },
  ])(
    "parks $clientId after $operation is refused and resumes for new credentials",
    async ({ clientId, operation }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      let refused = true;
      const request = vi.fn(async (url: string, init: RequestInit) => {
        if (url !== "https://gql.twitch.tv/gql") throw new Error("Unexpected provider request.");
        const headers = new Headers(init.headers);
        expect(headers.get("Client-ID")).toBe(refused ? clientId : TWITCH_WEB_CLIENT_ID);
        expect(headers.get("Authorization")).toBe(`OAuth ${credentials}`);
        const name = JSON.parse(String(init.body)).operationName;
        if (name === operation && refused)
          return Response.json({ errors: [{ message: "Access denied: private credential" }] });
        if (name === "CurrentUserLogin") return Response.json({ data: { currentUser: { login } } });
        if (name === "ExtensionDirectory") return Response.json(directory());
        return Response.json(installations());
      });
      vi.stubGlobal("fetch", request);
      const settings = toEngineSettings(farmingSettings());
      const state = healthyState();
      const publish = vi.fn();
      const transport = {
        ...idleTransport(),
        twitchExtensionAccess: authTransport(clientId).twitchExtensionAccess,
      };
      const lane = createCliTwitchExtensionLane({
        transport,
        statePath,
        loadSettings: async () => settings,
        loadState: async () => state,
        publish,
        requestTick: vi.fn(),
        savePatch: async () => {},
        onSessionReady: vi.fn(),
      });
      const select = () => lane.select(state, settings, undefined, "nopixel");
      try {
        const selected = await select();
        if (operation === "CoordinatorExtensionsForChannel") {
          expect(selected?.channel.username).toBe(streamer);
          state.sessions.twitch = {
            ...state.sessions.twitch,
            status: "watching",
            channel: selected?.channel,
          };
          lane.onCommit({
            kind: "state",
            previous: healthyState(),
            state,
            platforms: ["twitch"],
            committedAt: Date.now(),
          });
          await vi.waitFor(() =>
            expect(lane.snapshot().nopixel?.reasonCode).toBe("compatibility-error"),
          );
        } else {
          expect(selected).toBeUndefined();
        }
        expect(lane.snapshot().nopixel).toMatchObject({
          status: "idle",
          reasonCode: "compatibility-error",
        });
        const requests = request.mock.calls.length;
        const before = Date.now();
        for (let minute = 1; minute <= 180; minute += 1) {
          vi.setSystemTime(before + minute * 60_000);
          expect(await select()).toBeUndefined();
          lane.onCommit({
            kind: "state",
            previous: state,
            state,
            platforms: ["twitch"],
            committedAt: Date.now(),
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(request).toHaveBeenCalledTimes(requests);
        const warnings = publish.mock.calls
          .flat()
          .flat()
          .filter((event) => event.level === "warn");
        expect(warnings).toEqual([
          expect.objectContaining({
            message: expect.stringContaining(
              "Twitch refused the nopixel Extension query for this sign-in",
            ),
          }),
        ]);
        expect(JSON.stringify(warnings)).not.toContain("private credential");
        expect(state.authHealth.twitch.status).toBe("healthy");

        refused = false;
        transport.twitchExtensionAccess = authTransport(TWITCH_WEB_CLIENT_ID).twitchExtensionAccess;
        expect((await select())?.channel.username).toBe(streamer);
      } finally {
        await lane.close();
      }
    },
  );
});

it("keeps restart memory bounded, expiring and credential-free", async () => {
  const now = Date.now();
  const memory = createTwitchExtensionMemory(statePath, () => now);
  const deadlines = Object.fromEntries(
    Array.from({ length: 100 }, (_, id) => [`nopixel:channel_${id}`, now + 10_000]),
  );
  await memory.save({
    version: 1,
    owner: login,
    unavailableUntil: deadlines,
    knownComplete: { nopixel: now + 30_000 },
    completedUntil: { fortnite: now - 1 },
    identityRequiredUntil: {},
    ...{ token: "do-not-write" },
  });
  const path = join(dir, "twitch-extension-lane.json");
  expect(await readFile(path, "utf8")).not.toContain("do-not-write");
  const restarted = createTwitchExtensionMemory(statePath, () => now + 1);
  const loaded = (await restarted.load()) as { unavailableUntil: object; completedUntil: object };
  expect(Object.keys(loaded.unavailableUntil)).toHaveLength(64);
  expect(loaded.completedUntil).toEqual({});
  await writeFile(path, " ".repeat(8193));
  expect(await restarted.load()).toBeUndefined();
});

it("keeps a custom state file separate from its lane memory", async () => {
  const customPath = join(dir, "twitch-extension-lane.json");
  await writeFile(customPath, "scheduler state");
  const now = Date.now();
  await createTwitchExtensionMemory(customPath).save({
    version: 1,
    owner: login,
    knownComplete: { nopixel: now + 60_000 },
    completedUntil: {},
    unavailableUntil: {},
    identityRequiredUntil: {},
  });
  expect(await readFile(customPath, "utf8")).toBe("scheduler state");
  expect(await createTwitchExtensionMemory(customPath).load()).toMatchObject({ owner: login });
  expect(await createTwitchExtensionMemory(statePath).load()).toBeUndefined();
});
