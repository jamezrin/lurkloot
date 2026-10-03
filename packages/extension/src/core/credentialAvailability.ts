import type { CredentialAvailability } from "@lurkloot/core/controller";
import type { Platform } from "@lurkloot/shared/models";

export interface CredentialCookieApi {
  get(details: { url: string; name: string }): Promise<{ value?: string } | null>;
}

const REQUIRED_COOKIE: Record<Platform, { url: string; name: string }> = {
  twitch: { url: "https://www.twitch.tv", name: "auth-token" },
  kick: { url: "https://kick.com", name: "session_token" },
};

// The platform's current session credential, or undefined when signed out.
export function createCredentialReader(api: CredentialCookieApi) {
  return async (platform: Platform): Promise<string | undefined> =>
    (await api.get(REQUIRED_COOKIE[platform]))?.value || undefined;
}

export function createCredentialAvailabilityProvider(api: CredentialCookieApi) {
  const read = createCredentialReader(api);
  return async (platform: Platform): Promise<CredentialAvailability> => {
    try {
      return await read(platform) ? { status: "available" } : { status: "missing" };
    } catch {
      return { status: "unavailable" };
    }
  };
}
