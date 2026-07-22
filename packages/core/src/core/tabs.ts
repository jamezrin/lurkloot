import type { AdFocusMode, ChannelCandidate, ManagedPageContextTab, ManagedWatchTab, Platform, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason, PageContextOpenReason } from "@lurkloot/shared/events";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TwitchIntegrity } from "./twitchIntegrity";
import type { PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";
import { SafeFetchError, safeFetchFailure, type SafeFetchFailure } from "./fetchError";

const ignoreEvent: EventEmitter = () => {};

function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform?: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}

export interface BrowserTabApi {
  tabs: {
    get(tabId: number): Promise<BrowserTab | undefined>;
    update(tabId: number, properties: Record<string, unknown>): Promise<unknown>;
    remove?(tabId: number): Promise<void>;
    query(queryInfo: Record<string, unknown>): Promise<BrowserTab[]>;
    create(createProperties: Record<string, unknown>): Promise<{ id?: number } | void>;
    executeScript?: (tabId: number, details: { code: string }) => Promise<unknown[] | undefined>;
  };
  scripting?: {
    executeScript?: (details: unknown) => Promise<Array<{ result?: unknown }>>;
  };
  windows?: {
    update(windowId: number, properties: Record<string, unknown>): Promise<unknown>;
  };
}

interface BrowserTab {
  id?: number;
  url?: string;
  pinned?: boolean;
  active?: boolean;
  status?: string;
  windowId?: number;
  mutedInfo?: { muted?: boolean };
}

interface PageContextTab {
  tabId: number;
  createdByExtension: boolean;
  retainedContext?: ManagedPageContextTab;
}

interface PageContextEntry {
  promise: Promise<PageContextTab>;
  refs: number;
}

const pageContextTabs = new Map<string, PageContextEntry>();
const retainedPageContextTabs = new Map<Platform, ManagedPageContextTab>();
const DEFAULT_WATCH_TAB_OPTIONS: WatchTabOptions = {
  muted: true,
  closeManagedTabs: true,
  keepVideosUnmuted: true,
};
const PLAYBACK_PRIME_RESTORE_DELAY_MS = 1500;
const PAGE_CONTEXT_RECOVERY_SUCCESSES = 3;
const PAGE_CONTEXT_RECOVERY_MIN_MS = 10 * 60_000;

export async function openPinnedMutedTabWithBrowser(
  browserApi: BrowserTabApi,
  channel: ChannelCandidate,
  session?: WatchSession,
  options?: Partial<WatchTabOptions>,
  emit: EventEmitter = ignoreEvent,
): Promise<PreparedWatchTab> {
  const tabOptions = { ...DEFAULT_WATCH_TAB_OPTIONS, ...options };
  const registered = tabOptions.managedTab ?? managedTabFromSession(session, channel.url);

  if (registered) {
    try {
      const tab = await browserApi.tabs.get(registered.tabId);
      if (tab?.id) {
        const updateProperties = watchTabUpdateProperties(tab, channel.url, tabOptions.muted);
        if (Object.keys(updateProperties).length > 0) {
          await browserApi.tabs.update(tab.id, updateProperties);
        }
        if (tabOptions.keepVideosUnmuted && shouldPrimePlayback(tab, channel.url, session)) {
          await primeTabPlayback(browserApi, tab.id, channel.platform, emit);
        }
        diagnostic(emit, "debug", `Reusing managed watch tab ${tab.id} for ${channel.username}`, channel.platform);
        return {
          tabId: tab.id,
          managedByExtension: true,
          managedTab: managedTab(channel, tab.id),
        };
      }
    } catch {
      // The registered managed tab can go stale after browser restarts or manual tab closure.
      diagnostic(emit, "debug", `Managed watch tab ${registered.tabId} is gone; opening a new one`, channel.platform);
    }
  } else if (session?.tabId && session.tabManagedByExtension === false) {
    try {
      const tab = await browserApi.tabs.get(session.tabId);
      if (tab?.id) {
        const updateProperties = watchTabUpdateProperties(tab, channel.url, tabOptions.muted);
        if (Object.keys(updateProperties).length > 0) {
          await browserApi.tabs.update(tab.id, updateProperties);
        }
        if (tabOptions.keepVideosUnmuted && shouldPrimePlayback(tab, channel.url, session)) {
          await primeTabPlayback(browserApi, tab.id, channel.platform, emit);
        }
        diagnostic(emit, "debug", `Reusing your tab ${tab.id} for ${channel.username}`, channel.platform);
        return { tabId: tab.id, managedByExtension: false };
      }
    } catch {
      // Reused user tabs are best-effort only; if missing, create a managed tab.
      diagnostic(emit, "debug", `Reused tab ${session.tabId} is gone; opening a managed one`, channel.platform);
    }
  }

  const extraManagedTabIds = new Set<number>();
  if (registered?.tabId != null) extraManagedTabIds.add(registered.tabId);
  if (session?.tabManagedByExtension && session.tabId != null) extraManagedTabIds.add(session.tabId);
  for (const tabId of extraManagedTabIds) {
    if (!browserApi.tabs.remove) continue;
    try {
      await browserApi.tabs.remove(tabId);
      diagnostic(emit, "debug", `Removed stale watch tab ${tabId}`, channel.platform);
    } catch {
      // Stale managed tab ids should not block creating the replacement.
    }
  }

  const tab = await browserApi.tabs.create({
    url: channel.url,
    pinned: true,
    active: false,
  }) as { id?: number };
  if (tab.id == null) {
    diagnostic(emit, "error", `Could not create ${channel.platform} watch tab for ${channel.username}`, channel.platform);
    throw new Error(`Could not create ${channel.platform} watch tab`);
  }
  await browserApi.tabs.update(tab.id, { pinned: true, muted: tabOptions.muted, active: false });
  if (tabOptions.keepVideosUnmuted) {
    await primeTabPlayback(browserApi, tab.id, channel.platform, emit);
  }
  diagnostic(emit, "info", `Opened watch tab ${tab.id} for ${channel.username}`, channel.platform);
  return { tabId: tab.id, managedByExtension: true, managedTab: managedTab(channel, tab.id) };
}

function watchTabUpdateProperties(tab: BrowserTab, url: string, muted: boolean): Record<string, unknown> {
  const updateProperties: Record<string, unknown> = {};
  if (tab.url !== url) updateProperties.url = url;
  if (tab.pinned !== true) updateProperties.pinned = true;
  if (tab.mutedInfo?.muted !== muted) updateProperties.muted = muted;
  if (tab.active !== false) updateProperties.active = false;
  return updateProperties;
}

function shouldPrimePlayback(tab: BrowserTab, url: string, session?: WatchSession): boolean {
  if (tab.url !== url) return true;
  const playback = session?.playback;
  if (!playback) return true;
  const checkedAt = Date.parse(playback.checkedAt);
  if (!Number.isNaN(checkedAt) && Date.now() - checkedAt > 2 * 60 * 1000) return true;
  // Priming foreground-activates the tab to coax a deferred player into loading
  // and playing — not to unmute. A muted-but-playing video is fine, so do not
  // re-prime just because the browser kept it muted.
  return playback.videoCount === 0
    || playback.playingVideoCount === 0;
}

async function primeTabPlayback(browserApi: BrowserTabApi, tabId: number, platform: Platform | undefined, emit: EventEmitter): Promise<void> {
  const [previousActive] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const previousActiveId = previousActive?.id;

  diagnostic(emit, "debug", `Priming playback on watch tab ${tabId}`, platform);
  await browserApi.tabs.update(tabId, { active: true });
  await wait(playbackPrimeRestoreDelayMs());

  if (previousActiveId != null && previousActiveId !== tabId) {
    await browserApi.tabs.update(previousActiveId, { active: true });
  }
}

function playbackPrimeRestoreDelayMs(): number {
  return typeof process !== "undefined" && process.env.NODE_ENV === "test"
    ? 0
    : PLAYBACK_PRIME_RESTORE_DELAY_MS;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function managedTabFromSession(session: WatchSession | undefined, channelUrl: string): ManagedWatchTab | undefined {
  if (!session?.tabId || !session.tabManagedByExtension) return undefined;
  return {
    platform: session.platform,
    tabId: session.tabId,
    channelUrl,
    ownedByExtension: true,
  };
}

function managedTab(channel: ChannelCandidate, tabId: number): ManagedWatchTab {
  return {
    platform: channel.platform,
    tabId,
    channelUrl: channel.url,
    ownedByExtension: true,
  };
}

export async function stopWatchTabWithBrowser(browserApi: BrowserTabApi, session: WatchSession, options?: Partial<WatchTabOptions>, emit: EventEmitter = ignoreEvent): Promise<void> {
  const tabOptions = { ...DEFAULT_WATCH_TAB_OPTIONS, ...options };
  if (!session.tabId) return;
  try {
    if (session.tabManagedByExtension && tabOptions.closeManagedTabs && browserApi.tabs.remove) {
      await browserApi.tabs.remove(session.tabId);
      diagnostic(emit, "debug", `Closed managed watch tab ${session.tabId}`, session.platform);
      return;
    }
    await browserApi.tabs.update(session.tabId, {
      muted: false,
      pinned: false,
      active: false,
    });
    diagnostic(emit, "debug", `Released your tab ${session.tabId} (unmuted, unpinned)`, session.platform);
  } catch {
    // The user may have closed the tab already.
    diagnostic(emit, "debug", `Watch tab ${session.tabId} was already closed`, session.platform);
  }
}

// While an ad is rolling, the managed watch tab must be the active tab in a
// focused window or the browser throttles the ad countdown's requestAnimationFrame
// loop (the visibility keep-alive only fools page JS, not the rAF engine). We
// bring the tab to focus for the duration of the ad and restore the user's
// previous tab/window once every platform's ad has finished. Holds are tracked
// per platform so two simultaneous ads don't restore focus prematurely.
const adFocusHolds = new Set<Platform>();
let previousFocus: { tabId?: number; windowId?: number } | undefined;

export async function applyAdFocusWithBrowser(
  browserApi: BrowserTabApi,
  platform: Platform,
  tabId: number | undefined,
  adActive: boolean,
  mode: AdFocusMode,
  emit: EventEmitter = ignoreEvent,
): Promise<void> {
  if (mode === "none" || !adActive || tabId == null) {
    await releaseAdFocus(browserApi, platform, tabId, emit);
    return;
  }

  if (adFocusHolds.size === 0) {
    const [active] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== tabId) {
      previousFocus = { tabId: active?.id, windowId: active?.windowId };
    }
  }
  const alreadyHeld = adFocusHolds.has(platform);
  adFocusHolds.add(platform);

  const tab = await browserApi.tabs.get(tabId).catch(() => undefined);
  await browserApi.tabs.update(tabId, { active: true });
  if (mode === "window" && tab?.windowId != null) {
    await browserApi.windows?.update(tab.windowId, { focused: true });
  }
  if (!alreadyHeld) {
    diagnostic(emit, "debug", `Focusing watch tab ${tabId} for an ad`, platform);
  }
}

async function releaseAdFocus(browserApi: BrowserTabApi, platform: Platform, watchTabId: number | undefined, emit: EventEmitter): Promise<void> {
  if (!adFocusHolds.delete(platform) || adFocusHolds.size > 0) return;

  const restore = previousFocus;
  previousFocus = undefined;
  if (!restore?.tabId) return;

  // Only restore if the watch tab is still the active tab; otherwise the user
  // has already moved on and we should not yank focus back.
  if (watchTabId != null) {
    const [active] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== watchTabId) return;
  }

  diagnostic(emit, "debug", `Restoring previous tab ${restore.tabId} after the ad`, platform);
  await browserApi.tabs.update(restore.tabId, { active: true }).catch(() => undefined);
  if (restore.windowId != null) {
    await browserApi.windows?.update(restore.windowId, { focused: true }).catch(() => undefined);
  }
}

export interface PageFetchOptions {
  retainPageContext?: {
    platform: Platform;
    managedContext?: ManagedPageContextTab;
  };
  emit?: EventEmitter;
  openReason?: PageContextOpenReason;
}

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
let twitchClientSessionId: string | undefined;

// The most recently captured Client-Integrity bundle from the live twitch.tv
// page (see src/core/twitchIntegrity.ts). The background registers a webRequest
// listener that feeds this via setTwitchIntegrity so authenticated GQL mutations
// (e.g. drop claims) carry a valid integrity token. Defaults to undefined so
// queries keep working anonymously / without integrity until one is captured.
let twitchIntegrity: TwitchIntegrity | undefined;

// Treat a token expiring within this window as already stale, so a claim never
// ships with one that expires mid-flight (the captured token is replayed and
// the round-trip plus Twitch-side clock skew can otherwise straddle expiry).
const INTEGRITY_EXPIRY_SKEW_MS = 30_000;

// Page context to open when no token has been captured: a logged-in twitch.tv
// SPA route that immediately issues authenticated GQL carrying Client-Integrity,
// which the background webRequest listener captures (see entrypoints/background.ts).
export const TWITCH_PAGE_CONTEXT_URL = "https://www.twitch.tv/drops/inventory";

// How long to wait for the live page to mint and send a token after we open it.
const INTEGRITY_REFRESH_TIMEOUT_MS = 12_000;

// Resolvers waiting for the next captured token (see waitForIntegrityCapture).
let integrityWaiters: Array<() => void> = [];

export function hasValidTwitchIntegrity(now: number = Date.now()): boolean {
  return twitchIntegrity != null && twitchIntegrity.expiresAt > now + INTEGRITY_EXPIRY_SKEW_MS;
}

export function setTwitchIntegrity(value: TwitchIntegrity | undefined, options?: { isNew?: boolean }, emit: EventEmitter = ignoreEvent): void {
  twitchIntegrity = value;
  if (value && options?.isNew) {
    const ttlSeconds = Math.max(0, Math.round((value.expiresAt - Date.now()) / 1000));
    diagnostic(emit, "info", `Captured a fresh Twitch integrity token (expires ${new Date(value.expiresAt).toISOString()}, in ${ttlSeconds}s)`, "twitch");
  }
  if (value != null && integrityWaiters.length > 0) {
    const waiters = integrityWaiters;
    integrityWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

// Resolves true once a valid token is present, or after timeoutMs (re-checking
// validity at the deadline). A captured token can be near-expiry — captureTwitch-
// Integrity does not gate on expiry — so resolvers re-check hasValidTwitchIntegrity.
function waitForIntegrityCapture(timeoutMs: number): Promise<boolean> {
  if (hasValidTwitchIntegrity()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hasValidTwitchIntegrity());
    };
    const timer = setTimeout(finish, timeoutMs);
    integrityWaiters.push(finish);
  });
}

// Ensures a valid Client-Integrity token exists before an authenticated mutation
// (drop claims). When none is captured — e.g. tabless farming with no twitch.tv
// tab open — opens or reuses a logged-in twitch.tv page-context tab so the SPA
// mints one the webRequest listener captures, waits for it, then releases the tab.
export async function ensureTwitchIntegrityWithBrowser(
  browserApi: BrowserTabApi,
  originUrl: string,
  timeoutMs: number = INTEGRITY_REFRESH_TIMEOUT_MS,
  emit: EventEmitter = ignoreEvent,
): Promise<boolean> {
  if (hasValidTwitchIntegrity()) return true;

  diagnostic(emit, "info", "No valid Twitch integrity token; opening a twitch.tv tab to capture one", "twitch");
  const origin = new URL(originUrl).origin;
  let pageContext: PageContextTab | undefined;
  try {
    pageContext = await acquirePageContextTab(browserApi, originUrl, origin, {
      retainPageContext: { platform: "twitch" },
    });
    // On success the capture itself is logged once by setTwitchIntegrity (info);
    // here we only surface the failure case so the log isn't doubled up.
    const captured = await waitForIntegrityCapture(timeoutMs);
    if (!captured) {
      diagnostic(emit, "warn", `Timed out waiting for a Twitch integrity token after ${timeoutMs}ms (is twitch.tv logged in?)`, "twitch");
    }
    return captured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(emit, "warn", `Could not open a twitch.tv tab to capture an integrity token: ${message}`, "twitch");
    return false;
  } finally {
    if (pageContext) await releasePageContextTab(browserApi, origin, pageContext);
  }
}

function twitchClientSessionIdValue(): string {
  if (twitchClientSessionId) return twitchClientSessionId;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  twitchClientSessionId = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return twitchClientSessionId;
}

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
  const entry = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  return entry != null && typeof entry === "object" && !Array.isArray(entry);
}

export async function fetchTwitchInBackgroundWith<T>(api: CookieApi, url: string, init?: RequestInit): Promise<T> {
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
    const integrity = hasValidTwitchIntegrity() ? twitchIntegrity : undefined;
    if (integrity && !headers.has("client-integrity")) headers.set("client-integrity", integrity.integrity);
    const effectiveDeviceId = integrity?.deviceId ?? deviceId;
    if (effectiveDeviceId && !headers.has("x-device-id")) headers.set("x-device-id", effectiveDeviceId);
    if (!headers.has("client-session-id")) {
      headers.set("client-session-id", integrity?.clientSessionId ?? twitchClientSessionIdValue());
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

// Kick endpoints that replay the session_token cookie as a Bearer (mirrors the
// predicate inlined in pageFetchJson). kick.com/api/v2/* and /api/search are public
// and do not need it; kick.com/api/v1/user does, because Kick serves it anonymously
// as `200 {}` instead of a 401, so a missing Bearer there is indistinguishable from a
// signed-out session (see KickAdapter.checkAuthHealth).
//
// Matched on the parsed host and pathname rather than by substring: `includes` would
// also attach the session token to hosts that merely mention a Kick host (e.g.
// https://evil.example/?r=web.kick.com) and to unintended subpaths of /api/v1/user.
function needsKickSessionBearer(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.host === "web.kick.com" || parsed.host === "websockets.kick.com") return true;
  return parsed.host === "kick.com" && parsed.pathname === "/api/v1/user";
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

function safeKickFailure(status: number, text: string): SafeFetchFailure {
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

export async function fetchJsonInPageWithBrowser<T>(
  browserApi: BrowserTabApi,
  originUrl: string,
  url: string,
  init?: RequestInit,
  options?: PageFetchOptions,
): Promise<T> {
  const origin = new URL(originUrl).origin;
  const pageContext = await acquirePageContextTab(browserApi, originUrl, origin, options);

  try {
    const runtimeBrowser = browserApi;

    if (runtimeBrowser.scripting?.executeScript) {
      const [result] = await runtimeBrowser.scripting.executeScript({
        target: { tabId: pageContext.tabId },
        // args must be JSON-serializable; `undefined` is rejected ("unserializable"),
        // so pass `null` when there is no init (e.g. Kick GET requests).
        args: [url, init ? JSON.stringify(init) : null],
        // Kick needs the page MAIN world for Cloudflare/session context.
        // Twitch GQL also runs in MAIN, but uses XHR below to avoid Twitch's
        // page fetch wrappers.
        world: "MAIN",
        func: pageFetchJson,
      });
      // executeScript resolves one entry per injected frame; an empty array
      // means the context tab was closed or navigated away before injection.
      // Surface that clearly instead of dereferencing undefined.
      if (!result) throw new Error(`Page context for ${origin} returned no script result`);
      return unwrapPageFetchResult<T>(result.result);
    }

    if (runtimeBrowser.tabs.executeScript) {
      const code = `(${pageFetchJson.toString()})(${JSON.stringify(url)}, ${JSON.stringify(init ? JSON.stringify(init) : undefined)})`;
      const results = await runtimeBrowser.tabs.executeScript(pageContext.tabId, { code });
      const result = results?.[0];
      return unwrapPageFetchResult<T>(result);
    }

    throw new Error("No supported page script execution API is available");
  } finally {
    await releasePageContextTab(browserApi, origin, pageContext, options?.emit);
  }
}

function unwrapPageFetchResult<T>(candidate: unknown): T {
  if (!candidate || typeof candidate !== "object") return candidate as T;
  const envelope = candidate as Record<string, unknown>;
  if (envelope.__lurklootPageFetch !== true) return candidate as T;
  if (envelope.ok === true) return envelope.data as T;
  throw new SafeFetchError(safeFetchFailure(envelope.error));
}

async function acquirePageContextTab(
  browserApi: BrowserTabApi,
  originUrl: string,
  origin: string,
  options?: PageFetchOptions,
): Promise<PageContextTab> {
  const existing = pageContextTabs.get(origin);
  if (existing) {
    existing.refs += 1;
    return existing.promise;
  }

  const entry: PageContextEntry = {
    promise: findOrCreatePageContextTab(browserApi, originUrl, origin, options),
    refs: 1,
  };
  pageContextTabs.set(origin, entry);
  try {
    return await entry.promise;
  } catch (error) {
    if (pageContextTabs.get(origin) === entry) {
      pageContextTabs.delete(origin);
    }
    throw error;
  }
}

async function releasePageContextTab(browserApi: BrowserTabApi, origin: string, pageContext: PageContextTab, emit: EventEmitter = ignoreEvent): Promise<void> {
  const entry = pageContextTabs.get(origin);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  pageContextTabs.delete(origin);
  if (!pageContext.createdByExtension || !browserApi.tabs.remove) return;
  if (pageContext.retainedContext) {
    retainedPageContextTabs.set(pageContext.retainedContext.platform, pageContext.retainedContext);
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(pageContext.retainedContext.origin).host} because it may still be required`, pageContext.retainedContext.platform);
    return;
  }

  try {
    await browserApi.tabs.remove(pageContext.tabId);
  } catch {
    // The temporary context tab may have been closed manually before cleanup.
  }
}

async function findOrCreatePageContextTab(
  browserApi: BrowserTabApi,
  originUrl: string,
  origin: string,
  options?: PageFetchOptions,
): Promise<PageContextTab> {
  const retain = options?.retainPageContext;
  let openReason = options?.openReason ?? "background_rejected";
  const retained = retain?.managedContext ?? (retain ? retainedPageContextTabs.get(retain.platform) : undefined);
  const tabs = await browserApi.tabs.query({ url: `${origin}/*` });
  const retainedIds = new Set(
    [...retainedPageContextTabs.values(), retained]
      .filter((tab): tab is ManagedPageContextTab => tab != null && tab.origin === origin)
      .map((tab) => tab.tabId),
  );
  let tabId: number | undefined;
  for (const tab of tabs) {
    if (tab.id == null || retainedIds.has(tab.id)) continue;
    if (await isUsablePageContext(browserApi, tab.id, origin)) {
      tabId = tab.id;
      break;
    }
  }
  if (tabId != null) {
    if (retained?.origin === origin) {
      retainedPageContextTabs.delete(retained.platform);
      const remove = browserApi.tabs.remove;
      if (!remove) {
        diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(retained.origin).host} because tab removal is unavailable`, retained.platform);
      } else {
        try {
          await remove(retained.tabId);
          options?.emit?.({
            category: "activity",
            code: "page_context_closed",
            level: "info",
            platform: retained.platform,
            data: { host: new URL(retained.origin).host, reason: "user_tab_available" },
          });
          diagnostic(options?.emit ?? ignoreEvent, "info", `Closed managed page context on ${new URL(retained.origin).host} because a user tab is available`, retained.platform);
        } catch {
          // The retained page context may already be gone.
          diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(retained.origin).host} because the tab was already gone`, retained.platform);
        }
      }
    }
    diagnostic(options?.emit ?? ignoreEvent, "debug", `Reused user page context on ${new URL(origin).host}`, retain?.platform);
    return { tabId, createdByExtension: false };
  }

  if (retained?.origin === origin) {
    try {
      const tab = await browserApi.tabs.get(retained.tabId);
      if (tab?.id && tab.url?.startsWith(origin) && await isUsablePageContext(browserApi, tab.id, origin)) {
        retainedPageContextTabs.set(retained.platform, retained);
        diagnostic(options?.emit ?? ignoreEvent, "debug", `Reused managed page context on ${new URL(origin).host}`, retained.platform);
        return { tabId: tab.id, createdByExtension: true, retainedContext: retained };
      }
      retainedPageContextTabs.delete(retained.platform);
      openReason = "managed_context_unusable";
      if (tab?.id) {
        const remove = browserApi.tabs.remove;
        if (!remove) {
          diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because tab removal is unavailable`, retained.platform);
        } else {
          try {
            await remove(retained.tabId);
            options?.emit?.({
              category: "activity",
              code: "page_context_closed",
              level: "info",
              platform: retained.platform,
              data: { host: new URL(origin).host, reason: "managed_context_unusable" },
            });
            diagnostic(options?.emit ?? ignoreEvent, "info", `Closed managed page context on ${new URL(origin).host} because it became unusable`, retained.platform);
          } catch {
            diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because it was already gone`, retained.platform);
          }
        }
      }
    } catch {
      retainedPageContextTabs.delete(retained.platform);
      openReason = "managed_context_unusable";
      diagnostic(options?.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(origin).host} because it is unusable`, retained.platform);
    }
  }

  const tab = await browserApi.tabs.create({ url: originUrl, pinned: false, active: false }) as { id?: number };
  if (tab.id == null) {
    throw new Error(`Could not open page context for ${originUrl}`);
  }
  await browserApi.tabs.update(tab.id, { muted: true, active: false });
  await waitForPageContextReady(browserApi, tab.id, origin);
  if (!await isUsablePageContext(browserApi, tab.id, origin)) {
    try {
      await browserApi.tabs.remove?.(tab.id);
    } catch {
      // The unusable page may already have been closed.
    }
    throw new SafeFetchError({
      kind: "security_policy_blocked",
      reason: "Kick page context is blocked or unusable",
    });
  }
  if (retain) {
    const retainedContext: ManagedPageContextTab = {
      platform: retain.platform,
      tabId: tab.id,
      originUrl,
      origin,
      ownedByExtension: true,
    };
    retainedPageContextTabs.set(retain.platform, retainedContext);
    options?.emit?.({
      category: "activity",
      code: "page_context_opened",
      level: "info",
      platform: retain.platform,
      data: { host: new URL(origin).host, reason: openReason },
    });
    diagnostic(
      options?.emit ?? ignoreEvent,
      "info",
      `Created managed page context on ${new URL(origin).host} because ${openReason === "managed_context_unusable" ? "the previous context was unusable" : "background access was rejected"}`,
      retain.platform,
    );
    return { tabId: tab.id, createdByExtension: true, retainedContext };
  }
  return { tabId: tab.id, createdByExtension: true };
}

async function isUsablePageContext(browserApi: BrowserTabApi, tabId: number, origin: string): Promise<boolean> {
  if (origin !== "https://kick.com") return true;
  try {
    if (browserApi.scripting?.executeScript) {
      const [result] = await browserApi.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: validateKickPageContext,
      });
      const value = result?.result as { usable?: unknown } | undefined;
      return value?.usable === true || (value as { ok?: unknown } | undefined)?.ok === true;
    }
    if (browserApi.tabs.executeScript) {
      const results = await browserApi.tabs.executeScript(tabId, { code: `(${validateKickPageContext.toString()})()` });
      const value = results?.[0] as { usable?: unknown; ok?: unknown } | undefined;
      return value?.usable === true || value?.ok === true;
    }
  } catch {
    return false;
  }
  return false;
}

function validateKickPageContext(): { usable: boolean; failure?: SafeFetchFailure } {
  const contentType = document.contentType?.toLowerCase() ?? "";
  const text = document.body?.textContent?.trim().slice(0, 512) ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("json") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return { usable: false, failure: { kind: "invalid_response" } };
    }
  }
  const rawReason = typeof body.error === "string"
    ? body.error
    : typeof body.message === "string"
      ? body.message
      : undefined;
  const reason = rawReason && rawReason.length <= 256 ? rawReason : undefined;
  const blocked = /security policy|request blocked/i.test(reason ?? text);
  if (contentType.includes("json") || blocked) {
    const rawReference = body.reference;
    const reference = (typeof rawReference === "string" && rawReference.length > 0 && rawReference.length <= 128)
      || (typeof rawReference === "number" && Number.isFinite(rawReference))
      ? rawReference
      : undefined;
    return {
      usable: false,
      failure: {
        kind: blocked ? "security_policy_blocked" : "invalid_response",
        ...(reason ? { reason } : {}),
        ...(reference !== undefined ? { reference } : {}),
      },
    };
  }
  return { usable: contentType.includes("html") || document.documentElement?.tagName === "HTML" };
}

async function waitForPageContextReady(browserApi: BrowserTabApi, tabId: number, origin: string): Promise<void> {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "test") return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const tab = await browserApi.tabs.get(tabId);
      const url = tab?.url;
      if (tab && url?.startsWith(origin) && (tab.status == null || tab.status === "complete")) return;
    } catch {
      // Keep polling until the page either becomes ready or times out.
    }
    await wait(100);
  }
}

export function registerManagedPageContextTabs(contexts: SchedulerManagedPageContexts): void {
  retainedPageContextTabs.clear();
  for (const context of Object.values(contexts)) {
    if (context) retainedPageContextTabs.set(context.platform, context);
  }
}

export function currentManagedPageContextTabs(): SchedulerManagedPageContexts {
  return Object.fromEntries(retainedPageContextTabs) as SchedulerManagedPageContexts;
}

export function recordManagedPageContextFallback(
  platform: Platform,
  host: string,
  emit: EventEmitter = ignoreEvent,
  now: number = Date.now(),
): void {
  const context = retainedPageContextTabs.get(platform);
  if (!context) return;
  const updated: ManagedPageContextTab = {
    ...context,
    lastFallbackAt: new Date(now).toISOString(),
    fallbackHost: host,
    backgroundSuccesses: 0,
  };
  retainedPageContextTabs.set(platform, updated);
  diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} because background access is still rejected`, platform);
}

export async function recordManagedPageContextBackgroundSuccessWithBrowser(
  browserApi: BrowserTabApi,
  platform: Platform,
  host: string,
  emit: EventEmitter = ignoreEvent,
  now: number = Date.now(),
): Promise<void> {
  const context = retainedPageContextTabs.get(platform);
  if (!context?.lastFallbackAt || context.fallbackHost !== host) return;

  const updated: ManagedPageContextTab = {
    ...context,
    backgroundSuccesses: (context.backgroundSuccesses ?? 0) + 1,
  };
  retainedPageContextTabs.set(platform, updated);
  const fallbackAt = Date.parse(context.lastFallbackAt);
  const recovered = updated.backgroundSuccesses! >= PAGE_CONTEXT_RECOVERY_SUCCESSES
    && !Number.isNaN(fallbackAt)
    && now - fallbackAt >= PAGE_CONTEXT_RECOVERY_MIN_MS
    && !pageContextTabs.has(context.origin);
  if (!recovered) {
    diagnostic(emit, "debug", `Retained managed page context on ${new URL(context.origin).host} while background recovery is being confirmed`, platform);
    return;
  }

  retainedPageContextTabs.delete(platform);
  const remove = browserApi.tabs.remove;
  if (!remove) {
    diagnostic(emit, "debug", `Forgot managed page context on ${new URL(context.origin).host} because tab removal is unavailable`, platform);
    return;
  }
  try {
    await remove(context.tabId);
    emit({
      category: "activity",
      code: "page_context_closed",
      level: "info",
      platform,
      data: { host: new URL(context.origin).host, reason: "background_recovered" },
    });
    diagnostic(emit, "info", `Closed managed page context on ${new URL(context.origin).host} because background access recovered`, platform);
  } catch {
    diagnostic(emit, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the tab was already gone`, platform);
  }
}

// Pure state cleanup: drop the given platforms from the contexts map and the
// retained-tab registry, returning the next contexts. No browser access, so a
// headless runtime — and the scheduler's default — can forget page contexts
// without a tab API; the browser-backed variant below layers real tab removal
// on top.
export function forgetManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
): SchedulerManagedPageContexts {
  const platforms = options.platforms ?? ["twitch", "kick"];
  const next = { ...contexts };
  for (const platform of platforms) {
    if (!next[platform]) continue;
    delete next[platform];
    retainedPageContextTabs.delete(platform);
  }
  return next;
}

export async function stopManagedPageContextTabsWithBrowser(
  browserApi: BrowserTabApi,
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
): Promise<SchedulerManagedPageContexts> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  for (const platform of platforms) {
    const context = contexts[platform];
    if (!context) continue;
    const remove = browserApi.tabs.remove;
    if (!remove) {
      diagnostic(options.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(context.origin).host} because tab removal is unavailable`, platform);
      continue;
    }
    try {
      await remove(context.tabId);
      options.emit?.({
        category: "activity",
        code: "page_context_closed",
        level: "info",
        platform,
        data: { host: new URL(context.origin).host, reason: options.reason ?? "automation_disabled" },
      });
      diagnostic(options.emit ?? ignoreEvent, "info", `Closed managed page context on ${new URL(context.origin).host} because ${options.reason ?? "automation_disabled"}`, platform);
    } catch {
      // The retained page context may have been closed manually.
      diagnostic(options.emit ?? ignoreEvent, "debug", `Forgot managed page context on ${new URL(context.origin).host} because the tab was already gone`, platform);
    }
  }
  return forgetManagedPageContextTabs(contexts, options);
}

export type SchedulerManagedPageContexts = Partial<Record<Platform, ManagedPageContextTab>>;

// Injected into a page's MAIN world via executeScript to fetch with the page's
// cookies/session — used for Kick, which needs Cloudflare/session context. All
// Twitch requests go through fetchTwitchInBackground instead, because Twitch GQL
// cannot be reached from the twitch.tv page (CORS / anti-tampering). Must be
// self-contained: executeScript only serializes this function's own source, so
// module-scope helpers are unavailable in the page.
async function pageFetchJson(targetUrl: string, initJson?: string): Promise<unknown> {
  const parsedInit = initJson ? JSON.parse(initJson) : undefined;
  const headers = new Headers(parsedInit?.headers ?? {});
  // Mirrors needsKickSessionBearer; inlined because executeScript only serializes this
  // function's own source, so module-scope helpers are unavailable in the page. Matches
  // on parsed host/pathname so the session token is never attached to a look-alike host
  // or to an unintended subpath of /api/v1/user.
  let needsKickBearer = false;
  try {
    const parsedTarget = new URL(targetUrl);
    needsKickBearer = parsedTarget.protocol === "https:"
      && (parsedTarget.host === "web.kick.com"
        || parsedTarget.host === "websockets.kick.com"
        || (parsedTarget.host === "kick.com" && parsedTarget.pathname === "/api/v1/user"));
  } catch {
    needsKickBearer = false;
  }
  if (needsKickBearer && !headers.has("authorization")) {
    const sessionToken = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("session_token="))
      ?.slice("session_token=".length);
    if (sessionToken) headers.set("authorization", `Bearer ${decodeURIComponent(sessionToken)}`);
  }
  try {
    const response = await fetch(targetUrl, {
      ...parsedInit,
      headers,
      credentials: parsedInit?.credentials ?? "include",
    });
    const text = await response.text();
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        // Never retain non-JSON response bodies.
      }
      const rawReason = typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : undefined;
      const reason = rawReason && rawReason.length <= 256 ? rawReason : undefined;
      const rawReference = body.reference;
      const reference = (typeof rawReference === "string" && rawReference.length > 0 && rawReference.length <= 128)
        || (typeof rawReference === "number" && Number.isFinite(rawReference))
        ? rawReference
        : undefined;
      const blocked = /security policy|request blocked/i.test(reason ?? "");
      return {
        __lurklootPageFetch: true,
        ok: false,
        error: {
          kind: blocked
            ? "security_policy_blocked"
            : response.status === 401 || response.status === 403
              ? "authentication_rejected"
              : "http_error",
          status: response.status,
          ...(reason ? { reason } : {}),
          ...(reference !== undefined ? { reference } : {}),
        },
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? JSON.parse(text) : { html: text };
    return { __lurklootPageFetch: true, ok: true, data };
  } catch {
    return {
      __lurklootPageFetch: true,
      ok: false,
      error: { kind: "network_error" },
    };
  }
}
