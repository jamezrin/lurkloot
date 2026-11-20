import { afterEach, describe, expect, it, vi } from "vitest";
import { KickWafBlockedError } from "@lurkloot/core/transport";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { EngineEvent } from "@lurkloot/shared/events";
import { createTransport } from "../src/transport";

// The CLI `http` transport reaches Kick with plain Node fetch through the
// engine's fetchKickInBackgroundWith. Kick's Cloudflare WAF answers that with
// an HTML challenge page, which must read as a WAF block, never as a failed
// sign-in (#1100). These are the response shapes Kick and Cloudflare send.

const ENABLED = { twitch: false, kick: true };
const CREDENTIALS = { kick: { sessionToken: "sess-token" } };
const CHALLENGE_MARKER = "cf-challenge-marker-must-not-survive";

type Shape = () => Response;

// Cloudflare's managed-challenge interstitial: HTML, 403, cf-mitigated header.
const cloudflareChallenge =
  (status: number): Shape =>
  () =>
    new Response(
      `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><noscript>Enable JavaScript and cookies to continue</noscript><script>window._cf_chl_opt={cZone:"kick.com",cType:"managed",cRay:"${CHALLENGE_MARKER}"}</script></body></html>`,
      {
        status,
        headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
      },
    );

// Kick's own rejection of a stale or revoked session token.
const kickAuthRejection: Shape = () =>
  new Response(JSON.stringify({ message: "Unauthenticated." }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

// Kick's security-policy block, which carries a support reference.
const kickSecurityPolicy: Shape = () =>
  new Response(
    JSON.stringify({ error: "Request blocked by security policy.", reference: "9e4db7e3" }),
    { status: 403, headers: { "content-type": "application/json" } },
  );

function stubKick(shape: Shape): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => shape()),
  );
}

async function kickAdapter(emit: (event: EngineEvent) => void = () => {}) {
  const handle = await createTransport("http", CREDENTIALS, "/tmp/auth", ENABLED);
  const { adapter } = handle.createAdapter("kick", emit, DEFAULT_ENGINE_SETTINGS);
  return { handle, adapter };
}

afterEach(() => vi.unstubAllGlobals());

describe("CLI http transport Kick failure classification", () => {
  it.each([
    [
      "an HTML 401 challenge as an unavailable platform",
      cloudflareChallenge(401),
      { status: "unavailable", reasonCode: "waf_challenge" },
    ],
    [
      "an HTML 403 challenge as an unavailable platform",
      cloudflareChallenge(403),
      { status: "unavailable", reasonCode: "waf_challenge" },
    ],
    [
      "a JSON 403 as rejected credentials",
      kickAuthRejection,
      { status: "invalid_credentials", reasonCode: "credentials_rejected" },
    ],
    [
      "a JSON security-policy 403 as a security block",
      kickSecurityPolicy,
      { status: "blocked", reasonCode: "security_policy_blocked" },
    ],
  ] as const)("reports %s from the auth probe", async (_label, shape, expected) => {
    stubKick(shape);
    const { handle, adapter } = await kickAdapter();
    try {
      const health = await adapter.checkAuthHealth();
      expect(health).toMatchObject(expected);
      expect(JSON.stringify(health)).not.toContain(CHALLENGE_MARKER);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    ["WAF block", cloudflareChallenge(403)],
    ["auth", kickAuthRejection],
    ["WAF block", kickSecurityPolicy],
  ] as const)(
    "warns about a failed followed-channel lookup with the %s cause",
    async (cause, shape) => {
      stubKick(shape);
      const events: EngineEvent[] = [];
      const { handle, adapter } = await kickAdapter((event) => events.push(event));
      try {
        await expect(adapter.listFollowedChannels?.()).resolves.toEqual([]);
        const warnings = events.flatMap((event) =>
          event.category === "diagnostic" && event.level === "warn" ? [event.message] : [],
        );
        expect(warnings).toEqual([`Kick followed-channel lookup failed (${cause})`]);
        expect(JSON.stringify(events)).not.toContain(CHALLENGE_MARKER);
      } finally {
        await handle.dispose();
      }
    },
  );
  it.each([401, 403])("throws a sanitized WAF challenge error for HTML %s", async (status) => {
    stubKick(cloudflareChallenge(status));
    const { handle, adapter } = await kickAdapter();
    try {
      const error = await adapter.refreshCampaigns().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KickWafBlockedError);
      expect(error).toMatchObject({ challenge: true, failure: { kind: "http_error", status } });
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(CHALLENGE_MARKER);
    } finally {
      await handle.dispose();
    }
  });
});
