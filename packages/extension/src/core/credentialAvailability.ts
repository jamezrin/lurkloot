import type { CredentialAvailability } from "@lurkloot/core/controller";
import type { Platform } from "@lurkloot/shared/models";

export interface CredentialCookieApi {
  get(details: { url: string; name: string }): Promise<{ value?: string } | null>;
}

const REQUIRED_COOKIE: Record<Platform, { url: string; name: string }> = {
  twitch: { url: "https://www.twitch.tv", name: "auth-token" },
  kick: { url: "https://kick.com", name: "session_token" },
};

export function createCredentialAvailabilityProvider(api: CredentialCookieApi) {
  return async (platform: Platform): Promise<CredentialAvailability> => {
    try {
      const cookie = await api.get(REQUIRED_COOKIE[platform]);
      return cookie?.value ? { status: "available" } : { status: "missing" };
    } catch {
      return { status: "unavailable" };
    }
  };
}
