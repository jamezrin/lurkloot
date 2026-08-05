import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import type { PlatformCredentials } from "../authStore";
import { kickCookieApi, twitchCookieApi } from "./cookieApi";
import { createCliAdapters, withHeartbeatTimeout, type EnabledPlatforms, type TransportHandle } from "./common";

// Plain Node fetch transport. Twitch GQL works (no WAF). Kick's Cloudflare WAF
// fingerprints the TLS/HTTP-2 stack, so pure-Node requests get HTTP 403 — that
// surfaces as the engine's KickWafBlockedError, which `discover`/`run` report
// cleanly (reach Kick without a browser via the impersonate transport instead).
export function createHttpTransport(creds: PlatformCredentials, _enabled: EnabledPlatforms): TransportHandle {
  const twitchApi = twitchCookieApi(creds);
  const kickApi = kickCookieApi(creds);
  const { adapters, createAdapter, createAdapters } = createCliAdapters(creds, {
    twitchFetcher: () => ({ fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchApi, url, init) }),
    twitchHeartbeat: () => ({
      heartbeatFetchText: async (url, init) => {
        const response = await withHeartbeatTimeout(
          (signal) => fetch(url, { ...init, signal }),
          init?.signal,
        );
        return response.text();
      },
      heartbeatPost: async (url, init) => {
        const response = await withHeartbeatTimeout(
          (signal) => fetch(url, { ...init, signal }),
          init.signal,
        );
        return { status: response.status };
      },
    }),
    kickFetcher: () => ({ fetchJson: (url, init) => fetchKickInBackgroundWith(kickApi, url, init) }),
  });
  return {
    adapters,
    createAdapter,
    createAdapters,
    async dispose() {
      // The http transport holds no long-lived resources.
    },
  };
}
