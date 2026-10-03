import { fetchTwitchInBackgroundWith } from "@lurkloot/core/transport";
import type { PlatformCredentials } from "../authStore";
import { twitchCookieApi } from "./cookieApi";
import { createCycleKickFetcher, createNodeKickWebSocketFactory, initCycle, type CycleTLSClient } from "./cycle";
import { CHROME_HTTP2, CHROME_JA3, createCliAdapters, headersToObject, withHeartbeatTimeout, type CliTwitchIntegrity, type EnabledPlatforms, type TransportHandle } from "./common";

export interface ImpersonateDeps {
  // Injectable for tests; defaults to spawning the real cycletls subprocess.
  initClient?: () => Promise<CycleTLSClient>;
}

// Impersonate transport: routes Kick over cycletls with a real Chrome JA3 /
// HTTP-2 fingerprint so Cloudflare's WAF — which fingerprints the TLS/HTTP-2
// stack, not headers — lets the request through (pure Node fetch gets 403). The
// viewer WebSocket uses Node's ws client with the Kick session bearer; Kick's
// handshake accepts it. Twitch has no such WAF, so its GQL uses plain fetch.
export async function createImpersonateTransport(
  creds: PlatformCredentials,
  _enabled: EnabledPlatforms,
  deps: ImpersonateDeps = {},
  twitchIntegrity?: CliTwitchIntegrity,
): Promise<TransportHandle> {
  const cycleTLS = await (deps.initClient ?? initCycle)();
  const { adapters, createAdapter, createAdapters } = createCliAdapters(creds, {
    twitchIntegrity,
    twitchFetcher: () => ({ fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchCookieApi(creds), url, init) }),
    twitchHeartbeat: (identity) => ({
      heartbeatFetchText: async (url, init) => {
        const response = await withHeartbeatTimeout(() => cycleTLS(url, {
          ja3: CHROME_JA3,
          http2Fingerprint: CHROME_HTTP2,
          userAgent: identity.userAgent,
          headers: headersToObject(init?.headers),
          body: typeof init?.body === "string" ? init.body : undefined,
          disableRedirect: init?.redirect === "error" || init?.redirect === "manual",
        }, (init?.method ?? "GET").toLowerCase() as "get" | "post"), init?.signal);
        return Buffer.isBuffer(response.data)
          ? response.data.toString("utf8")
          : typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
      },
      heartbeatPost: async (url, init) => {
        const response = await withHeartbeatTimeout(() => cycleTLS(url, {
          ja3: CHROME_JA3,
          http2Fingerprint: CHROME_HTTP2,
          userAgent: identity.userAgent,
          headers: headersToObject(init.headers),
          body: typeof init.body === "string" ? init.body : undefined,
          disableRedirect: init.redirect === "error" || init.redirect === "manual",
        }, "post"), init.signal);
        return { status: response.status };
      },
    }),
    kickFetcher: () => createCycleKickFetcher(cycleTLS, creds),
    kickWebSocketFactory: () => createNodeKickWebSocketFactory(creds),
  });

  return {
    adapters,
    createAdapter,
    createAdapters,
    async dispose() {
      await cycleTLS.exit();
    },
  };
}
