import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCredentials, readCredentialBlob } from "../src/auth/importCredentials";
import { loadCredentials, saveCredentials } from "../src/authStore";
import {
  parseTwitchRedirect,
  twitchAndroidAuthorizeUrl,
  twitchBrowserLogin,
  validateTwitchAndroidToken,
} from "../src/auth/twitchBrowserLogin";
import { requestDeviceCode, startTwitchDeviceLogin } from "../src/auth/twitchDeviceFlow";
import {
  abortableSleep,
  DeviceLoginExpiredError,
  waitForDeviceApproval,
} from "../src/auth/deviceLogin";
import type { Logger } from "../src/logger";
import {
  requestTvLink,
  startKickDeviceLogin,
  type TvLinkAuthenticator,
} from "../src/auth/kickDeviceFlow";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-login-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("importCredentials", () => {
  it("loads a rotated Kasada cookie even when an old environment seed is present", () => {
    saveCredentials(dir, { twitch: { kasadaSessionCookie: "rotated-seed" } });
    expect(
      loadCredentials(dir, { SA_TWITCH_KASADA_SESSION_COOKIE: "stale-seed" }).twitch
        ?.kasadaSessionCookie,
    ).toBe("rotated-seed");
  });

  it("imports a Twitch web session when the export includes Kasada clearance state", async () => {
    const blob = join(dir, "export.json");
    await writeFile(
      blob,
      JSON.stringify({
        version: 1,
        credentials: {
          twitch: {
            authToken: "web-token",
            deviceId: "device-id",
            kasadaSessionCookie: "kasada-seed",
          },
        },
      }),
    );
    const result = importCredentials(dir, blob);
    const creds = loadCredentials(dir, {});
    expect(result.ignoredTwitch).toBe(false);
    expect(creds.twitch).toEqual({
      authToken: "web-token",
      deviceId: "device-id",
      clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
      kasadaSessionCookie: "kasada-seed",
    });
  });

  it("imports Kick but rejects a browser Twitch token without its client identity", async () => {
    const blob = join(dir, "export.json");
    await writeFile(
      blob,
      JSON.stringify({
        version: 1,
        credentials: { twitch: { authToken: "tw" }, kick: { sessionToken: "kk" } },
      }),
    );
    const result = importCredentials(dir, blob);
    const creds = loadCredentials(dir, {});
    expect(creds.twitch?.authToken).toBeUndefined();
    expect(creds.kick?.sessionToken).toBe("kk");
    expect(result.ignoredTwitch).toBe(true);
  });

  it("directs Twitch-only browser exports to Smart TV device login", async () => {
    const blob = join(dir, "export.json");
    await writeFile(
      blob,
      JSON.stringify({ version: 1, credentials: { twitch: { authToken: "tw" } } }),
    );
    expect(() => importCredentials(dir, blob)).toThrow(/auth twitch browser-login/);
  });

  it("rejects a bare { twitch, kick } blob (must be wrapped in credentials)", async () => {
    const blob = join(dir, "bare.json");
    await writeFile(blob, JSON.stringify({ twitch: { authToken: "bare-tw" } }));
    expect(() => readCredentialBlob(blob)).toThrow(/missing a "credentials" object/);
  });

  it("rejects a blob with no usable credential", async () => {
    const blob = join(dir, "empty.json");
    await writeFile(blob, JSON.stringify({ credentials: {} }));
    expect(() => readCredentialBlob(blob)).toThrow(/no Twitch auth token or Kick session token/);
  });
});

describe("kick device-flow", () => {
  it("builds a TV link with an uppercase uuid, 6-digit code, and login URL", () => {
    const link = requestTvLink();
    expect(link.uuid).toMatch(/^[0-9A-F-]{36}$/);
    expect(link.code).toMatch(/^\d{6}$/);
    expect(link.verificationUrl).toBe(
      `https://kick.com/tv/login?uuid=${link.uuid}&code=${link.code}`,
    );
  });

  const kickFlow = (authenticate: ReturnType<typeof vi.fn>, dispose = vi.fn(async () => {})) =>
    startKickDeviceLogin({
      link: { uuid: "UUID", code: "123456", verificationUrl: "https://kick.com/tv/login" },
      createClient: async () => ({ authenticate: authenticate as TvLinkAuthenticator, dispose }),
    });

  it("returns the session token once the user approves", async () => {
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ token: "kick-session" });
    const flow = await kickFlow(authenticate);
    const token = await waitForDeviceApproval(flow, { sleep: async () => {} });
    expect(token).toBe("kick-session");
    expect(flow.credentials(token)).toEqual({ kick: { sessionToken: "kick-session" } });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(authenticate).toHaveBeenCalledWith("UUID", "123456");
  });

  it("throws when the code expires before approval", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    const flow = await kickFlow(authenticate);
    let clock = 0;
    await expect(
      waitForDeviceApproval(flow, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/TV link code expired before approval/);
    // Five-second polls over five minutes.
    expect(authenticate).toHaveBeenCalledTimes(60);
  });
});

describe("device login polling", () => {
  it("clears its timer when aborted", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const sleeping = abortableSleep(60_000, abort.signal);
      expect(vi.getTimerCount()).toBe(1);
      abort.abort(new Error("cancelled"));
      await expect(sleeping).rejects.toThrow("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises DeviceLoginExpiredError with the flow's own message", async () => {
    const flow = {
      platform: "twitch" as const,
      verificationUrl: "https://example.test",
      userCode: "CODE",
      intervalMs: 1000,
      expiresInMs: 0,
      expiredMessage: "gone",
      poll: vi.fn(),
      credentials: () => ({}),
      dispose: async () => {},
    };
    const failure = waitForDeviceApproval(flow, { sleep: async () => {} });
    await expect(failure).rejects.toBeInstanceOf(DeviceLoginExpiredError);
    await expect(failure).rejects.toThrow("gone");
    expect(flow.poll).not.toHaveBeenCalled();
  });
});

describe("twitch device-flow polling", () => {
  const deviceCode = () =>
    new Response(
      JSON.stringify({
        device_code: "device",
        user_code: "user",
        verification_uri: "https://www.twitch.tv/activate",
        interval: 5,
        expires_in: 300,
      }),
      { status: 200 },
    );

  it("requests a code with the Smart TV client accepted by Twitch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => deviceCode());
    vi.stubGlobal("fetch", fetchMock);

    await requestDeviceCode();

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("client_id")).toBe("ue6666qo983tsx6so1t0vnawi233wa");
  });

  it("returns the access token once the user authorizes, backing off on slow_down", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce({ json: async () => ({ message: "authorization_pending" }) })
      .mockResolvedValueOnce({ json: async () => ({ message: "slow_down" }) })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "device-token" }) });
    const flow = await startTwitchDeviceLogin({
      clientId: "client",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(flow).toMatchObject({
      verificationUrl: "https://www.twitch.tv/activate",
      userCode: "user",
      intervalMs: 5000,
      expiresInMs: 300_000,
    });
    const sleeps: number[] = [];
    const token = await waitForDeviceApproval(flow, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(token).toBe("device-token");
    expect(sleeps).toEqual([5000, 5000, 10_000]);
    expect(flow.credentials(token)).toEqual({
      twitch: { authToken: "device-token", clientId: "client" },
    });
    const pollBody = fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(pollBody.get("device_code")).toBe("device");
  });

  it("throws on a hard authorization error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValue({ json: async () => ({ message: "invalid device code" }) });
    const flow = await startTwitchDeviceLogin({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(waitForDeviceApproval(flow, { sleep: async () => {} })).rejects.toThrow(
      /Device authorization failed: invalid device code/,
    );
  });
});

describe("twitch browser login", () => {
  const ANDROID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
  const lines: string[] = [];
  const logger: Logger = {
    level: "info",
    log: (_level, message) => lines.push(message),
    debug: (message) => lines.push(message),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
  const validateWith = (status: number, body: Record<string, unknown>) =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    ) as unknown as typeof fetch;

  beforeEach(() => {
    lines.length = 0;
  });

  it("builds the Android implicit-grant link with twitch.tv as the redirect", () => {
    const url = new URL(twitchAndroidAuthorizeUrl());
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(ANDROID);
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.twitch.tv/");
  });

  it("reads the token from the full redirect address or its fragment", () => {
    expect(
      parseTwitchRedirect(
        "  https://www.twitch.tv/#access_token=abc123xyz&scope=user_read&token_type=bearer\n",
      ),
    ).toBe("abc123xyz");
    expect(parseTwitchRedirect("access_token=abc123xyz&token_type=bearer")).toBe("abc123xyz");
  });

  it("rejects an address without a token, an empty paste, and a refused sign-in", () => {
    expect(() => parseTwitchRedirect("https://www.twitch.tv/")).toThrow(/no access_token/);
    expect(() => parseTwitchRedirect("   ")).toThrow(/Nothing was pasted/);
    expect(() =>
      parseTwitchRedirect(
        "https://www.twitch.tv/#error=access_denied&error_description=The+user+denied+you+access",
      ),
    ).toThrow(/The user denied you access/);
  });

  it("refuses a token issued to another client", async () => {
    await expect(
      validateTwitchAndroidToken("tok", validateWith(200, { client_id: "other-client" })),
    ).rejects.toThrow(/not issued by the sign-in link/);
    await expect(
      validateTwitchAndroidToken(
        "tok",
        validateWith(401, { status: 401, message: "invalid access token" }),
      ),
    ).rejects.toThrow(/HTTP 401 invalid access token/);
  });

  it("saves the token with the Android client and drops leftovers of a web import", async () => {
    saveCredentials(dir, {
      twitch: {
        authToken: "old-web",
        clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
        deviceId: "web-device",
        kasadaSessionCookie: "kasada",
      },
      kick: { sessionToken: "kick-token" },
    });
    const fetchImpl = validateWith(200, { client_id: ANDROID, login: "someone", user_id: "1" });

    await twitchBrowserLogin(
      dir,
      logger,
      async () => "https://www.twitch.tv/#access_token=newtoken123&token_type=bearer",
      fetchImpl,
    );

    const stored = loadCredentials(dir, {});
    expect(stored.twitch).toEqual({ authToken: "newtoken123", clientId: ANDROID });
    expect(stored.kick).toEqual({ sessionToken: "kick-token" });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "OAuth newtoken123" },
    });
    // The token itself is never written to the log.
    expect(lines.join("\n")).not.toContain("newtoken123");
    expect(lines.join("\n")).toContain("https://id.twitch.tv/oauth2/authorize?");
  });

  it("keeps the stored login when validation fails", async () => {
    saveCredentials(dir, {
      twitch: { authToken: "keep-me", clientId: "ue6666qo983tsx6so1t0vnawi233wa" },
    });

    await expect(
      twitchBrowserLogin(
        dir,
        logger,
        async () => "https://www.twitch.tv/#access_token=bad&token_type=bearer",
        validateWith(401, { status: 401, message: "invalid access token" }),
      ),
    ).rejects.toThrow(/HTTP 401/);

    expect(loadCredentials(dir, {}).twitch?.authToken).toBe("keep-me");
  });
});
