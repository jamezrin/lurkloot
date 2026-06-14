import type { CookieApi } from "@stream-autopilot/core/tabs";
import type { PlatformCredentials } from "../authStore";

// Backs the core fetchers' CookieApi with the CLI's stored credentials instead of
// a browser cookie jar. The core *WithBrowser/*With fetchers already contain all
// the auth-header logic (Twitch OAuth + device id + integrity replay, Kick bearer
// token), reading the underlying secrets through CookieApi.cookies.get — so the
// HTTP transport reuses that logic wholesale by mapping the cookie names the
// fetchers ask for to the values in the auth store.
export function createStoreCookieApi(credentials: PlatformCredentials): CookieApi {
  return {
    cookies: {
      get: async ({ url, name }) => {
        // Match on the actual hostname, not a substring: `url.includes("twitch.tv")`
        // would also match e.g. https://twitch.tv.evil.example/ and hand the session
        // token to an off-origin URL.
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          return undefined;
        }
        const onHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
        if (onHost("twitch.tv")) {
          if (name === "auth-token") return { value: credentials.twitch?.authToken };
          if (name === "unique_id") return { value: credentials.twitch?.deviceId };
        }
        if (onHost("kick.com")) {
          if (name === "session_token") return { value: credentials.kick?.sessionToken };
        }
        return undefined;
      },
    },
  };
}
