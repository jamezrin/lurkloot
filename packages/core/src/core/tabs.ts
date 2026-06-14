import type { AdFocusMode, ChannelCandidate, ManagedPageContextTab, ManagedWatchTab, Platform, WatchSession } from "@stream-autopilot/shared/models";
import type { LogLevel } from "@stream-autopilot/shared/logging";
import { logActivity as logTab, setActivityLogger } from "./activityLog";
import type { TwitchIntegrity } from "./twitchIntegrity";
import type { PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";

// tabs.ts is a pure (browser-free) module with no access to the scheduler state,
// so it reports tab-lifecycle and ad-focus events through the shared activity-log
// sink (see activityLog.ts). Re-exported here so existing importers keep working.
// The concrete browser bindings (thin wrappers that pass `browser` into the
// `*WithBrowser` functions below) live in the extension package's core/tabs.ts.
export { setActivityLogger };

// The browser/runtime surface these functions operate on, injected by the caller
// (the extension passes `wxt/browser`; the CLI passes its own adapter). Exported
// so those concrete bindings can type their adapter against it.
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

export async function openPinnedMutedTabWithBrowser(
  browserApi: BrowserTabApi,
  channel: ChannelCandidate,
  session?: WatchSession,
  options?: Partial<WatchTabOptions>,
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
          await primeTabPlayback(browserApi, tab.id, channel.platform);
        }
        logTab("debug", `Reusing managed watch tab ${tab.id} for ${channel.username}`, channel.platform);
        return {
          tabId: tab.id,
          managedByExtension: true,
          managedTab: managedTab(channel, tab.id),
        };
      }
    } catch {
      // The registered managed tab can go stale after browser restarts or manual tab closure.
      logTab("debug", `Managed watch tab ${registered.tabId} is gone; opening a new one`, channel.platform);
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
          await primeTabPlayback(browserApi, tab.id, channel.platform);
        }
        logTab("debug", `Reusing your tab ${tab.id} for ${channel.username}`, channel.platform);
        return { tabId: tab.id, managedByExtension: false };
      }
    } catch {
      // Reused user tabs are best-effort only; if missing, create a managed tab.
      logTab("debug", `Reused tab ${session.tabId} is gone; opening a managed one`, channel.platform);
    }
  }

  const extraManagedTabIds = new Set<number>();
  if (registered?.tabId != null) extraManagedTabIds.add(registered.tabId);
  if (session?.tabManagedByExtension && session.tabId != null) extraManagedTabIds.add(session.tabId);
  for (const tabId of extraManagedTabIds) {
    if (!browserApi.tabs.remove) continue;
    try {
      await browserApi.tabs.remove(tabId);
      logTab("debug", `Removed stale watch tab ${tabId}`, channel.platform);
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
    logTab("error", `Could not create ${channel.platform} watch tab for ${channel.username}`, channel.platform);
    throw new Error(`Could not create ${channel.platform} watch tab`);
  }
  await browserApi.tabs.update(tab.id, { pinned: true, muted: tabOptions.muted, active: false });
  if (tabOptions.keepVideosUnmuted) {
    await primeTabPlayback(browserApi, tab.id, channel.platform);
  }
  logTab("info", `Opened watch tab ${tab.id} for ${channel.username}`, channel.platform);
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

async function primeTabPlayback(browserApi: BrowserTabApi, tabId: number, platform?: Platform): Promise<void> {
  const [previousActive] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const previousActiveId = previousActive?.id;

  logTab("debug", `Priming playback on watch tab ${tabId}`, platform);
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

export async function stopWatchTabWithBrowser(browserApi: BrowserTabApi, session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
  const tabOptions = { ...DEFAULT_WATCH_TAB_OPTIONS, ...options };
  if (!session.tabId) return;
  try {
    if (session.tabManagedByExtension && tabOptions.closeManagedTabs && browserApi.tabs.remove) {
      await browserApi.tabs.remove(session.tabId);
      logTab("debug", `Closed managed watch tab ${session.tabId}`, session.platform);
      return;
    }
    await browserApi.tabs.update(session.tabId, {
      muted: false,
      pinned: false,
      active: false,
    });
    logTab("debug", `Released your tab ${session.tabId} (unmuted, unpinned)`, session.platform);
  } catch {
    // The user may have closed the tab already.
    logTab("debug", `Watch tab ${session.tabId} was already closed`, session.platform);
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
): Promise<void> {
  if (mode === "none" || !adActive || tabId == null) {
    await releaseAdFocus(browserApi, platform, tabId);
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
    logTab("debug", `Focusing watch tab ${tabId} for an ad`, platform);
  }
}

async function releaseAdFocus(browserApi: BrowserTabApi, platform: Platform, watchTabId: number | undefined): Promise<void> {
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

  logTab("debug", `Restoring previous tab ${restore.tabId} after the ad`, platform);
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

export function setTwitchIntegrity(value: TwitchIntegrity | undefined, options?: { isNew?: boolean }): void {
  twitchIntegrity = value;
  if (value && options?.isNew) {
    const ttlSeconds = Math.max(0, Math.round((value.expiresAt - Date.now()) / 1000));
    logTab("info", `Captured a fresh Twitch integrity token (expires ${new Date(value.expiresAt).toISOString()}, in ${ttlSeconds}s)`, "twitch");
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
): Promise<boolean> {
  if (hasValidTwitchIntegrity()) return true;

  logTab("info", "No valid Twitch integrity token; opening a twitch.tv tab to capture one", "twitch");
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
      logTab("warn", `Timed out waiting for a Twitch integrity token after ${timeoutMs}ms (is twitch.tv logged in?)`, "twitch");
    }
    return captured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTab("warn", `Could not open a twitch.tv tab to capture an integrity token: ${message}`, "twitch");
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

function twitchGqlErrorEnvelope(summary: string, status: number, body: string, headers: Headers): { __twitchGqlError: string } {
  return { __twitchGqlError: [
    `Twitch GQL ${summary}`,
    `status=${status}`,
    `authHeader=${headers.has("authorization") ? "yes" : "no"}`,
    `body=${body.slice(0, 300)}`,
  ].join("; ") };
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

// Kick hosts whose endpoints replay the session_token cookie as a Bearer (mirrors
// pageFetchJson). kick.com/api/v2/* is public and does not need it. Exported so
// non-extension transports (the CLI's TLS-impersonating fetcher) share the same
// host list instead of copying it.
export const KICK_AUTH_HOSTS = ["web.kick.com", "websockets.kick.com"];

// The Authorization header value for a Kick request, or undefined when the host
// is public / no token is available. The stored cookie is URL-encoded, so it is
// decoded exactly once here — every caller must pass the raw (encoded) cookie.
export function kickBearerForUrl(url: string, sessionToken: string | undefined): string | undefined {
  if (!sessionToken) return undefined;
  if (!KICK_AUTH_HOSTS.some((host) => url.includes(host))) return undefined;
  return `Bearer ${decodeURIComponent(sessionToken)}`;
}

// Shared Kick response policy: turns an HTTP status + raw body into either the
// parsed JSON, an `{ html }` wrapper for legitimate non-API HTML pages, or a
// KickWafBlockedError when the response looks like a Cloudflare challenge (403,
// "security policy"/"blocked" text, or a non-JSON body on an API/WS endpoint —
// including a challenge that slips through with HTTP 200). Used by both the
// extension's service-worker fetch and the CLI's impersonating fetch so the
// classification can never drift between transports.
export function interpretKickResponse<T>(
  url: string,
  status: number,
  statusText: string,
  body: string,
  contentType: string,
): T {
  if (status < 200 || status >= 300) {
    const blocked = status === 403 || /security policy|blocked/i.test(body);
    const message = `HTTP ${status} ${statusText}`.trim();
    throw blocked ? new KickWafBlockedError(message) : new Error(message);
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new KickWafBlockedError("Kick returned a non-JSON body (likely a challenge page)");
    }
  }
  // Non-API kick.com pages (e.g. a channel page) legitimately return HTML; an API
  // or WS endpoint returning non-JSON means a challenge interstitial slipped a 2xx.
  if (url.includes("/api/") || url.includes("websockets.kick.com")) {
    throw new KickWafBlockedError("Kick returned a non-JSON API response (likely a challenge page)");
  }
  return { html: body } as T;
}

// Distinguishes "Kick's WAF / origin check rejected the service-worker request"
// (fall back to the page-context tab) from a genuine error. Thrown by
// fetchKickInBackground so the adapter wrapper can log and fall back cleanly.
export class KickWafBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KickWafBlockedError";
  }
}

// Spike: attempt a Kick API call straight from the service worker (no tab),
// mirroring pageFetchJson's auth/credentials so a success is equivalent. Kick's
// Cloudflare WAF may reject the chrome-extension:// origin; that surfaces as a
// KickWafBlockedError for the caller to fall back on. Only the real extension SW
// can answer whether this works — the Playwright harness cannot (its request
// stack is WAF-blocked for unrelated reasons).
export async function fetchKickInBackgroundWith<T>(api: CookieApi, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  // Only read the cookie for hosts that actually use it (kick.com/api/v2/* is
  // public), so a public request never touches the cookie jar.
  if (!headers.has("authorization") && KICK_AUTH_HOSTS.some((host) => url.includes(host))) {
    const sessionToken = (await api.cookies?.get({ url: "https://kick.com", name: "session_token" }))?.value;
    const bearer = kickBearerForUrl(url, sessionToken);
    if (bearer) headers.set("authorization", bearer);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "include" });
  } catch (error) {
    // A network/CORS rejection from the extension origin is exactly the
    // origin-level failure we want to fall back on, not a hard error.
    throw new KickWafBlockedError(error instanceof Error ? error.message : "network error");
  }

  const text = await response.text();
  return interpretKickResponse<T>(url, response.status, response.statusText, text, response.headers.get("content-type") ?? "");
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
      return result.result as T;
    }

    if (runtimeBrowser.tabs.executeScript) {
      const code = `(${pageFetchJson.toString()})(${JSON.stringify(url)}, ${JSON.stringify(init ? JSON.stringify(init) : undefined)})`;
      const results = await runtimeBrowser.tabs.executeScript(pageContext.tabId, { code });
      const result = results?.[0];
      return result as T;
    }

    throw new Error("No supported page script execution API is available");
  } finally {
    await releasePageContextTab(browserApi, origin, pageContext);
  }
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

async function releasePageContextTab(browserApi: BrowserTabApi, origin: string, pageContext: PageContextTab): Promise<void> {
  const entry = pageContextTabs.get(origin);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  pageContextTabs.delete(origin);
  if (!pageContext.createdByExtension || !browserApi.tabs.remove) return;
  if (pageContext.retainedContext) {
    retainedPageContextTabs.set(pageContext.retainedContext.platform, pageContext.retainedContext);
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
  const retained = retain?.managedContext ?? (retain ? retainedPageContextTabs.get(retain.platform) : undefined);
  const tabs = await browserApi.tabs.query({ url: `${origin}/*` });
  const retainedIds = new Set(
    [...retainedPageContextTabs.values(), retained]
      .filter((tab): tab is ManagedPageContextTab => tab != null && tab.origin === origin)
      .map((tab) => tab.tabId),
  );
  const tabId = tabs.find((tab) => tab.id != null && !retainedIds.has(tab.id))?.id;
  if (tabId != null) {
    if (retained?.origin === origin) {
      retainedPageContextTabs.delete(retained.platform);
      try {
        await browserApi.tabs.remove?.(retained.tabId);
      } catch {
        // The retained page context may already be gone.
      }
    }
    return { tabId, createdByExtension: false };
  }

  if (retained?.origin === origin) {
    try {
      const tab = await browserApi.tabs.get(retained.tabId);
      if (tab?.id) {
        retainedPageContextTabs.set(retained.platform, retained);
        return { tabId: tab.id, createdByExtension: true, retainedContext: retained };
      }
    } catch {
      retainedPageContextTabs.delete(retained.platform);
    }
  }

  const tab = await browserApi.tabs.create({ url: originUrl, pinned: false, active: false }) as { id?: number };
  if (tab.id == null) {
    throw new Error(`Could not open page context for ${originUrl}`);
  }
  await browserApi.tabs.update(tab.id, { muted: true, active: false });
  await waitForPageContextReady(browserApi, tab.id, origin);
  if (retain) {
    const retainedContext: ManagedPageContextTab = {
      platform: retain.platform,
      tabId: tab.id,
      originUrl,
      origin,
      ownedByExtension: true,
    };
    retainedPageContextTabs.set(retain.platform, retainedContext);
    return { tabId: tab.id, createdByExtension: true, retainedContext };
  }
  return { tabId: tab.id, createdByExtension: true };
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

// Browser-free bookkeeping: drop the named platforms from the retained-context
// registry and the returned contexts map, WITHOUT closing any real tab. Used as
// the scheduler's default when no tab-closing implementation is injected (e.g. a
// headless/tabless runtime that never opened a page-context tab to begin with).
export async function forgetManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[] } = {},
): Promise<SchedulerManagedPageContexts> {
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
  options: { platforms?: Platform[] } = {},
): Promise<SchedulerManagedPageContexts> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  for (const platform of platforms) {
    const context = contexts[platform];
    if (!context) continue;
    try {
      await browserApi.tabs.remove?.(context.tabId);
    } catch {
      // The retained page context may have been closed manually.
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
  if ((targetUrl.includes("web.kick.com") || targetUrl.includes("websockets.kick.com")) && !headers.has("authorization")) {
    const sessionToken = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("session_token="))
      ?.slice("session_token=".length);
    if (sessionToken) headers.set("authorization", `Bearer ${decodeURIComponent(sessionToken)}`);
  }
  const response = await fetch(targetUrl, {
    ...parsedInit,
    headers,
    credentials: parsedInit?.credentials ?? "include",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return { html: await response.text() };
}
