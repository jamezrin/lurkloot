import type { CookieApi } from "@lurkloot/core/tabs";
import type { PlatformCredentials } from "../authStore";

// Backs the engine's cookie-reading fetchers (fetchTwitchInBackgroundWith /
// fetchKickInBackgroundWith) with the CLI auth store, mapping credentials to the
// cookie names those fetchers look up. Lets every transport reuse the engine's
// exact Twitch GQL header logic and Kick Bearer/WAF handling without a browser.
export function twitchCookieApi(creds: PlatformCredentials): CookieApi {
  return {
    cookies: {
      async get({ name }) {
        if (name === "auth-token") return { value: creds.twitch?.authToken };
        if (name === "unique_id") return { value: creds.twitch?.deviceId };
        return undefined;
      },
    },
  };
}

export function kickCookieApi(creds: PlatformCredentials): CookieApi {
  return {
    cookies: {
      async get({ name }) {
        if (name === "session_token") return { value: creds.kick?.sessionToken };
        return undefined;
      },
    },
  };
}
