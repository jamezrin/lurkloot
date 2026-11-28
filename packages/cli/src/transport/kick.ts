import WebSocket, { type ClientOptions } from "ws";
import { kickHttpError, needsKickSessionBearer } from "@lurkloot/core/transport";
import type { PageFetcher } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/webSocket";
import type { PlatformCredentials } from "../authStore";
import { CHROME_UA, hasHeader, headersToObject } from "./common";
import type { ImpersonatingClient } from "./impersonation";

// wss:, not just https:, because the viewer WebSocket (websockets.kick.com)
// goes through this same header builder — see createNodeKickWebSocketFactory.
// This is the only Kick transport that needs the widened protocol set: the
// engine's own callers of needsKickSessionBearer never reach wss.
const KICK_BEARER_PROTOCOLS = ["https:", "wss:"];

export function kickHeaders(
  url: string,
  init: RequestInit | undefined,
  creds: PlatformCredentials,
): Record<string, string> {
  const headers = headersToObject(init?.headers);
  headers.Origin ??= "https://kick.com";
  headers.Referer ??= "https://kick.com/";
  const sessionToken = creds.kick?.sessionToken;
  if (
    sessionToken
    && needsKickSessionBearer(url, { protocols: KICK_BEARER_PROTOCOLS })
    && !hasHeader(headers, "authorization")
  ) {
    headers.authorization = `Bearer ${decodeURIComponent(sessionToken)}`;
  }
  return headers;
}

// Kick PageFetcher over a browser-impersonating client, which carries a
// browser's TLS/HTTP-2 fingerprint past Cloudflare's WAF (pure-Node fetch can
// be refused). Every Kick request, on either backend, sends CHROME_UA, the same
// user agent the viewer WebSocket sends, so one Kick session has one browser
// identity. The caller's abort signal reaches the client; a backend that
// cannot cancel one request (cycletls) leaves the controller deadline to bound
// the caller while the request finishes there.
export function createImpersonatedKickFetcher(
  client: ImpersonatingClient,
  creds: PlatformCredentials,
): PageFetcher {
  return {
    async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
      const method = (init?.method ?? "GET").toLowerCase() === "post" ? "post" : "get";
      const response = await client.request(url, {
        method,
        userAgent: CHROME_UA,
        headers: kickHeaders(url, init, creds),
        body: typeof init?.body === "string" ? init.body : undefined,
        signal: init?.signal ?? undefined,
      });

      if (response.status >= 400) throw kickHttpError(response.status, response.body);

      // Non-JSON (e.g. a channel page) — return the same { html } shape the
      // engine's page fetcher produces so the Kick adapter's HTML fallbacks work.
      const parsed = safeJsonParse(response.body);
      if (parsed !== undefined) return parsed as T;
      return { html: response.body } as T;
    },
  };
}

// The TV-link device-login authenticate endpoint (kick.com/api/tv/link/
// authenticate/<uuid>) sits behind Cloudflare's WAF, handled by the
// impersonated browser fingerprint. Kick no longer issues an XSRF-TOKEN from
// its /sanctum/csrf-cookie endpoint, and this TV endpoint accepts the POST
// without that cookie.
// Returns the token only once the user has approved the link; before that Kick
// answers 403 "Invalid setup UUID and Key" (token-less), which we surface as "no
// token yet" so the caller keeps polling rather than treating it as a failure.
const TV_LINK_AUTHENTICATE = "https://kick.com/api/tv/link/authenticate";

export function createTvLinkAuthenticator(
  client: ImpersonatingClient,
): (uuid: string, code: string) => Promise<{ token?: string }> {
  return async (uuid: string, code: string) => {
    const response = await client.request(`${TV_LINK_AUTHENTICATE}/${encodeURIComponent(uuid)}`, {
      method: "post",
      userAgent: CHROME_UA,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Origin: "https://kick.com",
        Referer: "https://kick.com/",
      },
      body: JSON.stringify({ key: code }),
    });
    const parsed = safeJsonParse(response.body);
    const token =
      parsed && typeof parsed === "object" ? (parsed as { token?: string }).token : undefined;
    return { token: typeof token === "string" && token ? token : undefined };
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Neither backend opens Kick's viewer WebSocket (CycleTLS's WebSocket support
// never resolved a live viewer connection; impit has no WebSocket client). The Node
// WebSocket client completes Kick's handshake with the same session bearer and
// origin headers; it also implements the WebSocketLike event surface the
// watcher expects.
export function createNodeKickWebSocketFactory(
  creds: PlatformCredentials,
  createSocket: (url: string, options: ClientOptions) => WebSocketLike = (url, options) =>
    new WebSocket(url, options) as unknown as WebSocketLike,
): WebSocketFactory {
  return (url) =>
    createSocket(url, {
      headers: { ...kickHeaders(url, undefined, creds), "User-Agent": CHROME_UA },
      handshakeTimeout: 10_000,
    });
}
