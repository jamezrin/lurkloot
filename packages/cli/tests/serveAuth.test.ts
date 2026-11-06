import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import { loadCredentials, saveCredentials, describeCredentialHealth } from "../src/authStore";
import type { Sleep } from "../src/auth/deviceLogin";
import { startKickDeviceLogin, type TvLinkAuthenticator } from "../src/auth/kickDeviceFlow";
import type { ControlPlaneMessage } from "../src/runtime/controlPlane";
import { startControllerControlPlane } from "../src/runtime/serve";
import type { Logger } from "../src/logger";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { TWITCH_ANDROID_CLIENT_ID } from "../src/twitch";

// Sentinels: none may appear in a response or log line, except where the
// caller must see it (the Kick link goes to the caller, never the log).
const TWITCH_TOKEN = "twitchtokensentinel0123456789";
const PASTED_ADDRESS = `https://www.twitch.tv/#access_token=${TWITCH_TOKEN}&scope=&token_type=bearer`;
const DEVICE_TOKEN = "devicetokensentinel9876543210";
const DEVICE_CODE = "devicecodesentinel-abc";
const KICK_TOKEN = "kick-session-sentinel-xyz";
const KICK_UUID = "KICK-UUID-SENTINEL";
const KICK_CODE = "424242";

let dir: string;
const lines: string[] = [];
const bodies: string[] = [];
const hosts: Array<{ close(): Promise<void> }> = [];

const logger: Logger = {
  level: "debug",
  log: (_level, message) => lines.push(message),
  debug: (message) => lines.push(message),
  info: (message) => lines.push(message),
  warn: (message) => lines.push(message),
  error: (message) => lines.push(message),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-serve-auth-"));
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: unknown;
}

function send(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers: {
          ...(body !== undefined || method === "POST"
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          bodies.push(text);
          resolveReply({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    req.on("error", rejectReply);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function errorCode(reply: Reply): string | undefined {
  return (reply.json as { error?: { code?: string } } | undefined)?.error?.code;
}

// A sleep the test releases by hand; it rejects when its signal aborts.
function manualSleep() {
  const waiting: Array<() => void> = [];
  const sleep: Sleep = (_ms, signal) =>
    new Promise((resolveSleep, rejectSleep) => {
      if (signal?.aborted) {
        rejectSleep(signal.reason);
        return;
      }
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolveSleep();
      };
      const onAbort = () => {
        waiting.splice(waiting.indexOf(wake), 1);
        rejectSleep(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(wake);
    });
  return {
    sleep,
    get waiting() {
      return waiting.length;
    },
    release() {
      for (const wake of waiting.splice(0)) wake();
    },
  };
}

// Twitch's id.twitch.tv endpoints, mocked: validate answers for the pasted
// token, device hands out DEVICE_CODE, and token answers from a queue.
function twitchFetch(options: {
  validate?: { status: number; body: Record<string, unknown> } | "network";
  tokenAnswers?: Array<Record<string, unknown>>;
}) {
  const tokenAnswers = [...(options.tokenAnswers ?? [])];
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/validate")) {
      if (options.validate === "network") throw new TypeError("fetch failed");
      const validate = options.validate ?? {
        status: 200,
        body: { client_id: TWITCH_ANDROID_CLIENT_ID, login: "someone", user_id: "1" },
      };
      return new Response(JSON.stringify(validate.body), { status: validate.status });
    }
    if (url.endsWith("/oauth2/device"))
      return new Response(
        JSON.stringify({
          device_code: DEVICE_CODE,
          user_code: "ABCDEFGH",
          verification_uri: "https://www.twitch.tv/activate",
          interval: 5,
          expires_in: 1800,
        }),
        { status: 200 },
      );
    if (url.endsWith("/oauth2/token"))
      return new Response(
        JSON.stringify(tokenAnswers.shift() ?? { message: "authorization_pending" }),
        { status: 400 },
      );
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function kickClient(answers: Array<{ token?: string } | Error>) {
  const queue = [...answers];
  const authenticate = vi.fn(async () => {
    const next = queue.shift() ?? {};
    if (next instanceof Error) throw next;
    return next;
  });
  const dispose = vi.fn(async () => {});
  // The client (cycletls in production) starts on the first poll.
  const createClient = vi.fn(async () => ({
    authenticate: authenticate as unknown as TvLinkAuthenticator,
    dispose,
  }));
  const start = () =>
    startKickDeviceLogin({
      link: {
        uuid: KICK_UUID,
        code: KICK_CODE,
        verificationUrl: `https://kick.com/tv/login?uuid=${KICK_UUID}&code=${KICK_CODE}`,
      },
      createClient,
    });
  return { authenticate, dispose, createClient, start };
}

async function start(
  options: {
    fetchImpl?: typeof fetch;
    kick?: () => ReturnType<typeof startKickDeviceLogin>;
    sleep?: Sleep;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = options.env ?? {};
  const handleMessage = vi.fn(async (message: ControlPlaneMessage) =>
    message.type === "getSnapshot"
      ? {
          settings: toEngineSettings(DEFAULT_CLI_SETTINGS) as EngineSettings,
          state: structuredClone(DEFAULT_STATE),
        }
      : undefined,
  );
  const host = await startControllerControlPlane(
    { handleMessage: handleMessage as never },
    {
      binding: { host: "127.0.0.1", port: 0 },
      logger,
      describeCredentials: () => describeCredentialHealth(dir, env),
      auth: {
        authDir: dir,
        env,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.kick ? { startDeviceLogin: { kick: options.kick } } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
    },
  );
  hosts.push(host);
  return { port: host.port, handleMessage, host };
}

async function deviceLoginOf(port: number, platform: Platform) {
  const reply = await send(port, "GET", `/v1/session/auth/${platform}/device-login`);
  return (reply.json as { deviceLogin: { status: string } | null }).deviceLogin;
}

async function storedFile(): Promise<string> {
  return readFile(join(dir, "credentials.json"), "utf8").catch(() => "");
}

describe("serve: Twitch browser login", () => {
  it("returns the sign-in link", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", "/v1/session/auth/twitch/browser-login");
    expect(reply.status).toBe(200);
    const body = reply.json as { authorizeUrl: string; redirectUri: string };
    const url = new URL(body.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe(TWITCH_ANDROID_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(body.redirectUri).toBe("https://www.twitch.tv/");
  });

  it("validates and saves the pasted address, replacing the Twitch login whole", async () => {
    saveCredentials(dir, {
      twitch: { authToken: "oldweb", clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko", deviceId: "d" },
      kick: { sessionToken: "keep-kick" },
    });
    const fetchImpl = twitchFetch({});
    const { port, handleMessage } = await start({ fetchImpl });

    const reply = await send(port, "POST", "/v1/session/auth/twitch/browser-login", {
      address: PASTED_ADDRESS,
    });

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      platform: "twitch",
      environmentOverride: false,
      login: "someone",
    });
    expect(loadCredentials(dir, {})).toEqual({
      twitch: { authToken: TWITCH_TOKEN, clientId: TWITCH_ANDROID_CLIENT_ID },
      kick: { sessionToken: "keep-kick" },
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: `OAuth ${TWITCH_TOKEN}` },
    });
    // The auth probe owns auth health; serve only asks for a tick.
    expect(handleMessage).toHaveBeenCalledWith({ type: "tickNow" });
  });

  it("reports an SA_* override that still wins", async () => {
    const { port } = await start({
      fetchImpl: twitchFetch({}),
      env: { SA_TWITCH_AUTH_TOKEN: "envtoken" },
    });
    const reply = await send(port, "POST", "/v1/session/auth/twitch/browser-login", {
      address: PASTED_ADDRESS,
    });
    expect((reply.json as { environmentOverride: boolean }).environmentOverride).toBe(true);
  });

  it.each([
    [
      "an address with no token",
      { address: "https://www.twitch.tv/" },
      {},
      400,
      "invalid_redirect",
    ],
    [
      "a refused sign-in",
      { address: "https://www.twitch.tv/#error=access_denied&error_description=denied" },
      {},
      400,
      "invalid_redirect",
    ],
    ["a body with no address", {}, {}, 400, "invalid_request"],
    [
      "a token Twitch rejects",
      { address: PASTED_ADDRESS },
      { validate: { status: 401, body: { status: 401, message: "invalid access token" } } },
      422,
      "login_rejected",
    ],
    [
      "a token from another client",
      { address: PASTED_ADDRESS },
      { validate: { status: 200, body: { client_id: "other" } } },
      422,
      "login_rejected",
    ],
    [
      "Twitch out of reach",
      { address: PASTED_ADDRESS },
      { validate: "network" as const },
      502,
      "upstream_unavailable",
    ],
  ])("leaves the store unchanged for %s", async (_name, body, fetchOptions, status, code) => {
    saveCredentials(dir, { twitch: { authToken: "keepme", clientId: "c" } });
    const before = await storedFile();
    const { port, handleMessage } = await start({ fetchImpl: twitchFetch(fetchOptions) });
    const reply = await send(port, "POST", "/v1/session/auth/twitch/browser-login", body);
    expect(reply.status).toBe(status);
    expect(errorCode(reply)).toBe(code);
    expect(await storedFile()).toBe(before);
    expect(handleMessage).not.toHaveBeenCalledWith({ type: "tickNow" });
  });

  it("requires a JSON POST and allows only its methods", async () => {
    const { port } = await start({ fetchImpl: twitchFetch({}) });
    const plain = await send(port, "POST", "/v1/session/auth/twitch/browser-login", undefined, {
      "content-type": "text/plain",
    });
    expect(plain.status).toBe(415);
    const wrong = await send(port, "PUT", "/v1/session/auth/twitch/browser-login");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe("GET, POST");
    const foreign = await send(
      port,
      "POST",
      "/v1/session/auth/kick/logout",
      {},
      {
        origin: "https://evil.example",
      },
    );
    expect(foreign.status).toBe(403);
    expect(errorCode(foreign)).toBe("forbidden_origin");
    // Kick has no browser sign-in.
    expect((await send(port, "GET", "/v1/session/auth/kick/browser-login")).status).toBe(404);
  });
});

describe("serve: device logins", () => {
  it("runs the Twitch device login to approval", async () => {
    const sleep = manualSleep();
    const fetchImpl = twitchFetch({
      tokenAnswers: [{ message: "authorization_pending" }, { access_token: DEVICE_TOKEN }],
    });
    const { port, handleMessage } = await start({ fetchImpl, sleep: sleep.sleep });

    const started = await send(port, "POST", "/v1/session/auth/twitch/device-login");
    expect(started.status).toBe(200);
    expect((started.json as { deviceLogin: unknown }).deviceLogin).toMatchObject({
      platform: "twitch",
      status: "pending",
      verificationUrl: "https://www.twitch.tv/activate",
      userCode: "ABCDEFGH",
      expiresAt: expect.any(String),
    });
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));
    sleep.release();
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));
    expect((await deviceLoginOf(port, "twitch"))?.status).toBe("pending");
    sleep.release();
    await vi.waitFor(async () =>
      expect((await deviceLoginOf(port, "twitch"))?.status).toBe("approved"),
    );
    expect(loadCredentials(dir, {}).twitch).toMatchObject({
      authToken: DEVICE_TOKEN,
      clientId: "ue6666qo983tsx6so1t0vnawi233wa",
    });
    expect(handleMessage).toHaveBeenCalledWith({ type: "tickNow" });
  });

  it("runs the Kick TV link to approval and releases its client", async () => {
    const sleep = manualSleep();
    const kick = kickClient([{}, { token: KICK_TOKEN }]);
    const { port } = await start({ kick: kick.start, sleep: sleep.sleep });

    const started = await send(port, "POST", "/v1/session/auth/kick/device-login");
    expect((started.json as { deviceLogin: unknown }).deviceLogin).toMatchObject({
      status: "pending",
      verificationUrl: `https://kick.com/tv/login?uuid=${KICK_UUID}&code=${KICK_CODE}`,
      userCode: KICK_CODE,
    });
    for (let i = 0; i < 2; i += 1) {
      await vi.waitFor(() => expect(sleep.waiting).toBe(1));
      sleep.release();
    }
    await vi.waitFor(async () =>
      expect((await deviceLoginOf(port, "kick"))?.status).toBe("approved"),
    );
    expect(loadCredentials(dir, {}).kick).toEqual({ sessionToken: KICK_TOKEN });
    expect(kick.dispose).toHaveBeenCalledTimes(1);
  });

  it("expires without touching the store", async () => {
    saveCredentials(dir, { kick: { sessionToken: "keep-kick" } });
    const before = await storedFile();
    let clock = Date.parse("2026-11-03T00:00:00.000Z");
    const kick = kickClient([]);
    const { port } = await start({
      kick: kick.start,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await send(port, "POST", "/v1/session/auth/kick/device-login");
    await vi.waitFor(async () =>
      expect(await deviceLoginOf(port, "kick")).toMatchObject({
        status: "expired",
        error: { message: "TV link code expired before approval" },
      }),
    );
    expect(await storedFile()).toBe(before);
    expect(kick.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails on a hard error without touching the store", async () => {
    saveCredentials(dir, { twitch: { authToken: "keepme", clientId: "c" } });
    const before = await storedFile();
    const fetchImpl = twitchFetch({ tokenAnswers: [{ message: "invalid device code" }] });
    const { port } = await start({ fetchImpl, sleep: async () => {} });
    await send(port, "POST", "/v1/session/auth/twitch/device-login");
    await vi.waitFor(async () =>
      expect(await deviceLoginOf(port, "twitch")).toMatchObject({
        status: "failed",
        error: { message: "Device authorization failed: invalid device code" },
      }),
    );
    expect(await storedFile()).toBe(before);
  });

  it("reports a flow that cannot start", async () => {
    const { port } = await start({
      kick: async () => {
        throw new Error("cycletls did not start");
      },
    });
    const reply = await send(port, "POST", "/v1/session/auth/kick/device-login");
    expect(reply.status).toBe(502);
    expect(errorCode(reply)).toBe("upstream_unavailable");
    expect((await deviceLoginOf(port, "kick"))?.status).toBe("failed");
  });

  it("replaces an in-flight flow; the old one never polls or saves again", async () => {
    const sleep = manualSleep();
    const first = kickClient([{ token: "first-token" }]);
    const second = kickClient([{}]);
    let starts = 0;
    const { port } = await start({
      kick: () => (starts++ === 0 ? first.start() : second.start()),
      sleep: sleep.sleep,
    });
    await send(port, "POST", "/v1/session/auth/kick/device-login");
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));

    await send(port, "POST", "/v1/session/auth/kick/device-login");
    // Replaced while sleeping, before its first poll: no client was started.
    expect(first.createClient).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));
    sleep.release();
    await vi.waitFor(() => expect(second.authenticate).toHaveBeenCalledTimes(1));

    expect(first.authenticate).not.toHaveBeenCalled();
    expect(loadCredentials(dir, {}).kick?.sessionToken).toBeUndefined();
    expect((await deviceLoginOf(port, "kick"))?.status).toBe("pending");
  });

  it("cancels and closes without waiting for a poll that never answers", async () => {
    const sleep = manualSleep();
    let approve: (value: { token?: string }) => void = () => {};
    // Like a hung cycletls request: it ignores the abort signal.
    const authenticate = vi.fn(
      () =>
        new Promise<{ token?: string }>((resolveAuth) => {
          approve = resolveAuth;
        }),
    );
    const dispose = vi.fn(async () => {});
    const { port, host } = await start({
      kick: () =>
        startKickDeviceLogin({
          link: { uuid: "U", code: "1", verificationUrl: "https://kick.com/tv/login" },
          createClient: async () => ({
            authenticate: authenticate as unknown as TvLinkAuthenticator,
            dispose,
          }),
        }),
      sleep: sleep.sleep,
    });
    const hang = async () => {
      await send(port, "POST", "/v1/session/auth/kick/device-login");
      await vi.waitFor(() => expect(sleep.waiting).toBe(1));
      sleep.release();
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalledTimes(1));
      authenticate.mockClear();
    };

    await hang();
    const cancelled = await send(port, "DELETE", "/v1/session/auth/kick/device-login");
    expect((cancelled.json as { deviceLogin: { status: string } }).deviceLogin.status).toBe(
      "cancelled",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    // The hung request answering later saves nothing.
    approve({ token: "late-token" });
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    expect(loadCredentials(dir, {}).kick?.sessionToken).toBeUndefined();

    await hang();
    await host.close();
    expect(dispose).toHaveBeenCalledTimes(2);
    approve({ token: "late-token" });
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    expect(loadCredentials(dir, {}).kick?.sessionToken).toBeUndefined();
  });

  it("keeps one flow when two starts race, and close() reaches it", async () => {
    const sleep = manualSleep();
    let releaseDispose: () => void = () => {};
    const clients = [kickClient([{}]), kickClient([{}]), kickClient([{}])];
    // The first flow is slow to release, so both restarts wait on it together.
    clients[0]!.dispose.mockImplementation(
      () =>
        new Promise<void>((resolveDispose) => {
          releaseDispose = resolveDispose;
        }),
    );
    let starts = 0;
    const { port, host } = await start({
      kick: () => clients[starts++]!.start(),
      sleep: sleep.sleep,
    });
    await send(port, "POST", "/v1/session/auth/kick/device-login");
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));
    sleep.release();
    await vi.waitFor(() => expect(clients[0]!.authenticate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));

    const racing = [
      send(port, "POST", "/v1/session/auth/kick/device-login"),
      send(port, "POST", "/v1/session/auth/kick/device-login"),
    ];
    await vi.waitFor(() => expect(clients[0]!.dispose).toHaveBeenCalledTimes(1));
    releaseDispose();
    const replies = await Promise.all(racing);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    // Only the winner was started, and only it polls.
    expect(starts).toBe(2);
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));
    sleep.release();
    await vi.waitFor(() => expect(clients[1]!.authenticate).toHaveBeenCalledTimes(1));

    await host.close();
    expect(clients[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(sleep.waiting).toBe(0);
    expect(clients[2]!.createClient).not.toHaveBeenCalled();
  });

  it("stops polling when serve closes", async () => {
    const sleep = manualSleep();
    const kick = kickClient([{}]);
    const { port, host } = await start({ kick: kick.start, sleep: sleep.sleep });
    await send(port, "POST", "/v1/session/auth/kick/device-login");
    await vi.waitFor(() => expect(sleep.waiting).toBe(1));

    await host.close();

    expect(kick.createClient).not.toHaveBeenCalled();
    expect(sleep.waiting).toBe(0);
    sleep.release();
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
    expect(kick.authenticate).not.toHaveBeenCalled();
  });

  it("uses abortable timers that close() clears", async () => {
    const kick = kickClient([]);
    const { port, host } = await start({ kick: kick.start });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await send(port, "POST", "/v1/session/auth/kick/device-login");
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await host.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serve: logout and status", () => {
  it("forgets one platform, cancels its flow and reports an environment override", async () => {
    saveCredentials(dir, {
      twitch: { authToken: "twitchstored", clientId: "c" },
      kick: { sessionToken: "kickstored" },
    });
    const sleep = manualSleep();
    const kick = kickClient([]);
    const { port, handleMessage } = await start({
      kick: kick.start,
      sleep: sleep.sleep,
      env: { SA_KICK_SESSION_TOKEN: "kickenv" },
    });
    await send(port, "POST", "/v1/session/auth/kick/device-login");

    const reply = await send(port, "POST", "/v1/session/auth/kick/logout");
    expect(reply.json).toEqual({ platform: "kick", forgotten: true, environmentOverride: true });
    expect(loadCredentials(dir, {})).toMatchObject({
      twitch: { authToken: "twitchstored" },
      kick: { sessionToken: undefined },
    });
    expect((await deviceLoginOf(port, "kick"))?.status).toBe("cancelled");
    expect(handleMessage).toHaveBeenCalledWith({ type: "tickNow" });

    const again = await send(port, "POST", "/v1/session/auth/kick/logout", {});
    expect(again.json).toMatchObject({ forgotten: false });
  });

  it("reports masked status per platform", async () => {
    saveCredentials(dir, { twitch: { authToken: "twitchstored", clientId: "c" } });
    const { port } = await start();
    const reply = await send(port, "GET", "/v1/session/auth");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      platforms: {
        twitch: {
          auth: {
            status: expect.any(String),
            credential: { present: true, source: "stored", status: "checking" },
          },
          deviceLogin: null,
        },
        kick: {
          auth: {
            status: expect.any(String),
            credential: { present: false, source: "none", status: "missing_credentials" },
          },
          deviceLogin: null,
        },
      },
    });
    expect(JSON.stringify(reply.json)).not.toContain("twitchstored");
  });
});

describe("serve: no secrets out", () => {
  it("never puts a token, the pasted address or a device code in a response or log", async () => {
    lines.length = 0;
    bodies.length = 0;
    const sleep = manualSleep();
    const fetchImpl = twitchFetch({ tokenAnswers: [{ access_token: DEVICE_TOKEN }] });
    const kick = kickClient([{ token: KICK_TOKEN }]);
    const { port } = await start({ fetchImpl, kick: kick.start, sleep: sleep.sleep });

    await send(port, "GET", "/v1/session/auth/twitch/browser-login");
    // A client that puts the address in the query string still gets nothing logged.
    await send(
      port,
      "POST",
      `/v1/session/auth/twitch/browser-login?address=${encodeURIComponent(PASTED_ADDRESS)}`,
      { address: PASTED_ADDRESS },
    );
    await send(port, "POST", "/v1/session/auth/twitch/device-login");
    await send(port, "POST", "/v1/session/auth/kick/device-login");
    await vi.waitFor(() => expect(sleep.waiting).toBe(2));
    sleep.release();
    await vi.waitFor(async () => {
      expect((await deviceLoginOf(port, "twitch"))?.status).toBe("approved");
      expect((await deviceLoginOf(port, "kick"))?.status).toBe("approved");
    });
    await send(port, "GET", "/v1/session/auth");
    await send(port, "GET", "/v1/session");
    await send(port, "POST", "/v1/session/auth/twitch/logout");
    await send(port, "POST", "/v1/session/auth/kick/logout");
    // A rejected paste carries the token too; its error must not echo it.
    const rejected = await start({
      fetchImpl: twitchFetch({ validate: { status: 401, body: { message: "invalid" } } }),
    });
    await send(rejected.port, "POST", "/v1/session/auth/twitch/browser-login", {
      address: PASTED_ADDRESS,
    });

    const responses = bodies.join("\n");
    const log = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [TWITCH_TOKEN, DEVICE_TOKEN, KICK_TOKEN, DEVICE_CODE, "access_token"])
      expect(responses).not.toContain(secret);
    for (const secret of [
      TWITCH_TOKEN,
      DEVICE_TOKEN,
      KICK_TOKEN,
      DEVICE_CODE,
      "access_token",
      KICK_UUID,
      KICK_CODE,
      "ABCDEFGH",
    ])
      expect(log).not.toContain(secret);
  });
});
