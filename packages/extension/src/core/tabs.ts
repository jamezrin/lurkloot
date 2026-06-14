import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, Platform, WatchSession } from "@stream-autopilot/shared/models";
import type { PreparedWatchTab, WatchTabOptions } from "@stream-autopilot/core/adapter";
import {
  applyAdFocusWithBrowser,
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchKickInBackgroundWith,
  fetchTwitchInBackgroundWith,
  openPinnedMutedTabWithBrowser,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  TWITCH_PAGE_CONTEXT_URL,
  type BrowserTabApi,
  type CookieApi,
  type PageFetchOptions,
  type SchedulerManagedPageContexts,
} from "@stream-autopilot/core/tabs";

// Concrete browser bindings for the engine's browser-free tab/fetch primitives.
// Each thin wrapper passes `wxt/browser` into the matching `*WithBrowser` function
// in @stream-autopilot/core/tabs, keeping all the logic (and module-global state
// such as the integrity store and retained page-context registry) in core. A
// headless runtime (the CLI) provides its own adapter instead of importing this.

// Re-export the browser-free pieces extension callers still reach for directly
// (the integrity store, WAF error, activity-log sink, and registry helpers) so
// existing import sites keep resolving from "../core/tabs".
export {
  KickWafBlockedError,
  hasValidTwitchIntegrity,
  setActivityLogger,
  setTwitchIntegrity,
  registerManagedPageContextTabs,
  currentManagedPageContextTabs,
} from "@stream-autopilot/core/tabs";

export async function openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab> {
  return openPinnedMutedTabWithBrowser(browser as BrowserTabApi, channel, session, options);
}

export async function stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
  return stopWatchTabWithBrowser(browser as BrowserTabApi, session, options);
}

export async function applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode): Promise<void> {
  return applyAdFocusWithBrowser(browser as BrowserTabApi, platform, tabId, adActive, mode);
}

export async function ensureTwitchIntegrity(): Promise<boolean> {
  return ensureTwitchIntegrityWithBrowser(browser as BrowserTabApi, TWITCH_PAGE_CONTEXT_URL);
}

export async function fetchTwitchInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchTwitchInBackgroundWith(browser as CookieApi, url, init);
}

export async function fetchKickInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchKickInBackgroundWith(browser as CookieApi, url, init);
}

export async function fetchJsonInPage<T>(
  originUrl: string,
  url: string,
  init?: RequestInit,
  options?: PageFetchOptions,
): Promise<T> {
  return fetchJsonInPageWithBrowser(browser as BrowserTabApi, originUrl, url, init, options);
}

export async function stopManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[] } = {},
): Promise<SchedulerManagedPageContexts> {
  return stopManagedPageContextTabsWithBrowser(browser as BrowserTabApi, contexts, options);
}
