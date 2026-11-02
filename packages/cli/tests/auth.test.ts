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
import { pollForToken, requestDeviceCode } from "../src/auth/twitchDeviceFlow";
import type { Logger } from "../src/logger";
import { pollForToken as pollForKickToken, requestTvLink } from "../src/auth/kickDeviceFlow";

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

  it("returns the session token once the user approves", async () => {
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ token: "kick-session" });
    const token = await pollForKickToken("UUID", "123456", authenticate, 1, 60, async () => {});
    expect(token).toBe("kick-session");
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(authenticate).toHaveBeenCalledWith("UUID", "123456");
  });

  it("throws when the code expires before approval", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    await expect(
      pollForKickToken("UUID", "123456", authenticate, 1, 0, async () => {}),
    ).rejects.toThrow(/expired before approval/);
  });
});

describe("twitch device-flow polling", () => {
  it("requests a code with the Smart TV client accepted by Twitch", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            device_code: "device",
            user_code: "user",
            verification_uri: "https://www.twitch.tv/activate",
            interval: 5,
            expires_in: 300,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestDeviceCode();

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("client_id")).toBe("ue6666qo983tsx6so1t0vnawi233wa");
  });

  it("returns the access token once the user authorizes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ message: "authorization_pending" }) })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "device-token" }) });
    vi.stubGlobal("fetch", fetchMock);
    const token = await pollForToken("dev-code", 1, 60, "client", async () => {});
    expect(token).toBe("device-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a hard authorization error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ message: "invalid device code" }) }),
    );
    await expect(pollForToken("dev-code", 1, 60, "client", async () => {})).rejects.toThrow(
      /invalid device code/,
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
