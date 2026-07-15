import { fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import { resolveCompatibility } from "@lurkloot/core";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformCredentials } from "../authStore";
import { twitchClientIdentity } from "../twitch";
import { twitchCookieApi } from "./cookieApi";
import { createCycleKickFetcher, createCycleKickWebSocketFactory, initCycle, type CycleTLSClient } from "./cycle";
import { CHROME_HTTP2, CHROME_JA3, headersToObject, tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";

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
  const createAdapters = (emit: EventEmitter | undefined, settings = DEFAULT_ENGINE_SETTINGS) => {
    const identity = twitchClientIdentity(creds);
    const twitchIdentity = identity.userAgent ? "android" : "web";
    const resolution = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity });
    return {
      adapters: {
        twitch: new TwitchAdapter(
          { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchCookieApi(creds), url, init) },
          async () => false,
          tablessWatchPort,
          {
            ...identity,
            compatibility: resolution.compatibility.twitch,
            heartbeatIdentity: twitchIdentity,
            heartbeatFetchText: async (url, init) => {
              const response = await cycleTLS(url, {
                ja3: CHROME_JA3,
                http2Fingerprint: CHROME_HTTP2,
                userAgent: identity.userAgent,
                headers: headersToObject(init?.headers),
                body: typeof init?.body === "string" ? init.body : undefined,
                disableRedirect: init?.redirect === "error" || init?.redirect === "manual",
              }, (init?.method ?? "GET").toLowerCase() as "get" | "post");
              return typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
            },
            heartbeatPost: async (url, init) => {
              const response = await cycleTLS(url, {
                ja3: CHROME_JA3,
                http2Fingerprint: CHROME_HTTP2,
                userAgent: identity.userAgent,
                headers: headersToObject(init.headers),
                body: typeof init.body === "string" ? init.body : undefined,
                disableRedirect: init.redirect === "error" || init.redirect === "manual",
              }, "post");
              return { status: response.status };
            },
          },
          emit,
        ),
        kick: new KickAdapter(
          createCycleKickFetcher(cycleTLS, creds),
          tablessWatchPort,
          createCycleKickWebSocketFactory(cycleTLS, creds),
          emit,
          { compatibility: resolution.compatibility.kick },
        ),
      },
      ...resolution,
    };
  };

  return {
    adapters: createAdapters(undefined).adapters,
    createAdapters,
    async dispose() {
      await cycleTLS.exit();
    },
  };
}
