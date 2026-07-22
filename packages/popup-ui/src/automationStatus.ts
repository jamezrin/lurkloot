import type { Platform, PlatformAuthHealth } from "@lurkloot/shared/models";

export type AutomationPresentationState =
  | "starting"
  | "stopping"
  | "paused"
  | "running"
  | "checking"
  | "needs_sign_in"
  | "blocked"
  | "unavailable";

export type AutomationTone = "muted" | "accent" | "warning" | "danger";

export interface AutomationPresentation {
  state: AutomationPresentationState;
  badgeKey: string;
  detailKey?: string;
  tone: AutomationTone;
  operational: boolean;
  action?: {
    labelKey: "signInToTwitch" | "signInToKick";
    url: string;
  };
}

export const AUTH_SIGN_IN_URLS: Record<Platform, string> = {
  twitch: "https://www.twitch.tv/login",
  kick: "https://kick.com/login",
};

export function automationPresentation({
  platform,
  enabled,
  pending,
  authHealth,
}: {
  platform: Platform;
  enabled: boolean;
  pending: boolean;
  authHealth: PlatformAuthHealth;
}): AutomationPresentation {
  if (pending) {
    return enabled
      ? presentation("starting", "automationStarting", "startingAutomation")
      : presentation("stopping", "automationStopping", "pausingAutomation");
  }
  if (!enabled) return presentation("paused", "pausedStatus", "watchingPausedHint");

  switch (authHealth.status) {
    case "healthy":
      return {
        state: "running",
        badgeKey: "automationRunning",
        detailKey: undefined,
        tone: "accent",
        operational: true,
      };
    case "checking":
      return presentation("checking", "automationChecking", "authCheckingDetail");
    case "missing_credentials":
      return signInPresentation(platform, "authSignInMissing");
    case "invalid_credentials":
      return signInPresentation(platform, "authSignInRejected");
    case "blocked":
      return presentation("blocked", "automationBlocked", "authBrowserProfileBlocked", "danger");
    case "unavailable": {
      const detailKey = authHealth.reasonCode === "credential_lookup_failed"
        ? "authCredentialCheckUnavailable"
        : authHealth.reasonCode === "network_unavailable"
          ? "authNetworkTemporarilyUnavailable"
          : "authPlatformTemporarilyUnavailable";
      return presentation("unavailable", "automationUnavailable", detailKey, "warning");
    }
  }
}

function presentation(
  state: AutomationPresentationState,
  badgeKey: string,
  detailKey: string,
  tone: AutomationTone = "muted",
): AutomationPresentation {
  return { state, badgeKey, detailKey, tone, operational: false };
}

function signInPresentation(
  platform: Platform,
  detailKey: string,
): AutomationPresentation {
  return {
    ...presentation("needs_sign_in", "automationNeedsSignIn", detailKey, "warning"),
    action: {
      labelKey: platform === "twitch" ? "signInToTwitch" : "signInToKick",
      url: AUTH_SIGN_IN_URLS[platform],
    },
  };
}
