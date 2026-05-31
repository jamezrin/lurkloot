import { browser } from "wxt/browser";
import type { ChannelCandidate, ManagedPageContextTab, ManagedWatchTab, Platform, WatchSession } from "./models";
import type { PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";

interface BrowserTabApi {
  tabs: {
    get(tabId: number): Promise<BrowserTab | undefined>;
    update(tabId: number, properties: Record<string, unknown>): Promise<unknown>;
    remove?(tabId: number): Promise<void>;
    query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
    create(createProperties: Record<string, unknown>): Promise<{ id?: number } | void>;
    executeScript?: (tabId: number, details: { code: string }) => Promise<unknown[] | undefined>;
  };
  scripting?: {
    executeScript?: (details: unknown) => Promise<Array<{ result?: unknown }>>;
  };
}

interface BrowserTab {
  id?: number;
  url?: string;
  pinned?: boolean;
  active?: boolean;
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
          await primeTabPlayback(browserApi, tab.id);
        }
        return {
          tabId: tab.id,
          managedByExtension: true,
          managedTab: managedTab(channel, tab.id),
        };
      }
    } catch {
      // The registered managed tab can go stale after browser restarts or manual tab closure.
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
          await primeTabPlayback(browserApi, tab.id);
        }
        return { tabId: tab.id, managedByExtension: false };
      }
    } catch {
      // Reused user tabs are best-effort only; if missing, create a managed tab.
    }
  }

  const extraManagedTabIds = new Set<number>();
  if (registered?.tabId != null) extraManagedTabIds.add(registered.tabId);
  if (session?.tabManagedByExtension && session.tabId != null) extraManagedTabIds.add(session.tabId);
  for (const tabId of extraManagedTabIds) {
    if (!browserApi.tabs.remove) continue;
    try {
      await browserApi.tabs.remove(tabId);
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
    throw new Error(`Could not create ${channel.platform} watch tab`);
  }
  await browserApi.tabs.update(tab.id, { pinned: true, muted: tabOptions.muted, active: false });
  if (tabOptions.keepVideosUnmuted) {
    await primeTabPlayback(browserApi, tab.id);
  }
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
  return playback.videoCount === 0
    || playback.unmutedVideoCount === 0
    || playback.playingVideoCount === 0;
}

async function primeTabPlayback(browserApi: BrowserTabApi, tabId: number): Promise<void> {
  const [previousActive] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const previousActiveId = previousActive?.id;

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
      return;
    }
    await browserApi.tabs.update(session.tabId, {
      muted: false,
      pinned: false,
      active: false,
    });
  } catch {
    // The user may have closed the tab already.
  }
}

export interface PageFetchOptions {
  retainPageContext?: {
    platform: Platform;
    managedContext?: ManagedPageContextTab;
  };
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
        // Run in the page's MAIN world: Cloudflare-protected APIs (Kick) reject
        // fetches from the isolated content-script world, where the page's
        // clearance context isn't available.
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
    // Public queries pass credentials: "omit" so Twitch treats them as anonymous;
    // logged-in GQL requests without an integrity token are rejected.
    credentials: parsedInit?.credentials ?? "include",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return { html: await response.text() };
}
