import { describe, expect, it, vi } from "vitest";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { CHROME_JA3 } from "../src/transport/common";

const ENABLED = { twitch: true, kick: true };

interface Captured { url: string; options: { ja3?: string; userAgent?: string; headers: Record<string, string> }; method: string }

function fakeClient(handler: (url: string, options: Captured["options"], method: string) => Promise<{ status: number; data: unknown }>) {
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
