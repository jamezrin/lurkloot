import initCycleTLS, { type CycleTLSClient, type CycleTLSWebSocketResponse } from "cycletls";
import type { PageFetcher } from "@stream-autopilot/core/adapter";
import { fetchTwitchInBackgroundWith, KickWafBlockedError } from "@stream-autopilot/core/tabs";
import { KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import type { WebSocketFactory, WebSocketLike } from "@stream-autopilot/core/kick/watch";
import type { PlatformCredentials } from "../authStore";
import { createStoreCookieApi } from "./cookieApi";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA, hasHeader, headersToObject, tablessWatchPort, type TransportHandle } from "./common";

const KICK_AUTH_HOSTS = ["web.kick.com", "websockets.kick.com"];
const HTTP_METHODS = ["head", "get", "post", "put", "delete", "trace", "options", "connect", "patch"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// TLS-impersonating transport: routes Kick through cycletls so the request carries
// a real Chrome JA3/HTTP-2 fingerprint, which is what Cloudflare's WAF inspects —
// the same approach (curl_cffi impersonate) that comparable Node-less Kick miners
// use. This reaches Kick's API and viewer WebSocket without a browser. Twitch has
// no such WAF, so it uses the plain server-side fetch with stored credentials.
export async function createImpersonateTransport(credentials: PlatformCredentials): Promise<TransportHandle> {
  const cycleTLS = await initCycleTLS();

  const kickFetcher = createCycleKickFetcher(cycleTLS, credentials);
  const kickWebSocket = createCycleWebSocketFactory(cycleTLS);

  const cookieApi = createStoreCookieApi(credentials);
  const twitchFetcher: PageFetcher = {
    fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init),
  };

  return {
    adapters: {
      twitch: new TwitchAdapter(twitchFetcher, { clientId: credentials.twitch?.clientId, watchTabs: tablessWatchPort }),
      kick: new KickAdapter(kickFetcher, { watchTabs: tablessWatchPort, createWebSocket: kickWebSocket }),
    },
    dispose: async () => {
      await cycleTLS.exit();
    },
  };
}

function createCycleKickFetcher(cycleTLS: CycleTLSClient, credentials: PlatformCredentials): PageFetcher {
  return {
    fetchJson: async <T>(url: string, init?: RequestInit): Promise<T> => {
      const headers = browserHeaders(headersToObject(init?.headers));
      if (KICK_AUTH_HOSTS.some((host) => url.includes(host)) && !hasHeader(headers, "authorization")) {
        const token = credentials.kick?.sessionToken;
        if (token) headers["Authorization"] = `Bearer ${decodeURIComponent(token)}`;
      }

      const method = (init?.method ?? "GET").toLowerCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      const response = await cycleTLS(
        url,
        { ja3: CHROME_JA3, http2Fingerprint: CHROME_HTTP2, userAgent: CHROME_UA, headers, body },
        (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : "get",
      );

      if (response.status === 403) {
        throw new KickWafBlockedError(`Kick WAF rejected the impersonated request (HTTP 403) for ${safeHost(url)}`);
      }
      if (response.status >= 400) {
        throw new Error(`Kick HTTP ${response.status} for ${safeHost(url)}`);
      }
      return parseBody<T>(response.data, String(response.headers?.["Content-Type"] ?? response.headers?.["content-type"] ?? ""));
    },
  };
}

// Adapts cycletls' async, callback-based socket to the browser-style WebSocketLike
// the KickWatcher drives. Connection happens lazily after construction; sends made
// before the socket opens are queued.
function createCycleWebSocketFactory(cycleTLS: CycleTLSClient): WebSocketFactory {
  return (url: string) => new CycleWebSocket(cycleTLS, url);
}

class CycleWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  private socket?: CycleTLSWebSocketResponse;
  private readonly queue: string[] = [];
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
        this.socket = socket;
        this.readyState = 1; // OPEN
        socket.onMessage((message) => {
          const data = typeof message.data === "string" ? message.data : message.data.toString();
          this.dispatch("message", { data });
        });
        socket.onClose(() => { this.readyState = 3; this.dispatch("close", {}); });
        socket.onError((error) => this.dispatch("error", error));
        for (const data of this.queue.splice(0)) void socket.send(data);
        this.dispatch("open", {});
      })
      .catch((error) => { this.readyState = 3; this.dispatch("error", error); });
  }

  send(data: string): void {
    if (this.socket && this.readyState === 1) void this.socket.send(data);
    else this.queue.push(data);
  }

  close(): void {
    this.readyState = 3;
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

function parseBody<T>(data: unknown, contentType: string): T {
  if (typeof data !== "string") return data as T;
  if (contentType.includes("application/json")) return JSON.parse(data) as T;
  try {
    return JSON.parse(data) as T;
  } catch {
    return { html: data } as T;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
