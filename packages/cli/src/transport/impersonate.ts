import { fetchTwitchInBackgroundWith } from "@lurkloot/core/transport";
import type { KickRealtimeConnection } from "@lurkloot/core/kick/realtime";
import type { PlatformCredentials } from "../authStore";
import { twitchCookieApi } from "./cookieApi";
import { createNodeKickRealtime } from "./kickRealtime";
import { createCycleClient, type CycleTlsClient } from "./cycle";
import { createImpersonatedKickFetcher, createNodeKickWebSocketFactory } from "./kick";
import {
  createImpersonatingClient,
  type ImpersonatingClient,
  type ImpersonationBackend,
} from "./impersonation";
import {
  createCliAdapters,
  headersToObject,
  twitchHeartbeatFailure,
  withHeartbeatTimeout,
  type CliTwitchIntegrity,
  type EnabledPlatforms,
  type TransportHandle,
} from "./common";

function responseLocation(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "location") continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim())
      return value[0].trim();
  }
  return undefined;
}

// A fetch redirect mode as the client takes it: "error" and "manual" both stop
// at the 3xx, which the heartbeat then reads itself.
function redirectMode(redirect: RequestRedirect | undefined): "manual" | undefined {
  return redirect === "error" || redirect === "manual" ? "manual" : undefined;
}

export interface ImpersonateDeps {
  // The browser-impersonating library to send Kick and the Twitch heartbeat
  // through. Default "impit".
  backend?: ImpersonationBackend;
  // Injectable for tests: a ready client, used in place of the backend's.
  createClient?: () => Promise<ImpersonatingClient>;
  // Injectable for tests: a cycletls client (implies the cycletls backend).
  initClient?: () => Promise<CycleTlsClient>;
}

async function openClient(deps: ImpersonateDeps): Promise<ImpersonatingClient> {
  if (deps.createClient) return deps.createClient();
  if (deps.initClient) return createCycleClient(await deps.initClient());
  return createImpersonatingClient(deps.backend ?? "impit");
}

// Impersonate transport: routes Kick over a browser-impersonating client
// (impit by default, or cycletls) with a real Chrome TLS/HTTP-2 fingerprint so
// Cloudflare's WAF — which fingerprints the TLS/HTTP-2 stack, not headers —
// lets the request through (pure Node fetch can get 403). The viewer WebSocket
// uses Node's ws client with the Kick session bearer; Kick's handshake accepts
// it. Twitch has no such WAF, so its GQL uses plain fetch; the Twitch HLS
// heartbeat rides the same client as Kick.
export async function createImpersonateTransport(
  creds: PlatformCredentials,
  _enabled: EnabledPlatforms,
  deps: ImpersonateDeps = {},
  twitchIntegrity?: CliTwitchIntegrity,
): Promise<TransportHandle> {
  const client = await openClient(deps);
  const kickFetcher = createImpersonatedKickFetcher(client, creds);
  let kickRealtime: KickRealtimeConnection | undefined;
  const built = createCliAdapters(creds, {
    twitchIntegrity,
    twitchFetcher: (credentials) => ({
      fetchJson: (url, init) =>
        fetchTwitchInBackgroundWith(twitchCookieApi(credentials), url, init),
    }),
    twitchHeartbeat: (identity) => ({
      heartbeatFetchText: async (url, init) => {
        const response = await withHeartbeatTimeout(
          (signal) =>
            client.request(url, {
              method: (init?.method ?? "GET").toLowerCase() === "post" ? "post" : "get",
              userAgent: identity.userAgent,
              headers: headersToObject(init?.headers),
              body: typeof init?.body === "string" ? init.body : undefined,
              redirect: redirectMode(init?.redirect),
              signal,
            }),
          init?.signal,
        );
        return response.body;
      },
      heartbeatPost: async (url, init) => {
        const response = await withHeartbeatTimeout(
          (signal) =>
            client.request(url, {
              method: "post",
              userAgent: identity.userAgent,
              headers: headersToObject(init.headers),
              body: typeof init.body === "string" ? init.body : undefined,
              redirect: redirectMode(init.redirect),
              signal,
            }),
          init.signal,
        );
        return { status: response.status };
      },
      heartbeatExchange: async (url, init) => {
        const method = (init.method ?? "GET").toLowerCase() === "head" ? "head" : "get";
        try {
          const response = await withHeartbeatTimeout(
            (signal) =>
              client.request(url, {
                method,
                userAgent: identity.userAgent,
                headers: headersToObject(init.headers),
                redirect: redirectMode(init.redirect),
                signal,
              }),
            init.signal,
          );
          const redirecting = response.status >= 300 && response.status < 400;
          const body =
            method === "head" || redirecting || response.status === 0 ? "" : response.body;
          const reportedUrl = response.finalUrl?.trim() ?? "";
          const location = responseLocation(response.headers);
          return {
            status: response.status,
            body,
            ...(reportedUrl ? { url: reportedUrl } : {}),
            ...(location ? { location } : {}),
          };
        } catch (error) {
          throw twitchHeartbeatFailure(url, error);
        }
      },
    }),
    kickFetcher: () => kickFetcher,
    kickWebSocketFactory: () => createNodeKickWebSocketFactory(creds),
    createKickChatPresenceConnection: () => (kickRealtime ??= createNodeKickRealtime(kickFetcher)),
  });

  return {
    ...built,
    async dispose() {
      await kickRealtime?.stop();
      await client.close();
    },
  };
}
