import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { kickCookieApi, twitchCookieApi } from "./cookieApi";
import { tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";

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
