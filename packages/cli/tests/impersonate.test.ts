import { describe, expect, it, vi } from "vitest";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { createTvLinkAuthenticator } from "../src/transport/cycle";
import { CHROME_JA3 } from "../src/transport/common";

const ENABLED = { twitch: true, kick: true };

interface Captured { url: string; options: { ja3?: string; userAgent?: string; headers: Record<string, string> }; method: string }

function fakeClient(handler: (url: string, options: Captured["options"], method: string) => Promise<{ status: number; data: unknown; headers?: Record<string, unknown> }>) {
  const client: any = (url: string, options: Captured["options"], method: string) => handler(url, options, method);
  client.exit = vi.fn(async () => undefined);
  client.ws = vi.fn(async () => ({ send: vi.fn(), close: vi.fn(), onMessage: () => {}, onClose: () => {}, onError: () => {} }));
  return client;
}

describe("impersonate transport", () => {
  it("reaches Kick with a Chrome JA3 fingerprint, Origin, and session Bearer", async () => {
    let captured: Captured | undefined;
    const client = fakeClient((url, options, method) => {
      captured = { url, options, method };
      return Promise.resolve({ status: 200, data: { data: [] } });
    });
    const handle = await createImpersonateTransport({ kick: { sessionToken: "sess-token" } }, ENABLED, { initClient: async () => client });

    const campaigns = await handle.adapters.kick.discoverCampaigns();
    expect(campaigns).toEqual([]);
    expect(captured?.method).toBe("get");
    expect(captured?.options.ja3).toBe(CHROME_JA3);
    expect(captured?.options.userAgent).toContain("Chrome/124");
    expect(captured?.options.headers.Origin).toBe("https://kick.com");
    expect(captured?.options.headers.authorization).toBe("Bearer sess-token");

    await handle.dispose();
    expect(client.exit).toHaveBeenCalledTimes(1);
  });

  it("surfaces a Cloudflare 403 as KickWafBlockedError", async () => {
    const client = fakeClient(() => Promise.resolve({ status: 403, data: "blocked" }));
    const handle = await createImpersonateTransport({}, ENABLED, { initClient: async () => client });
    await expect(handle.adapters.kick.discoverCampaigns()).rejects.toBeInstanceOf(KickWafBlockedError);
    await handle.dispose();
  });

  it("builds a Twitch adapter that does not require cycletls (no WAF there)", async () => {
    const client = fakeClient(() => Promise.resolve({ status: 200, data: {} }));
    const handle = await createImpersonateTransport({}, ENABLED, { initClient: async () => client });
    expect(handle.adapters.twitch.platform).toBe("twitch");
    expect(handle.adapters.kick.platform).toBe("kick");
    await handle.dispose();
  });
});

describe("createTvLinkAuthenticator", () => {
  const CSRF_COOKIES = { "Set-Cookie": ["XSRF-TOKEN=tok%2D123; Path=/", "kick_session=sess; Path=/"] };

  it("warms up CSRF then POSTs the code with cookies + X-XSRF-TOKEN, returning the token", async () => {
    const calls: Captured[] = [];
    const client = fakeClient((url, options, method) => {
      calls.push({ url, options, method });
      if (url.endsWith("/sanctum/csrf-cookie")) return Promise.resolve({ status: 204, data: "", headers: CSRF_COOKIES });
      return Promise.resolve({ status: 200, data: { token: "tv-session" } });
    });
    const result = await createTvLinkAuthenticator(client)("ABC-UUID", "123456");
    expect(result.token).toBe("tv-session");

    const warmUp = calls.find((c) => c.url.endsWith("/sanctum/csrf-cookie"));
    expect(warmUp?.method).toBe("get");
    const post = calls.find((c) => c.url.includes("/api/tv/link/authenticate/"));
    expect(post?.method).toBe("post");
    expect(post?.url).toBe("https://kick.com/api/tv/link/authenticate/ABC-UUID");
    expect(post?.options.ja3).toBe(CHROME_JA3);
    expect(post?.options.headers["X-XSRF-TOKEN"]).toBe("tok-123"); // URL-decoded
    expect(post?.options.headers.Cookie).toContain("XSRF-TOKEN=tok%2D123");
  });

  it("warms up only once across polls", async () => {
    let warmUps = 0;
    const client = fakeClient((url) => {
      if (url.endsWith("/sanctum/csrf-cookie")) { warmUps += 1; return Promise.resolve({ status: 204, data: "", headers: CSRF_COOKIES }); }
      return Promise.resolve({ status: 403, data: '{"message":"Invalid setup UUID and Key"}' });
    });
    const authenticate = createTvLinkAuthenticator(client);
    expect(await authenticate("UUID", "000000")).toEqual({ token: undefined });
    expect(await authenticate("UUID", "000000")).toEqual({ token: undefined });
    expect(warmUps).toBe(1);
  });

  it("throws if Kick issues no XSRF-TOKEN cookie", async () => {
    const client = fakeClient(() => Promise.resolve({ status: 204, data: "", headers: { "Set-Cookie": ["kick_session=sess"] } }));
    await expect(createTvLinkAuthenticator(client)("UUID", "000000")).rejects.toThrow(/XSRF-TOKEN/);
  });
});
