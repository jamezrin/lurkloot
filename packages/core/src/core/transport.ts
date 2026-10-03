import type { TwitchIntegrity } from "./twitchIntegrity";
import { SafeFetchError, safeFetchFailure, type SafeFetchFailure } from "./fetchError";

// Cookie-backed background transports for Twitch GQL and Kick's API. They hold
// no tab state, so every host can use them: the extension binds them to
// chrome.cookies and the page-captured integrity token, the CLI to its auth
// store. Split out of core/tabs (#598) so tabless hosts never import tab code.

export interface CookieApi {
  cookies?: { get(details: { url: string; name: string }): Promise<{ value?: string } | null | undefined> };
}

// Twitch's GQL endpoint cannot be reached from the twitch.tv page's MAIN world:
// the cross-origin request is blocked by CORS / anti-tampering (observed as a
// status=0 "Failed to fetch", for both fetch and XHR). The extension background,
// however, has host permissions for gql.twitch.tv, so its fetch is not subject
// to page CORS — mirroring TwitchDropsMiner's plain HTTP client, which works
// with just Client-Id + Authorization + Client-Session-Id + X-Device-Id (no
// integrity token). We read auth-token / unique_id via chrome.cookies (these can
// be httpOnly) and attach them, exactly as the web client does.
//
// The integrity bundle and the self-generated session id come from an injected
// identity, so this module keeps no integrity state of its own: the extension
// passes the page-captured token, tabless hosts pass none.
export interface TwitchRequestIdentity {
  // The captured Client-Integrity bundle, only while it is still valid.
  integrity?(): TwitchIntegrity | undefined;
  clientSessionId(): string;
}

export function createTwitchRequestIdentity(integrity?: () => TwitchIntegrity | undefined): TwitchRequestIdentity {
  let clientSessionId: string | undefined;
  return {
    integrity,
    clientSessionId() {
      if (clientSessionId) return clientSessionId;
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      clientSessionId = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return clientSessionId;
    },
  };
}

// Hosts that never capture integrity share one session id per process, as before.
const defaultTwitchRequestIdentity = createTwitchRequestIdentity();

function twitchGqlErrorEnvelope(
  summary: string,
  status: number,
  body: string,
  headers: Headers,
): { __twitchGqlError: string; __twitchGqlFailureKind: "network" | "credentials" | "platform" } {
  return {
    __twitchGqlError: [
      `Twitch GQL ${summary}`,
      `status=${status}`,
      `authHeader=${headers.has("authorization") ? "yes" : "no"}`,
      `body=${body.slice(0, 300)}`,
    ].join("; "),
    __twitchGqlFailureKind: status === 0 ? "network" : status === 401 ? "credentials" : "platform",
  };
}

function isUsableTwitchGql(value: unknown): boolean {
  const entries = Array.isArray(value) ? value : [value];
  return entries.length > 0
    && entries.every((entry) => entry != null && typeof entry === "object" && !Array.isArray(entry));
}

export async function fetchTwitchInBackgroundWith<T>(
  api: CookieApi,
  url: string,
  init?: RequestInit,
  identity: TwitchRequestIdentity = defaultTwitchRequestIdentity,
): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const isGql = url.includes("gql.twitch.tv");
  // Public queries pass credentials: "omit" so Twitch treats them as anonymous.
  const anonymous = init?.credentials === "omit";
  if (isGql && !anonymous) {
    const cookie = async (name: string) => (await api.cookies?.get({ url: "https://www.twitch.tv", name }))?.value;
    const authToken = await cookie("auth-token");
    const deviceId = await cookie("unique_id");
    if (authToken && !headers.has("authorization")) headers.set("authorization", `OAuth ${authToken}`);
    // A captured Client-Integrity token is bound to the device id / session id it
    // was minted with, so when one is present (and unexpired) replay the whole
    // trio together; otherwise fall back to the cookie device id plus a
    // self-generated session id, which is enough for queries but not mutations.
    const integrity = identity.integrity?.();
    if (integrity && !headers.has("client-integrity")) headers.set("client-integrity", integrity.integrity);
    const effectiveDeviceId = integrity?.deviceId ?? deviceId;
    if (effectiveDeviceId && !headers.has("x-device-id")) headers.set("x-device-id", effectiveDeviceId);
    if (!headers.has("client-session-id")) {
      headers.set("client-session-id", integrity?.clientSessionId ?? identity.clientSessionId());
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: anonymous ? "omit" : "include" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    if (isGql) return twitchGqlErrorEnvelope(`request failed (${message})`, 0, "", headers) as T;
    throw error instanceof Error ? error : new Error(message);
  }

  const text = await response.text();
  if (!isGql) {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return ((response.headers.get("content-type") ?? "").includes("application/json")
      ? JSON.parse(text)
      : { html: text }) as T;
  }
  if (!response.ok) return twitchGqlErrorEnvelope(`HTTP ${response.status} ${response.statusText}`, response.status, text, headers) as T;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return twitchGqlErrorEnvelope("returned invalid JSON", response.status, text, headers) as T;
  }
  return (isUsableTwitchGql(json) ? json : twitchGqlErrorEnvelope("returned an unusable response", response.status, text, headers)) as T;
}

// Exact kick.com pathnames that require the session_token Bearer. Kept as a
// literal list (not a prefix match) mirrored into the pageFetchJson predicate
// below: /api/v1/user because Kick serves it anonymously as `200 {}` instead of
// a 401 (see KickAdapter.checkAuthHealth), and /api/v1/user/livestreams for the
// followed-live lookup, which instead answers anonymously with a clean 401 (no
// same ambiguity, but the Bearer is still required to identify the account).
const KICK_BEARER_PATHS = ["/api/v1/user", "/api/v1/user/livestreams"];

// Kick endpoints that replay the session_token cookie as a Bearer (mirrors the
// predicate inlined in pageFetchJson). kick.com/api/v2/* and /api/search are public
// and do not need it.
//
// Matched on the parsed host and pathname rather than by substring: `includes` would
// also attach the session token to hosts that merely mention a Kick host (e.g.
// https://evil.example/?r=web.kick.com) and to unintended subpaths of /api/v1/user.
//
// Exported so packages/cli/src/transport/cycle.ts shares this decision instead of
// reimplementing it (see #370): the CLI's WebSocket transport reaches
// websockets.kick.com over wss, not https, which this module's own callers never
// do, so the accepted protocols are parameterized rather than hardcoded here.
export function needsKickSessionBearer(url: string, options?: { protocols?: readonly string[] }): boolean {
  const protocols = options?.protocols ?? ["https:"];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!protocols.includes(parsed.protocol)) return false;
  if (parsed.host === "web.kick.com" || parsed.host === "websockets.kick.com") return true;
  return parsed.host === "kick.com" && KICK_BEARER_PATHS.includes(parsed.pathname);
}

// Distinguishes "Kick's WAF / origin check rejected the service-worker request"
// (fall back to the page-context tab) from a genuine error. Thrown by
// fetchKickInBackground so the adapter wrapper can log and fall back cleanly.
export class KickWafBlockedError extends SafeFetchError {
  constructor(candidate: string | SafeFetchFailure) {
    super(typeof candidate === "string"
      ? { kind: "network_error", reason: candidate }
      : candidate);
    this.name = "KickWafBlockedError";
  }
}

// Exported so headless transports outside the extension (e.g. the CLI's
// cycletls-backed Kick fetcher) classify Kick's HTTP failures the same way
// checkAuthHealth does, instead of guessing from the status code alone.
export function safeKickFailure(status: number, text: string): SafeFetchFailure {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON response bodies are never retained.
  }
  const reason = typeof body.error === "string"
    ? body.error
    : typeof body.message === "string"
      ? body.message
      : undefined;
  const blocked = /security policy|request blocked/i.test(reason ?? "");
  return safeFetchFailure({
    kind: blocked
      ? "security_policy_blocked"
      : status === 401 || status === 403
        ? "authentication_rejected"
        : "http_error",
    status,
    reason,
    reference: body.reference,
  });
}

// Spike: attempt a Kick API call straight from the service worker (no tab),
// mirroring pageFetchJson's auth/credentials so a success is equivalent. Kick's
// Cloudflare WAF may reject the chrome-extension:// origin; that surfaces as a
// KickWafBlockedError for the caller to fall back on. Only the real extension SW
// can answer whether this works — the Playwright harness cannot (its request
// stack is WAF-blocked for unrelated reasons).
export async function fetchKickInBackgroundWith<T>(api: CookieApi, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (needsKickSessionBearer(url) && !headers.has("authorization")) {
    const sessionToken = (await api.cookies?.get({ url: "https://kick.com", name: "session_token" }))?.value;
    if (sessionToken) headers.set("authorization", `Bearer ${decodeURIComponent(sessionToken)}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "include" });
  } catch (error) {
    // A network/CORS rejection from the extension origin is exactly the
    // origin-level failure we want to fall back on, not a hard error.
    throw new KickWafBlockedError({
      kind: "network_error",
      reason: error instanceof Error ? error.message : "network error",
    });
  }

  const text = await response.text();
  if (!response.ok) {
    const failure = safeKickFailure(response.status, text);
    throw failure.kind === "security_policy_blocked"
      ? new KickWafBlockedError(failure)
      : new SafeFetchError(failure);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KickWafBlockedError("service worker got a non-JSON body (likely a challenge page)");
    }
  }
  // Non-API kick.com pages (e.g. a channel page) legitimately return HTML; API
  // endpoints returning non-JSON means a challenge interstitial slipped a 200, so
  // treat that as blocked and let the caller use the page tab.
  if (url.includes("/api/") || url.includes("websockets.kick.com")) {
    throw new KickWafBlockedError("service worker got a non-JSON API response (likely a challenge page)");
  }
  return { html: text } as T;
}
