import type { CookieApi } from "@lurkloot/core/tabs";
import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";

// Backs the engine's cookie-reading fetchers with the auth store instead of a
// browser cookie jar, so the http transport reuses the engine's exact Twitch
// GQL header logic and Kick WAF detection without faking `browser`.
function twitchCookieApi(creds: PlatformCredentials): CookieApi {
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

function kickCookieApi(creds: PlatformCredentials): CookieApi {
  return {
    cookies: {
      async get({ name }) {
        if (name === "session_token") return { value: creds.kick?.sessionToken };
        return undefined;
      },
    },
  };
}

// Plain Node fetch transport. Twitch GQL works (no WAF). Kick's Cloudflare WAF
// fingerprints the TLS/HTTP-2 stack, so pure-Node requests get HTTP 403 — that
// surfaces as the engine's KickWafBlockedError, which `discover`/`run` report
// cleanly (reach Kick without a browser via the impersonate transport instead).
export function createHttpTransport(creds: PlatformCredentials, _enabled: EnabledPlatforms): TransportHandle {
  const twitchApi = twitchCookieApi(creds);
  const kickApi = kickCookieApi(creds);
  return {
    adapters: {
      twitch: new TwitchAdapter(
        { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchApi, url, init) },
        async () => false,
        tablessWatchPort,
      ),
      kick: new KickAdapter(
        { fetchJson: (url, init) => fetchKickInBackgroundWith(kickApi, url, init) },
        tablessWatchPort,
      ),
    },
    async dispose() {
      // The http transport holds no long-lived resources.
    },
  };
}
