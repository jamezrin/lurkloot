import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, ManagedPageContextTab, ManagedWatchTab, Platform, WatchSession } from "./models";
import type { LogLevel } from "./logging";
import type { PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";

// tabs.ts is a pure module with no access to the scheduler state, so it reports
// tab-lifecycle and ad-focus events through this optional sink. The background
// registers an implementation that buffers them into the saved state (see
// createBackgroundController). Defaults to a no-op so tests and the page context
// stay unaffected when no sink is registered.
type ActivityLogger = (level: LogLevel, message: string, platform?: Platform) => void;
let activityLogger: ActivityLogger | undefined;

export function setActivityLogger(logger: ActivityLogger | undefined): void {
  activityLogger = logger;
}

function logTab(level: LogLevel, message: string, platform?: Platform): void {
  activityLogger?.(level, message, platform);
}

interface BrowserTabApi {
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

export async function openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab> {
  return openPinnedMutedTabWithBrowser(browser as BrowserTabApi, channel, session, options);
}

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

export async function stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
  return stopWatchTabWithBrowser(browser as BrowserTabApi, session, options);
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

export async function applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode): Promise<void> {
  return applyAdFocusWithBrowser(browser as BrowserTabApi, platform, tabId, adActive, mode);
}

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

interface CookieApi {
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

export async function fetchTwitchInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchTwitchInBackgroundWith(browser as CookieApi, url, init);
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
    if (deviceId && !headers.has("x-device-id")) headers.set("x-device-id", deviceId);
    if (!headers.has("client-session-id")) headers.set("client-session-id", twitchClientSessionIdValue());
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

export async function fetchJsonInPage<T>(
  originUrl: string,
  url: string,
  init?: RequestInit,
  options?: PageFetchOptions,
): Promise<T> {
  return fetchJsonInPageWithBrowser(browser as BrowserTabApi, originUrl, url, init, options);
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

export async function stopManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[] } = {},
): Promise<SchedulerManagedPageContexts> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  const next = { ...contexts };
  for (const platform of platforms) {
    const context = next[platform];
    if (!context) continue;
    delete next[platform];
    retainedPageContextTabs.delete(platform);
    try {
      await (browser as Partial<BrowserTabApi>).tabs?.remove?.(context.tabId);
    } catch {
      // The retained page context may have been closed manually.
    }
  }
  return next;
}

type SchedulerManagedPageContexts = Partial<Record<Platform, ManagedPageContextTab>>;

// Injected into a page's MAIN world via executeScript to fetch with the page's
// cookies/session — used for Kick, which needs Cloudflare/session context. All
// Twitch requests go through fetchTwitchInBackground instead, because Twitch GQL
// cannot be reached from the twitch.tv page (CORS / anti-tampering). Must be
// self-contained: executeScript only serializes this function's own source, so
// module-scope helpers are unavailable in the page.
async function pageFetchJson(targetUrl: string, initJson?: string): Promise<unknown> {
  const parsedInit = initJson ? JSON.parse(initJson) : undefined;
  const headers = new Headers(parsedInit?.headers ?? {});
  if (targetUrl.includes("web.kick.com") && !headers.has("authorization")) {
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
