import initCycleTLS, { type CycleTLSClient, type CycleTLSWebSocketResponse } from "cycletls";
import type { PageFetcher } from "@stream-autopilot/core/adapter";
import { fetchTwitchInBackgroundWith, interpretKickResponse, kickBearerForUrl } from "@stream-autopilot/core/tabs";
import { KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import type { WebSocketFactory, WebSocketLike } from "@stream-autopilot/core/kick/watch";
import type { PlatformCredentials } from "../authStore";
import { createStoreCookieApi } from "./cookieApi";
import {
  CHROME_HTTP2,
  CHROME_JA3,
  CHROME_UA,
  disabledFetcher,
  hasHeader,
  headersToObject,
  tablessWatchPort,
  type EnabledPlatforms,
  type TransportHandle,
} from "./common";

type HttpMethod = "head" | "get" | "post" | "put" | "delete" | "trace" | "options" | "connect" | "patch";

// TLS-impersonating transport: routes Kick through cycletls so the request carries
// a real Chrome JA3/HTTP-2 fingerprint, which is what Cloudflare's WAF inspects —
// the same approach (curl_cffi impersonate) that comparable Node-less Kick miners
// use. This reaches Kick's API and viewer WebSocket without a browser. Twitch has
// no such WAF, so it uses the plain server-side fetch with stored credentials.
export async function createImpersonateTransport(credentials: PlatformCredentials, enabled: EnabledPlatforms): Promise<TransportHandle> {
  // cycletls spawns a Go subprocess; only start it when Kick is actually farmed.
  const cycleTLS = enabled.kick ? await initCycleTLS() : undefined;

  const cookieApi = createStoreCookieApi(credentials);
  const twitchFetcher: PageFetcher = {
    fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
  };

  const kick = cycleTLS
    ? new KickAdapter(createCycleKickFetcher(cycleTLS, credentials.kick?.sessionToken), {
        watchTabs: tablessWatchPort,
        createWebSocket: createCycleWebSocketFactory(cycleTLS),
      })
    : new KickAdapter(disabledFetcher("kick"), { watchTabs: tablessWatchPort });

  return {
    adapters: {
      twitch: new TwitchAdapter(twitchFetcher, { clientId: credentials.twitch?.clientId, watchTabs: tablessWatchPort }),
      kick,
    },
    dispose: async () => {
      if (cycleTLS) await cycleTLS.exit();
    },
  };
}

// Captures only the session token (not the whole credentials object) so the
// long-lived fetcher closure doesn't retain unrelated state.
export function createCycleKickFetcher(cycleTLS: CycleTLSClient, sessionToken: string | undefined): PageFetcher {
  return {
    fetchJson: async <T>(url: string, init?: RequestInit): Promise<T> => {
      const headers = browserHeaders(headersToObject(init?.headers));
      if (!hasHeader(headers, "authorization")) {
        const bearer = kickBearerForUrl(url, sessionToken);
        if (bearer) headers["Authorization"] = bearer;
      }

      const method = (init?.method ?? "GET").toLowerCase() as HttpMethod;
      const body = typeof init?.body === "string" ? init.body : undefined;
      const response = await cycleTLS(url, { ja3: CHROME_JA3, http2Fingerprint: CHROME_HTTP2, userAgent: CHROME_UA, headers, body }, method);

      // cycletls auto-parses a JSON body into an object; when it did, the response
      // *is* JSON regardless of whether (or how) the Content-Type header came back,
      // so don't let a missing/oddly-cased header make interpretKickResponse treat
      // a valid 200 as a WAF challenge.
      const parsedObject = response.data != null && typeof response.data === "object";
      const headerContentType = String(response.headers?.["Content-Type"] ?? response.headers?.["content-type"] ?? "");
      const contentType = parsedObject && !headerContentType.includes("application/json") ? "application/json" : headerContentType;
      const text = parsedObject ? JSON.stringify(response.data) : String(response.data ?? "");
      // Shared with the extension's fetch so WAF/challenge classification (incl. a
      // challenge that slips through with HTTP 200) can't drift between transports.
      return interpretKickResponse<T>(url, response.status, "", text, contentType);
    },
  };
}

// Adapts cycletls' async, callback-based socket to the browser-style WebSocketLike
// the KickWatcher drives. Connection happens lazily after construction; sends made
// before the socket opens are queued.
export function createCycleWebSocketFactory(cycleTLS: CycleTLSClient): WebSocketFactory {
  return (url: string) => new CycleWebSocket(cycleTLS, url);
}

class CycleWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  private socket?: CycleTLSWebSocketResponse;
  private closed = false;
  private queue: string[] = [];
  private readonly listeners: Record<string, Array<(event: unknown) => void>> = {
    open: [], message: [], close: [], error: [],
  };

  constructor(cycleTLS: CycleTLSClient, url: string) {
    cycleTLS
      .ws(url, {
        ja3: CHROME_JA3,
        http2Fingerprint: CHROME_HTTP2,
        userAgent: CHROME_UA,
        headers: { Origin: "https://kick.com", Referer: "https://kick.com/", "User-Agent": CHROME_UA },
      })
      .then((socket) => {
        // close() may have been called while the connection was still pending —
        // honor it instead of resurrecting a socket the caller already abandoned.
        if (this.closed) {
          void socket.close();
          return;
        }
        this.socket = socket;
        this.readyState = 1; // OPEN
        socket.onMessage((message) => {
          const data = typeof message.data === "string" ? message.data : message.data.toString();
          this.dispatch("message", { data });
        });
        socket.onClose(() => { this.readyState = 3; this.dispatch("close", {}); });
        socket.onError((error) => { if (!this.closed) this.dispatch("error", error); });
        for (const data of this.queue.splice(0)) void socket.send(data);
        this.dispatch("open", {});
      })
      .catch((error) => {
        this.readyState = 3;
        this.queue = [];
        if (!this.closed) this.dispatch("error", error);
      });
  }

  send(data: string): void {
    if (this.socket && this.readyState === 1) void this.socket.send(data);
    else if (!this.closed) this.queue.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.queue = [];
    if (this.socket) void this.socket.close();
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
    this.listeners[type].push(listener);
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

// Adds the browser-consistent headers the impersonated request should carry,
// without overriding anything the adapter already set.
function browserHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  if (!hasHeader(next, "user-agent")) next["User-Agent"] = CHROME_UA;
  if (!hasHeader(next, "origin")) next["Origin"] = "https://kick.com";
  if (!hasHeader(next, "referer")) next["Referer"] = "https://kick.com/";
  return next;
}
