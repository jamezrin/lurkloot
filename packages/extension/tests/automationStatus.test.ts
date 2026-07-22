import { describe, expect, it } from "vitest";
import type { PlatformAuthHealth } from "@lurkloot/shared/models";
import {
  AUTH_SIGN_IN_URLS,
  automationPresentation,
} from "../../popup-ui/src/automationStatus";

function health(
  status: PlatformAuthHealth["status"],
  reasonCode?: PlatformAuthHealth["reasonCode"],
): PlatformAuthHealth {
  return {
    status,
    reasonCode,
    message: {
      key: status === "blocked" ? "authSecurityPolicyBlocked" : "authPlatformUnavailable",
      values: { reference: "must-not-render" },
    },
  };
}

describe("automation authentication presentation", () => {
  it("gives pending and paused states precedence", () => {
    expect(automationPresentation({
      platform: "twitch",
      enabled: true,
      pending: true,
      authHealth: health("missing_credentials"),
    }).state).toBe("starting");
    expect(automationPresentation({
      platform: "twitch",
      enabled: false,
      pending: true,
      authHealth: health("healthy"),
    }).state).toBe("stopping");
    expect(automationPresentation({
      platform: "kick",
      enabled: false,
      pending: false,
      authHealth: health("blocked"),
    }).state).toBe("paused");
  });

  it.each([
    ["healthy", undefined, "running", "automationRunning", "accent", undefined],
    ["checking", undefined, "checking", "automationChecking", "muted", "authCheckingDetail"],
    ["missing_credentials", "credentials_missing", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInMissing"],
    ["invalid_credentials", "credentials_rejected", "needs_sign_in", "automationNeedsSignIn", "warning", "authSignInRejected"],
    ["blocked", "security_policy_blocked", "blocked", "automationBlocked", "danger", "authBrowserProfileBlocked"],
    ["unavailable", "credential_lookup_failed", "unavailable", "automationUnavailable", "warning", "authCredentialCheckUnavailable"],
    ["unavailable", "network_unavailable", "unavailable", "automationUnavailable", "warning", "authNetworkTemporarilyUnavailable"],
    ["unavailable", "platform_unavailable", "unavailable", "automationUnavailable", "warning", "authPlatformTemporarilyUnavailable"],
  ] as const)("maps %s/%s", (status, reasonCode, state, badgeKey, tone, detailKey) => {
    expect(automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: health(status, reasonCode),
    })).toMatchObject({ state, badgeKey, tone, detailKey });
  });

  it.each(["missing_credentials", "invalid_credentials"] as const)(
    "provides fixed sign-in actions for %s",
    (status) => {
      expect(automationPresentation({
        platform: "twitch",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toEqual({ labelKey: "signInToTwitch", url: AUTH_SIGN_IN_URLS.twitch });
      expect(automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toEqual({ labelKey: "signInToKick", url: AUTH_SIGN_IN_URLS.kick });
    },
  );

  it.each(["checking", "healthy", "blocked", "unavailable"] as const)(
    "does not offer sign-in for %s",
    (status) => {
      expect(automationPresentation({
        platform: "kick",
        enabled: true,
        pending: false,
        authHealth: health(status),
      }).action).toBeUndefined();
    },
  );

  it("does not propagate authentication message values", () => {
    expect(JSON.stringify(automationPresentation({
      platform: "kick",
      enabled: true,
      pending: false,
      authHealth: health("blocked", "security_policy_blocked"),
    }))).not.toContain("must-not-render");
  });
});
