import { describe, expect, it } from "vitest";
import { isSafeFetchError, SafeFetchError, safeFetchFailure } from "@lurkloot/core/fetchError";

describe("sanitized fetch failures", () => {
  it("retains only bounded troubleshooting metadata", () => {
    const failure = safeFetchFailure({
      kind: "security_policy_blocked",
      status: 403,
      reason: "Request blocked by security policy.",
      reference: "9e4db7e3",
      token: "secret-token",
      cookie: "session_token=secret",
      headers: { authorization: "Bearer secret" },
      url: "https://kick.com/?token=secret",
      body: { account: "private" },
    });

    expect(failure).toEqual({
      kind: "security_policy_blocked",
      status: 403,
      reason: "Request blocked by security policy.",
      reference: "9e4db7e3",
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("drops invalid optional metadata", () => {
    expect(safeFetchFailure({
      kind: "http_error",
      status: -1,
      reason: "x".repeat(257),
      reference: "x".repeat(129),
    })).toEqual({ kind: "http_error" });
    expect(safeFetchFailure({
      kind: "network_error",
      status: 1000,
      reference: Number.NaN,
    })).toEqual({ kind: "network_error" });
  });

  it("constructs recognizable errors without copying source secrets", () => {
    const error = new SafeFetchError({
      kind: "authentication_rejected",
      status: 401,
      reason: "Unauthenticated",
      token: "secret",
    } as never);

    expect(isSafeFetchError(error)).toBe(true);
    expect(isSafeFetchError(new Error("HTTP 401"))).toBe(false);
    expect(error.message).toBe("HTTP 401 Unauthenticated");
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
