import { afterEach, describe, expect, it, vi } from "vitest";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { createTvLinkAuthenticator } from "../src/transport/cycle";
import { CHROME_JA3 } from "../src/transport/common";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";

const ENABLED = { twitch: true, kick: true };

afterEach(() => vi.unstubAllGlobals());

interface Captured {
  url: string;
  options: { ja3?: string; userAgent?: string; headers: Record<string, string>; disableRedirect?: boolean };
  method: string;
}

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

  it("injects resolved Android compatibility into both adapters", async () => {
    const client = fakeClient(() => Promise.resolve({ status: 200, data: {} }));
    const handle = await createImpersonateTransport({}, ENABLED, { initClient: async () => client });

    const construction = handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS);

    expect(construction.compatibility.twitch.heartbeat).toBe("twitch-heartbeat-trowel-v1");
    expect(construction.compatibility.twitch.profile).toBe("twitch-2026-07");
    expect(construction.adapters.twitch.compatibility).toEqual(construction.compatibility.twitch);
    expect(construction.adapters.kick.compatibility).toEqual(construction.compatibility.kick);
    await handle.dispose();
  });

  it("shares Kick claim suppression across fresh impersonated adapter constructions", async () => {
    let claimPosts = 0;
    const client = fakeClient((url) => {
      if (url === "https://web.kick.com/api/v1/drops/claim") {
        claimPosts += 1;
        return Promise.resolve({ status: 200, data: { connect_url: "https://accounts.example/link" } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const handle = await createImpersonateTransport({}, ENABLED, { initClient: async () => client });
    const campaign = { id: "campaign" } as DropCampaign;
    const reward = { id: "reward", name: "Reward", status: "claimable" } as DropReward;

    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);
    await handle.createAdapters(() => {}, DEFAULT_ENGINE_SETTINGS).adapters.kick.claimReward(campaign, reward);

    expect(claimPosts).toBe(1);
    await handle.dispose();
  });

  it("sends Trowel through the injected cycletls transport", async () => {
    const calls: Captured[] = [];
    const client = fakeClient((url, options, method) => {
      calls.push({ url, options, method });
      return Promise.resolve({ status: 204, data: "" });
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const handle = await createImpersonateTransport({}, ENABLED, { initClient: async () => client });
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({
      url: "https://trowel.twitch.tv/track",
      method: "post",
    })]));
    await handle.dispose();
  });

  it("sends custom-client Spade page resolution and beacon through cycletls", async () => {
    const calls: Captured[] = [];
    const client = fakeClient((url, options, method) => {
      calls.push({ url, options, method });
      if (url === "https://www.twitch.tv/creator") {
        return Promise.resolve({ status: 200, data: '<script src="https://static.twitch.tv/config/settings.js"></script>' });
      }
      if (url === "https://static.twitch.tv/config/settings.js") {
        return Promise.resolve({ status: 200, data: '{"spade_url":"https://spade.twitch.tv/track"}' });
      }
      return Promise.resolve({ status: 204, data: "" });
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { user: { id: "channel-id", stream: { id: "broadcast-id" } } },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const handle = await createImpersonateTransport({
      twitch: { authToken: "token", clientId: "custom-web-client" },
    }, ENABLED, { initClient: async () => client });
    const watcher = handle.adapters.twitch.createTablessWatcher!();
    await watcher.start({ platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" }, { userId: "viewer-id" });

    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://www.twitch.tv/creator", method: "get" }),
      expect.objectContaining({ url: "https://static.twitch.tv/config/settings.js", method: "get" }),
      expect.objectContaining({ url: "https://spade.twitch.tv/track", method: "post" }),
    ]));
    const page = calls.find((call) => call.url === "https://www.twitch.tv/creator");
    expect(page?.options.disableRedirect).toBe(true);
    const beacon = calls.find((call) => call.url === "https://spade.twitch.tv/track");
    expect(beacon?.options.disableRedirect).toBe(true);
    expect(beacon?.options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
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
