import initCycleTLS, { type CycleTLSClient, type CycleTLSWebSocketResponse } from "cycletls";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import type { PageFetcher } from "@lurkloot/core/adapter";
import type { WebSocketFactory, WebSocketLike } from "@lurkloot/core/kick/watch";
import type { PlatformCredentials } from "../authStore";
import { CHROME_HTTP2, CHROME_JA3, CHROME_UA, hasHeader, headersToObject } from "./common";

export type { CycleTLSClient } from "cycletls";

// Hosts whose endpoints replay the session_token cookie as a Bearer (mirrors the
// engine's KICK_AUTH_HOSTS); kick.com/api/v2/* is public and needs no auth.
const KICK_AUTH_HOSTS = ["web.kick.com", "websockets.kick.com"];

export function initCycle(): Promise<CycleTLSClient> {
  return initCycleTLS();
}

export function kickHeaders(url: string, init: RequestInit | undefined, creds: PlatformCredentials): Record<string, string> {
  const headers = headersToObject(init?.headers);
  headers.Origin ??= "https://kick.com";
  headers.Referer ??= "https://kick.com/";
  const sessionToken = creds.kick?.sessionToken;
  if (sessionToken && KICK_AUTH_HOSTS.some((host) => url.includes(host)) && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${decodeURIComponent(sessionToken)}`;
  }
  return headers;
}

// cycletls-backed Kick PageFetcher: carries a Chrome JA3/HTTP-2 fingerprint past
// Cloudflare's WAF (pure-Node fetch 403s). Shared by the impersonate and browser
// transports, which both reach Kick this way.
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

      if (response.status === 403) {
        throw new KickWafBlockedError(`HTTP 403 from ${new URL(url).host} (Cloudflare blocked the impersonated request)`);
      }
      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
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
  private readonly listeners: Record<string, Array<(event: unknown) => void>> = {
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

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void {
    this.listeners[type].push(listener);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}
