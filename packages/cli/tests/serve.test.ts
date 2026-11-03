import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { CoreRuntimeMessage, RuntimeMessage } from "@lurkloot/shared/messages";
import type { EngineSettings } from "@lurkloot/shared/models";
import {
  type ControlPlane,
  type ControlPlaneMessage,
  isLoopbackHost,
  resolveServeBinding,
  SERVE_TOKEN_ENV,
  ServeConfigError,
  startControlPlane,
  SUPPORTED_MESSAGE_TYPES,
} from "../src/runtime/controlPlane";
import { serveLoop, startControllerControlPlane } from "../src/runtime/serve";
import { describeCredentialHealth } from "../src/authStore";
import { createLogger } from "../src/logger";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { CLI_VERSION } from "../src/version";
import { idleTransport, memoryStateStore } from "./helpers/fakeFarming";

const TOKEN = "serve-token-sentinel-0123456789";
const TWITCH_SECRET = "twitch-secret-sentinel-abcdef";
const ACCOUNT_SECRET = "account-id-sentinel-987";
// Silent: one test fails the controller on purpose.
const quiet = { ...createLogger("error"), log: () => {}, error: () => {} };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

// node:http rather than fetch, so tests control Host and Origin exactly.
function send(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/v1/health",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          bodies.push(text);
          resolveReply({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", rejectReply);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function postMessage(port: number, message: unknown, headers: Record<string, string> = {}) {
  return send(port, {
    method: "POST",
    path: "/v1/session/messages",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
}

function errorCode(reply: Reply): string | undefined {
  return (reply.json as { error?: { code?: string } } | undefined)?.error?.code;
}

function snapshot() {
  const state = structuredClone(DEFAULT_STATE);
  state.authHealth.twitch = {
    status: "healthy",
    checkedAt: "2026-11-03T00:00:00.000Z",
    accountId: ACCOUNT_SECRET,
    message: { key: "authHealthy" },
  };
  return { settings: toEngineSettings(DEFAULT_CLI_SETTINGS) as EngineSettings, state };
}

// Every response body any test received, checked for planted secrets at the end.
const bodies: string[] = [];
const planes: ControlPlane[] = [];
let tempDir: string | undefined;

afterEach(async () => {
  await Promise.all(planes.splice(0).map((plane) => plane.close()));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function start(options: { token?: string; host?: string; settingsWritable?: boolean } = {}) {
  const handleMessage = vi.fn(async (message: ControlPlaneMessage) =>
    message.type === "getSnapshot" ? snapshot() : undefined,
  );
  const plane = await startControllerControlPlane(
    { handleMessage: handleMessage as never },
    {
      binding: {
        host: options.host ?? "127.0.0.1",
        port: 0,
        ...(options.token ? { token: options.token } : {}),
      },
      logger: quiet,
      settingsWritable: options.settingsWritable ?? false,
      describeCredentials: () =>
        describeCredentialHealth("/nonexistent-lurkloot-auth", {
          SA_TWITCH_AUTH_TOKEN: TWITCH_SECRET,
        }),
    },
  );
  planes.push(plane as ControlPlane);
  return { port: (plane as ControlPlane).port, handleMessage };
}

describe("serve binding", () => {
  it("binds loopback by default with no token", () => {
    expect(resolveServeBinding({ env: {} })).toEqual({ host: "127.0.0.1", port: 8420 });
  });

  it.each(["0.0.0.0", "::", "192.168.1.10", "example.com"])(
    "refuses to bind %s without a token",
    (host) => {
      expect(() => resolveServeBinding({ host, env: {} })).toThrow(ServeConfigError);
      expect(() => resolveServeBinding({ host, env: { [SERVE_TOKEN_ENV]: "   " } })).toThrow(
        /without an access token/,
      );
    },
  );

  it("binds a non-loopback host once a token is configured", () => {
    expect(
      resolveServeBinding({ host: "0.0.0.0", port: 9000, env: { [SERVE_TOKEN_ENV]: TOKEN } }),
    ).toEqual({ host: "0.0.0.0", port: 9000, token: TOKEN });
  });

  it("refuses a short token and an invalid port", () => {
    expect(() => resolveServeBinding({ env: { [SERVE_TOKEN_ENV]: "short" } })).toThrow(
      /at least 16/,
    );
    expect(() => resolveServeBinding({ port: 70000, env: {} })).toThrow(/--port/);
  });

  it("recognises loopback names only", () => {
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "::", "10.0.0.1", "localhost.evil.com", "127.0.0.1.nip.io", ""])
      expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("control plane message allow-list", () => {
  it("lists only core messages the CLI host supports", () => {
    expect([...SUPPORTED_MESSAGE_TYPES].sort()).toEqual(
      [
        "claimReward",
        "dismissCriticalFailure",
        "getSnapshot",
        "saveSettings",
        "searchCategories",
        "selectRewardLane",
        "setAutomation",
        "setPlatformEnabled",
        "tickNow",
        "updateIdleWatchlist",
      ].sort(),
    );
  });

  const accepted: CoreRuntimeMessage[] = [
    { type: "getSnapshot" },
    { type: "tickNow" },
    { type: "setPlatformEnabled", platform: "twitch", enabled: false },
    { type: "setAutomation", platform: "kick", enabled: true },
    { type: "saveSettings", settingsPatch: { autoClaim: false } },
    { type: "updateIdleWatchlist", platform: "kick", channel: "someone", action: "add" },
    { type: "claimReward", platform: "twitch", campaignId: "c", rewardId: "r" },
    { type: "selectRewardLane", platform: "twitch", campaignId: "c", track: "t", lane: "l" },
    { type: "searchCategories", platform: "twitch", query: "valorant" },
    { type: "dismissCriticalFailure", platform: "kick" },
  ];

  it.each(accepted)("forwards $type to the controller", async (message) => {
    const { port, handleMessage } = await start({ settingsWritable: true });
    const reply = await postMessage(port, message);
    expect(reply.status).toBe(200);
    expect(handleMessage).toHaveBeenCalledWith(message);
    expect(reply.json).toEqual({
      result: message.type === "getSnapshot" ? expect.any(Object) : null,
    });
  });

  it.each(["saveSettings", "updateIdleWatchlist", "setPlatformEnabled", "setAutomation"] as const)(
    "refuses %s while settings are read-only",
    async (type) => {
      const { port, handleMessage } = await start();
      const message = accepted.find((candidate) => candidate.type === type);
      const reply = await postMessage(port, message);
      expect(reply.status).toBe(409);
      expect(errorCode(reply)).toBe("settings_read_only");
      expect(handleMessage).not.toHaveBeenCalled();
    },
  );

  const refused: RuntimeMessage[] = [
    { type: "getTabId" },
    { type: "exportCliCredentials" },
    { type: "getPlaybackControl", platform: "twitch" },
    {
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {} as never,
    },
    { type: "resumeAfterManualClose", platform: "twitch" },
    { type: "resetExtension" },
    { type: "clearActivity" },
    { type: "setTwitchExtensionEnabled", provider: "fortnite", enabled: true },
  ];

  it.each(refused)("refuses $type with a typed 422", async (message) => {
    const { port, handleMessage } = await start();
    const reply = await postMessage(port, message);
    expect(reply.status).toBe(422);
    expect(errorCode(reply)).toBe("unsupported_message");
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("refuses unknown and prototype-named types", async () => {
    const { port, handleMessage } = await start();
    for (const type of ["somethingNew", "__proto__", "constructor", "toString"]) {
      const reply = await postMessage(port, { type });
      expect(reply.status).toBe(422);
      expect(errorCode(reply)).toBe("unsupported_message");
    }
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("refuses malformed bodies before the controller", async () => {
    const { port, handleMessage } = await start();
    const cases: Array<[string, number, string]> = [
      ["{not json", 400, "invalid_json"],
      ["[]", 400, "invalid_message"],
      ['{"kind":"getSnapshot"}', 400, "invalid_message"],
      ['{"type":"tickNow","x":1', 400, "invalid_json"],
      ['{"type":"setPlatformEnabled","platform":"youtube","enabled":true}', 400, "invalid_message"],
      ['{"type":"claimReward","campaignId":"c","rewardId":"r"}', 400, "invalid_message"],
    ];
    for (const [body, status, code] of cases) {
      const reply = await send(port, {
        method: "POST",
        path: "/v1/session/messages",
        headers: { "content-type": "application/json" },
        body,
      });
      expect([reply.status, errorCode(reply)]).toEqual([status, code]);
    }
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("requires a JSON content type, so a cross-site simple POST never runs", async () => {
    const { port, handleMessage } = await start();
    const reply = await send(port, {
      method: "POST",
      path: "/v1/session/messages",
      headers: { "content-type": "text/plain" },
      body: '{"type":"tickNow"}',
    });
    expect(reply.status).toBe(415);
    expect(errorCode(reply)).toBe("unsupported_media_type");
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("limits the request body size", async () => {
    const { port, handleMessage } = await start();
    const reply = await postMessage(port, {
      type: "saveSettings",
      settingsPatch: { padding: "x".repeat(70 * 1024) },
    });
    expect(reply.status).toBe(413);
    expect(errorCode(reply)).toBe("payload_too_large");
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("answers a controller failure with a generic 500", async () => {
    const { port, handleMessage } = await start();
    handleMessage.mockRejectedValueOnce(new Error(`boom ${TWITCH_SECRET}`));
    const reply = await postMessage(port, { type: "tickNow" });
    expect(reply.status).toBe(500);
    expect(reply.json).toEqual({
      error: { code: "internal_error", message: "The request failed" },
    });
  });

  it("routes only known endpoints and methods", async () => {
    const { port } = await start();
    expect((await send(port, { path: "/v1/nope" })).status).toBe(404);
    const wrongMethod = await send(port, { path: "/v1/session/messages" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("POST");
    expect((await send(port, { method: "POST", path: "/v1/health" })).status).toBe(405);
  });
});

describe("control plane access", () => {
  it("rejects a foreign Host header on a loopback bind (DNS rebinding)", async () => {
    const { port } = await start();
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1.nip.io"]) {
      const reply = await send(port, { headers: { host } });
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("forbidden_host");
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"])
      expect((await send(port, { headers: { host } })).status).toBe(200);
  });

  it("rejects a cross-origin Origin and accepts a same-origin one", async () => {
    const { port, handleMessage } = await start();
    const foreign = await postMessage(
      port,
      { type: "tickNow" },
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);
    expect(errorCode(foreign)).toBe("forbidden_origin");
    const opaque = await postMessage(port, { type: "tickNow" }, { origin: "null" });
    expect(opaque.status).toBe(403);
    expect(handleMessage).not.toHaveBeenCalled();
    const same = await postMessage(
      port,
      { type: "tickNow" },
      { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` },
    );
    expect(same.status).toBe(200);
  });

  it("requires the bearer token on every endpoint once one is configured", async () => {
    const { port, handleMessage } = await start({ token: TOKEN });
    for (const path of ["/v1/health", "/v1/session"]) {
      const missing = await send(port, { path });
      expect(missing.status).toBe(401);
      expect(errorCode(missing)).toBe("unauthorized");
      expect(missing.headers["www-authenticate"]).toBe("Bearer");
      for (const authorization of [
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`,
        `Basic ${TOKEN}`,
        TOKEN,
        "Bearer",
      ]) {
        expect((await send(port, { path, headers: { authorization } })).status).toBe(401);
      }
      expect(
        (await send(port, { path, headers: { authorization: `Bearer ${TOKEN}` } })).status,
      ).toBe(200);
    }
    expect((await postMessage(port, { type: "tickNow" })).status).toBe(401);
    expect(handleMessage).not.toHaveBeenCalledWith({ type: "tickNow" });
    const authorized = await postMessage(
      port,
      { type: "tickNow" },
      { authorization: `bearer ${TOKEN}` },
    );
    expect(authorized.status).toBe(200);
  });

  it("refuses connections once closed", async () => {
    const handleMessage = vi.fn();
    const plane = await startControlPlane({
      host: "127.0.0.1",
      port: 0,
      logger: quiet,
      handleMessage,
      describeSession: async () => {
        throw new Error("unused");
      },
    });
    await plane.close();
    await expect(send(plane.port)).rejects.toThrow();
  });
});

describe("session view", () => {
  it("reports version, platforms and masked auth health", async () => {
    const { port } = await start();
    const reply = await send(port, { path: "/v1/session" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      id: "default",
      version: CLI_VERSION,
      platforms: {
        twitch: {
          enabled: true,
          auth: {
            status: "healthy",
            checkedAt: "2026-11-03T00:00:00.000Z",
            credential: { present: true, source: "environment", status: "checking" },
          },
        },
        kick: {
          enabled: true,
          auth: {
            status: "checking",
            credential: { present: false, source: "none", status: "missing_credentials" },
          },
        },
      },
    });
    // The session view picks safe fields only, never the account id.
    expect(reply.text).not.toContain(ACCOUNT_SECRET);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("serveLoop", () => {
  it("farms with the shared loop and answers the API until SIGTERM", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "serve-test-"));
    const transport = idleTransport();
    let port = 0;
    const running = serveLoop({
      binding: { host: "127.0.0.1", port: 0 },
      settings: DEFAULT_CLI_SETTINGS,
      statePath: join(tempDir, "state.json"),
      stateStore: memoryStateStore(),
      transport,
      logger: quiet,
      checkCredentialAvailability: async () => ({ status: "available" }),
      describeCredentials: () =>
        describeCredentialHealth(tempDir!, { SA_TWITCH_AUTH_TOKEN: TWITCH_SECRET }),
      onListening: (address) => {
        port = address.port;
      },
    });
    try {
      await vi.waitFor(() => expect(port).not.toBe(0));
      const session = await send(port, { path: "/v1/session" });
      expect(session.status).toBe(200);
      expect((session.json as { version: string }).version).toBe(CLI_VERSION);
      const snap = await postMessage(port, { type: "getSnapshot" });
      expect(snap.status).toBe(200);
      expect((snap.json as { result: { state: unknown } }).result.state).toBeDefined();
      await vi.waitFor(async () => {
        const reply = await send(port, { path: "/v1/session" });
        const auth = (reply.json as { platforms: { twitch: { auth: { status: string } } } })
          .platforms.twitch.auth;
        expect(auth.status).toBe("healthy");
      });
    } finally {
      process.emit("SIGTERM");
      await running;
    }
    // The server closed before the transport went.
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    await expect(send(port)).rejects.toThrow();
  });

  it("reads and writes settings through an injected settings store", async () => {
    let stored = toEngineSettings(DEFAULT_CLI_SETTINGS);
    const save = vi.fn(async (next: EngineSettings) => {
      stored = next;
    });
    let port = 0;
    const running = serveLoop({
      binding: { host: "127.0.0.1", port: 0 },
      settings: DEFAULT_CLI_SETTINGS,
      statePath: "/nonexistent-lurkloot-state.json",
      stateStore: memoryStateStore(),
      settingsStore: {
        load: async () => stored,
        save,
        applyPatch: (current, patch) => ({ ...current, ...patch }) as EngineSettings,
      },
      transport: idleTransport(),
      logger: quiet,
      describeCredentials: () => describeCredentialHealth("/nonexistent-lurkloot-auth", {}),
      onListening: (address) => {
        port = address.port;
      },
    });
    try {
      await vi.waitFor(() => expect(port).not.toBe(0));
      const reply = await postMessage(port, {
        type: "saveSettings",
        settingsPatch: { autoClaim: false },
      });
      expect(reply.status).toBe(200);
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ autoClaim: false }));
      expect(
        (reply.json as { result: { settings: EngineSettings } }).result.settings.autoClaim,
      ).toBe(false);
    } finally {
      process.emit("SIGTERM");
      await running;
    }
  });

  it("stops the loop and rejects when the port is taken", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
    const taken = (blocker.address() as { port: number }).port;
    const transport = idleTransport();
    try {
      await expect(
        serveLoop({
          binding: { host: "127.0.0.1", port: taken },
          settings: DEFAULT_CLI_SETTINGS,
          statePath: "/nonexistent-lurkloot-state.json",
          stateStore: memoryStateStore(),
          transport,
          logger: quiet,
          describeCredentials: () => describeCredentialHealth("/nonexistent-lurkloot-auth", {}),
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(transport.dispose).toHaveBeenCalledTimes(1);
      expect(process.listeners("SIGTERM")).toHaveLength(0);
    } finally {
      await new Promise((resolveClose) => blocker.close(resolveClose));
    }
  });
});

describe("response bodies", () => {
  // Runs last in this file: every body any test above received.
  it("never carry a token, credential or account id", () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(TWITCH_SECRET);
      expect(body).not.toMatch(/authToken|sessionToken|cookie|kasada/i);
    }
  });
});
