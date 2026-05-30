import { browser } from "wxt/browser";
import type { ChannelCandidate, WatchSession } from "./models";
import type { PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";

interface BrowserTabApi {
  tabs: {
    get(tabId: number): Promise<{ id?: number } | undefined>;
    update(tabId: number, properties: Record<string, unknown>): Promise<unknown>;
    remove?(tabId: number): Promise<void>;
    query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number }>>;
    create(createProperties: Record<string, unknown>): Promise<{ id?: number } | void>;
    executeScript?: (tabId: number, details: { code: string }) => Promise<unknown[] | undefined>;
  };
  scripting?: {
    executeScript?: (details: unknown) => Promise<Array<{ result?: unknown }>>;
  };
}

const pageContextTabs = new Map<string, Promise<number>>();
const DEFAULT_WATCH_TAB_OPTIONS: WatchTabOptions = {
  muted: true,
  closeManagedTabs: true,
};

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
  if (session?.tabId) {
    try {
      const tab = await browserApi.tabs.get(session.tabId);
      if (tab?.id) {
        await browserApi.tabs.update(tab.id, {
          url: channel.url,
          pinned: true,
          muted: tabOptions.muted,
          active: false,
        });
        return { tabId: tab.id, managedByExtension: session.tabManagedByExtension ?? true };
      }
    } catch {
      // The stored tab id can go stale after browser restarts or manual tab closure.
    }
  }

  const existing = await browserApi.tabs.query({ url: channel.url });
  const reusable = existing.find((tab) => tab.id != null);
  if (reusable?.id) {
    await browserApi.tabs.update(reusable.id, { pinned: true, muted: tabOptions.muted, active: false });
    return { tabId: reusable.id, managedByExtension: false };
  }

  const tab = await browserApi.tabs.create({
    url: channel.url,
    pinned: true,
    active: false,
  }) as { id?: number };
  if (tab.id == null) {
    throw new Error(`Could not create ${channel.platform} watch tab`);
  }
  await browserApi.tabs.update(tab.id, { muted: tabOptions.muted, active: false });
  return { tabId: tab.id, managedByExtension: true };
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

export async function fetchJsonInPage<T>(originUrl: string, url: string, init?: RequestInit): Promise<T> {
  return fetchJsonInPageWithBrowser(browser as BrowserTabApi, originUrl, url, init);
}

export async function fetchJsonInPageWithBrowser<T>(
  browserApi: BrowserTabApi,
  originUrl: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const tabId = await getPageContextTab(browserApi, originUrl);

  const runtimeBrowser = browserApi;

  if (runtimeBrowser.scripting?.executeScript) {
    const [result] = await runtimeBrowser.scripting.executeScript({
      target: { tabId },
      args: [url, init ? JSON.stringify(init) : undefined],
      func: pageFetchJson,
    });
    return result.result as T;
  }

  if (runtimeBrowser.tabs.executeScript) {
    const code = `(${pageFetchJson.toString()})(${JSON.stringify(url)}, ${JSON.stringify(init ? JSON.stringify(init) : undefined)})`;
    const results = await runtimeBrowser.tabs.executeScript(tabId, { code });
    const result = results?.[0];
    return result as T;
  }

  throw new Error("No supported page script execution API is available");
}

async function getPageContextTab(browserApi: BrowserTabApi, originUrl: string): Promise<number> {
  const origin = new URL(originUrl).origin;
  const existing = pageContextTabs.get(origin);
  if (existing) return existing;

  const promise = findOrCreatePageContextTab(browserApi, originUrl, origin);
  pageContextTabs.set(origin, promise);
  try {
    return await promise;
  } finally {
    pageContextTabs.delete(origin);
  }
}

async function findOrCreatePageContextTab(
  browserApi: BrowserTabApi,
  originUrl: string,
  origin: string,
): Promise<number> {
  const tabs = await browserApi.tabs.query({ url: `${origin}/*` });
  const tabId = tabs.find((tab) => tab.id != null)?.id;
  if (tabId != null) return tabId;

  const tab = await browserApi.tabs.create({ url: originUrl, pinned: false, active: false }) as { id?: number };
  if (tab.id == null) {
    throw new Error(`Could not open page context for ${originUrl}`);
  }
  await browserApi.tabs.update(tab.id, { muted: true, active: false });
  return tab.id;
}

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
    credentials: "include",
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
