import { fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { twitchClientIdentity } from "../twitch";
import { twitchCookieApi } from "./cookieApi";
import { createCycleKickFetcher, createCycleKickWebSocketFactory, initCycle, type CycleTLSClient } from "./cycle";
import { tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";

export interface ImpersonateDeps {
  // Injectable for tests; defaults to spawning the real cycletls subprocess.
  initClient?: () => Promise<CycleTLSClient>;
}

// Impersonate transport: routes Kick over cycletls with a real Chrome JA3 /
// HTTP-2 fingerprint so Cloudflare's WAF — which fingerprints the TLS/HTTP-2
// stack, not headers — lets the request through (pure Node fetch gets 403). The
// viewer WebSocket rides the same impersonated session. Twitch has no such WAF,
// so it uses the plain-fetch path (cookie-backed engine fetcher).
export async function createImpersonateTransport(
  creds: PlatformCredentials,
  _enabled: EnabledPlatforms,
  deps: ImpersonateDeps = {},
): Promise<TransportHandle> {
  const cycleTLS = await (deps.initClient ?? initCycle)();

  return {
    adapters: {
      twitch: new TwitchAdapter(
        { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchCookieApi(creds), url, init) },
        async () => false,
        tablessWatchPort,
        twitchClientIdentity(creds),
      ),
      kick: new KickAdapter(
        createCycleKickFetcher(cycleTLS, creds),
        tablessWatchPort,
        createCycleKickWebSocketFactory(cycleTLS, creds),
      ),
    },
    async dispose() {
      await cycleTLS.exit();
    },
  };
}
