import type { PageFetcher } from "@stream-autopilot/core/adapter";
import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith, KickWafBlockedError } from "@stream-autopilot/core/tabs";
import { createKickFetcher, KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { createStoreCookieApi } from "./cookieApi";
import { tablessWatchPort, type TransportHandle } from "./common";

// Pure-Node HTTP transport: builds the core adapters with fetchers that issue
// plain server-side fetches, attaching auth from the store-backed CookieApi. No
// page-context tab is available here, so Kick (whose Cloudflare WAF rejects
// non-browser origins) is best-effort — a WAF block surfaces clearly and the
// impersonate/browser transports are the reliable Kick paths. Tabless-only.
export function createHttpTransport(credentials: PlatformCredentials): TransportHandle {
  const cookieApi = createStoreCookieApi(credentials);

  const twitchFetcher: PageFetcher = {
    fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
  };

  const kickFetcher = createKickFetcher({
    background: (url, init) => fetchKickInBackgroundWith(cookieApi, url, init),
    // No page-context fallback in the HTTP transport: a WAF block fails loudly
    // toward the impersonate/browser transports rather than silently degrading.
    pageFetch: async () => {
      throw new KickWafBlockedError(
        "Kick was WAF-blocked and the http transport has no fallback; use transport: \"impersonate\" or \"browser\".",
      );
    },
  });

  return {
    adapters: {
      twitch: new TwitchAdapter(twitchFetcher, { clientId: credentials.twitch?.clientId, watchTabs: tablessWatchPort }),
      kick: new KickAdapter(kickFetcher, { watchTabs: tablessWatchPort }),
    },
    dispose: async () => {
      // no resources to release
    },
  };
}
