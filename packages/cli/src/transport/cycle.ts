import initCycleTLS, { type CycleTLSClient, type CycleTLSWebSocketResponse } from "cycletls";
import { KickWafBlockedError, needsKickSessionBearer, safeKickFailure } from "@lurkloot/core/tabs";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import type { PageFetcher } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike, WebSocketMessageEventLike } from "@lurkloot/core/webSocket";
import type { PlatformCredentials } from "../authStore";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA, hasHeader, headersToObject } from "./common";

export type { CycleTLSClient } from "cycletls";

// wss:, not just https:, because the viewer WebSocket (websockets.kick.com)
// goes through this same header builder — see createCycleKickWebSocketFactory.
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
// authenticate/<uuid>). Two Kick defences sit in front of it, both cleared here:
//   1. Cloudflare's WAF — handled by the Chrome JA3/HTTP-2 fingerprint (a plain
//      fetch 403s with "Request blocked by security policy.").
//   2. Laravel CSRF — the POST needs an X-XSRF-TOKEN matching the session, so we
//      first warm up cookies via /sanctum/csrf-cookie and replay them.
// Returns the token only once the user has approved the link; before that Kick
// answers 403 "Invalid setup UUID and Key" (token-less), which we surface as "no
// token yet" so the caller keeps polling rather than treating it as a failure.
const CSRF_COOKIE_URL = "https://kick.com/sanctum/csrf-cookie";
const TV_LINK_AUTHENTICATE = "https://kick.com/api/tv/link/authenticate";

interface CsrfSession {
  cookieHeader: string;
  xsrfToken: string;
}

export function createTvLinkAuthenticator(cycleTLS: CycleTLSClient): (uuid: string, code: string) => Promise<{ token?: string }> {
  let session: CsrfSession | undefined;
  const warmUp = async (): Promise<CsrfSession> => {
    if (session) return session;
    const response = await cycleTLS(CSRF_COOKIE_URL, {
      ja3: CHROME_JA3,
      http2Fingerprint: CHROME_HTTP2,
      userAgent: CHROME_UA,
      headers: { accept: "*/*", Origin: "https://kick.com", Referer: "https://kick.com/" },
    }, "get");
    const cookies = setCookiePairs(response.headers);
    const xsrfPair = cookies.find((c) => c.startsWith("XSRF-TOKEN="));
    if (!xsrfPair) throw new Error("Kick did not issue an XSRF-TOKEN cookie during device-login warm-up");
    session = { cookieHeader: cookies.join("; "), xsrfToken: decodeURIComponent(xsrfPair.slice("XSRF-TOKEN=".length)) };
    return session;
  };

  return async (uuid: string, code: string) => {
    const { cookieHeader, xsrfToken } = await warmUp();
    const response = await cycleTLS(`${TV_LINK_AUTHENTICATE}/${encodeURIComponent(uuid)}`, {
      ja3: CHROME_JA3,
      http2Fingerprint: CHROME_HTTP2,
      userAgent: CHROME_UA,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Origin: "https://kick.com",
        Referer: "https://kick.com/",
        Cookie: cookieHeader,
        "X-XSRF-TOKEN": xsrfToken,
      },
      body: JSON.stringify({ key: code }),
    }, "post");
    const data = response.data;
    const parsed = typeof data === "string" ? safeJsonParse(data) : data;
    const token = parsed && typeof parsed === "object" ? (parsed as { token?: string }).token : undefined;
    return { token: typeof token === "string" && token ? token : undefined };
  };
}

// Extracts `name=value` cookie pairs from a cycletls response's Set-Cookie header
// (which may arrive as a single string or an array, under either casing).
function setCookiePairs(headers: Record<string, unknown> | undefined): string[] {
  const raw = headers?.["Set-Cookie"] ?? headers?.["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw != null ? [String(raw)] : [];
  return list.map((cookie) => String(cookie).split(";")[0]).filter(Boolean);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createCycleKickWebSocketFactory(cycleTLS: CycleTLSClient, creds: PlatformCredentials): WebSocketFactory {
  return (url: string) => new CycleWebSocket(cycleTLS, url, kickHeaders(url, undefined, creds));
}

// Adapts cycletls's async ws() into the engine's synchronous WebSocketLike: the
// factory returns immediately while the impersonated handshake completes in the
// background; sends before "open" are queued and flushed on connect.
class CycleWebSocket implements WebSocketLike {
  // Mirrors the DOM WebSocket readyState constants the watcher reads.
  readyState = 0; // CONNECTING
  private socket?: CycleTLSWebSocketResponse;
  private readonly sendQueue: string[] = [];
  private readonly listeners: Record<string, Array<(event: WebSocketMessageEventLike) => void>> = {
    open: [], message: [], close: [], error: [],
  };

  constructor(cycleTLS: CycleTLSClient, url: string, headers: Record<string, string>) {
    cycleTLS.ws(url, { ja3: CHROME_JA3, http2Fingerprint: CHROME_HTTP2, userAgent: CHROME_UA, headers })
      .then((socket) => {
        this.socket = socket;
        this.readyState = 1; // OPEN
        socket.onMessage((message) => {
          const data = typeof message.data === "string" ? message.data : message.data.toString();
          this.emit("message", { data });
        });
        socket.onClose((code, reason) => { this.readyState = 3; this.emit("close", { code, reason }); });
        socket.onError((error) => this.emit("error", error));
        for (const data of this.sendQueue.splice(0)) void socket.send(data);
        this.emit("open", {});
      })
      .catch((error) => { this.readyState = 3; this.emit("error", error); });
  }

  send(data: string): void {
    if (this.socket) void this.socket.send(data);
    else this.sendQueue.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    if (this.socket) void this.socket.close();
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: WebSocketMessageEventLike) => void): void {
    this.listeners[type].push(listener);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event as WebSocketMessageEventLike);
  }
}
