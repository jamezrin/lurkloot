import { describe, expect, it } from "vitest";
import { integrityExpiry, integrityFromHeaders, OPAQUE_INTEGRITY_CEILING_MS } from "@lurkloot/core/twitchIntegrity";

function jwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "HS256", typ: "JWT" })}.${segment(payload)}.signature`;
}

describe("integrityFromHeaders", () => {
  it("captures the integrity trio from request headers (case-insensitive)", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = jwt({ exp });
    const bundle = integrityFromHeaders([
      { name: "Client-Integrity", value: token },
      { name: "client-session-id", value: "sess" },
      { name: "X-Device-Id", value: "dev" },
      { name: "Authorization", value: "OAuth tok" },
    ]);

    expect(bundle).toEqual({
      integrity: token,
      clientSessionId: "sess",
      deviceId: "dev",
      expiresAt: exp * 1000,
    });
  });

  it("returns undefined when no Client-Integrity header is present", () => {
    expect(integrityFromHeaders([{ name: "Authorization", value: "OAuth tok" }])).toBeUndefined();
    expect(integrityFromHeaders(undefined)).toBeUndefined();
  });
});

describe("integrityExpiry", () => {
  it("uses the JWT exp claim when decodable", () => {
    const exp = 2_000_000_000;
    expect(integrityExpiry(jwt({ exp }))).toBe(exp * 1000);
  });

  it("keeps an opaque token up to the ceiling and marks its expiry as unknown", () => {
    const now = 1_000_000;
    expect(integrityExpiry("v4.local.opaque", now)).toBe(now + OPAQUE_INTEGRITY_CEILING_MS);
    expect(integrityFromHeaders([{ name: "Client-Integrity", value: "v4.local.opaque" }])).toMatchObject({
      expiryUnknown: true,
    });
    expect(OPAQUE_INTEGRITY_CEILING_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
  });
});
