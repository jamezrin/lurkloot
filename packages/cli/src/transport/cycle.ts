import initCycleTLS, { type CycleTLSClient } from "cycletls";
import WebSocket, { type ClientOptions } from "ws";
import { KickWafBlockedError, needsKickSessionBearer, safeKickFailure } from "@lurkloot/core/transport";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import type { PageFetcher } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/webSocket";
import type { PlatformCredentials } from "../authStore";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA, hasHeader, headersToObject } from "./common";

export type { CycleTLSClient } from "cycletls";

// wss:, not just https:, because the viewer WebSocket (websockets.kick.com)
// goes through this same header builder — see createNodeKickWebSocketFactory.
// This is the only Kick transport that needs the widened protocol set: the
// engine's own callers of needsKickSessionBearer never reach wss.
const KICK_BEARER_PROTOCOLS = ["https:", "wss:"];

export function initCycle(): Promise<CycleTLSClient> {
  return initCycleTLS();
}

export function kickHeaders(url: string, init: RequestInit | undefined, creds: PlatformCredentials): Record<string, string> {
  const headers = headersToObject(init?.headers);
  headers.Origin ??= "https://kick.com";
  headers.Referer ??= "https://kick.com/";
  const sessionToken = creds.kick?.sessionToken;
  if (sessionToken && needsKickSessionBearer(url, { protocols: KICK_BEARER_PROTOCOLS }) && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${decodeURIComponent(sessionToken)}`;
  }
  return headers;
}

// cycletls-backed Kick PageFetcher: carries a Chrome JA3/HTTP-2 fingerprint past
// Cloudflare's WAF (pure-Node fetch 403s). Shared by the impersonate and browser
// transports, which both reach Kick this way. CycleTLS 2.x has no per-request
// cancellation primitive: its only interruption API is process-wide exit(),
// which would terminate sibling requests and the shared transport. The
// controller deadline therefore bounds the caller while an aborted host request
// finishes in CycleTLS.
export function createCycleKickFetcher(cycleTLS: CycleTLSClient, creds: PlatformCredentials): PageFetcher {
  return {
    async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
      const method = (init?.method ?? "GET").toLowerCase() as "get" | "post";
      const response = await cycleTLS(url, {
        ja3: CHROME_JA3,
        http2Fingerprint: CHROME_HTTP2,
        userAgent: CHROME_UA,
        headers: kickHeaders(url, init, creds),
        body: typeof init?.body === "string" ? init.body : undefined,
      }, method);

      if (response.status >= 400) {
        // Mirrors fetchKickInBackgroundWith's classification so checkAuthHealth sees the
        // same failure kinds (WAF challenge vs. rejected credentials) over this transport
        // as it does over the extension's page-context fetcher. safeKickFailure only
        // recognizes Cloudflare's block by matching Kick's JSON error envelope; against
        // this impersonated session a 401/403 is just as likely to come back as an HTML
        // challenge page (see tabs.ts's own "likely a challenge page" handling), which
        // would otherwise silently fall through to "authentication_rejected" and could
        // suspend farming on what was actually a WAF block, not a bad session token.
        const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
        const isJsonBody = (typeof response.data === "object" && response.data !== null) || safeJsonParse(text) !== undefined;
        if (!isJsonBody && (response.status === 401 || response.status === 403)) {
          throw new KickWafBlockedError(`HTTP ${response.status} from ${new URL(url).host} — non-JSON body (likely a Cloudflare challenge page)`);
        }
        const failure = safeKickFailure(response.status, text);
        throw failure.kind === "security_policy_blocked"
          ? new KickWafBlockedError(failure)
          : new SafeFetchError(failure);
      }

      const data = response.data;
      if (data != null && typeof data === "object") return data as T;
      // Non-JSON (e.g. a channel page) — return the same { html } shape the
      // engine's page fetcher produces so the Kick adapter's HTML fallbacks work.
      if (typeof data === "string") {
        try {
          return JSON.parse(data) as T;
        } catch {
          return { html: data } as T;
        }
      }
      return { html: "" } as T;
    },
  };
}

// The TV-link device-login authenticate endpoint (kick.com/api/tv/link/
// authenticate/<uuid>) sits behind Cloudflare's WAF, handled by the Chrome
// JA3/HTTP-2 fingerprint. Kick no longer issues an XSRF-TOKEN from its
// /sanctum/csrf-cookie endpoint, and this TV endpoint accepts the POST without
// that cookie.
// Returns the token only once the user has approved the link; before that Kick
// answers 403 "Invalid setup UUID and Key" (token-less), which we surface as "no
// token yet" so the caller keeps polling rather than treating it as a failure.
const TV_LINK_AUTHENTICATE = "https://kick.com/api/tv/link/authenticate";

export function createTvLinkAuthenticator(cycleTLS: CycleTLSClient): (uuid: string, code: string) => Promise<{ token?: string }> {
  return async (uuid: string, code: string) => {
    const response = await cycleTLS(`${TV_LINK_AUTHENTICATE}/${encodeURIComponent(uuid)}`, {
      ja3: CHROME_JA3,
      http2Fingerprint: CHROME_HTTP2,
      userAgent: CHROME_UA,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Origin: "https://kick.com",
        Referer: "https://kick.com/",
      },
      body: JSON.stringify({ key: code }),
    }, "post");
    const data = response.data;
    const parsed = typeof data === "string" ? safeJsonParse(data) : data;
    const token = parsed && typeof parsed === "object" ? (parsed as { token?: string }).token : undefined;
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

// CycleTLS's ws() currently enters its generic request path and never resolves
// a live viewer connection. The Node WebSocket client completes Kick's handshake
// with the same session bearer and origin headers; it also implements the
// WebSocketLike event surface the watcher expects.
export function createNodeKickWebSocketFactory(
  creds: PlatformCredentials,
  createSocket: (url: string, options: ClientOptions) => WebSocketLike = (url, options) =>
    new WebSocket(url, options) as unknown as WebSocketLike,
): WebSocketFactory {
  return (url) => createSocket(url, {
    headers: { ...kickHeaders(url, undefined, creds), "User-Agent": CHROME_UA },
    handshakeTimeout: 10_000,
  });
}
