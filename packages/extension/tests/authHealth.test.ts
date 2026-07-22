import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, mergeSchedulerState, normalizePlatformAuthHealth } from "@lurkloot/core/defaults";

describe("authentication health normalization", () => {
  it("defaults both platforms to unchecked checking state", () => {
    expect(DEFAULT_STATE.authHealth).toEqual({
      twitch: { status: "checking" },
      kick: { status: "checking" },
    });
    expect(mergeSchedulerState(undefined).authHealth).toEqual(DEFAULT_STATE.authHealth);
  });

  it("adds defaults to legacy state without losing operational data", () => {
    const merged = mergeSchedulerState({ lastTickAt: "2026-07-22T12:00:00.000Z" });
    expect(merged.lastTickAt).toBe("2026-07-22T12:00:00.000Z");
    expect(merged.authHealth).toEqual(DEFAULT_STATE.authHealth);
  });

  it("exposes a normalizer for host-neutral persisted values", () => {
    expect(normalizePlatformAuthHealth({ status: "healthy" })).toEqual({ status: "healthy" });
  });

  it.each([
    ["missing_credentials", "credentials_missing", "authMissingCredentials"],
    ["invalid_credentials", "credentials_rejected", "authInvalidCredentials"],
    ["blocked", "security_policy_blocked", "authSecurityPolicyBlocked"],
    ["unavailable", "credential_lookup_failed", "authCredentialLookupFailed"],
    ["unavailable", "platform_unavailable", "authPlatformUnavailable"],
    ["unavailable", "network_unavailable", "authNetworkUnavailable"],
  ] as const)("round-trips %s with its safe reason", (status, reasonCode, key) => {
    expect(normalizePlatformAuthHealth({
      status,
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode,
      message: { key },
    })).toEqual({
      status,
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode,
      message: { key },
    });
  });

  it("reconstructs safe state without copying secrets or arbitrary metadata", () => {
    const normalized = normalizePlatformAuthHealth({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: {
        key: "authSecurityPolicyBlocked",
        values: { reference: "ref-123", token: "secret" },
        response: "private",
      },
      token: "secret",
      cookie: "secret",
      headers: { authorization: "Bearer secret" },
      response: { account: "private" },
      url: "https://kick.com/?token=secret",
    });

    expect(normalized).toEqual({
      status: "blocked",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked", values: { reference: "ref-123" } },
    });
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });

  it.each([
    undefined,
    null,
    "healthy",
    { status: "unknown", token: "secret" },
  ])("falls back malformed records to checking", (value) => {
    expect(normalizePlatformAuthHealth(value)).toEqual({ status: "checking" });
  });

  it("omits invalid optional metadata while retaining a valid status", () => {
    expect(normalizePlatformAuthHealth({
      status: "healthy",
      checkedAt: "not-a-date",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials", values: { reference: { nested: true } } },
    })).toEqual({ status: "healthy" });

    expect(normalizePlatformAuthHealth({
      status: "blocked",
      reasonCode: "security_policy_blocked",
      message: { key: "unknown", values: { reference: "x" } },
    })).toEqual({ status: "blocked", reasonCode: "security_policy_blocked" });
  });

  it("bounds safe troubleshooting references", () => {
    const base = {
      status: "blocked",
      reasonCode: "security_policy_blocked",
      message: { key: "authSecurityPolicyBlocked" },
    } as const;

    expect(normalizePlatformAuthHealth({ ...base, message: { ...base.message, values: { reference: Number.NaN } } }))
      .toEqual({ ...base, message: base.message });
    expect(normalizePlatformAuthHealth({ ...base, message: { ...base.message, values: { reference: "x".repeat(129) } } }))
      .toEqual({ ...base, message: base.message });
  });
});
