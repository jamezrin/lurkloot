import type { Platform } from "@stream-autopilot/shared/models";
import type { PageFetcher, PlatformAdapter } from "@stream-autopilot/core/adapter";
import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith, KickWafBlockedError } from "@stream-autopilot/core/tabs";
import { createKickFetcher, KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { createStoreCookieApi } from "./cookieApi";

// Pure-Node HTTP transport: builds the core adapters with fetchers that issue
// plain server-side fetches, attaching auth from the store-backed CookieApi. No
// page-context tab is available here, so Kick (whose Cloudflare WAF rejects
// non-browser origins) is best-effort — a WAF block surfaces clearly and the
// browser transport is the reliable Kick path. Tabless-only: no WatchTabPort is
// injected, so the scheduler must run these platforms in tabless mode.
export function createHttpAdapters(credentials: PlatformCredentials): Record<Platform, PlatformAdapter> {
  const cookieApi = createStoreCookieApi(credentials);

  const twitchFetcher: PageFetcher = {
    fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
  };

  const kickFetcher = createKickFetcher({
    background: (url, init) => fetchKickInBackgroundWith(cookieApi, url, init),
    // No page-context fallback exists in the HTTP transport. If the service-worker-
    // style fetch is WAF-blocked, fail loudly pointing at the browser transport
    // rather than silently degrading.
    pageFetch: async () => {
      throw new KickWafBlockedError(
        "Kick was WAF-blocked and the http transport has no page-context fallback; use transport: \"browser\".",
      );
    },
  });

  return {
    twitch: new TwitchAdapter(twitchFetcher, { clientId: credentials.twitch?.clientId }),
    kick: new KickAdapter(kickFetcher),
  };
}
