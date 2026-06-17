import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, Platform, WatchSession } from "@lurkloot/shared/models";
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
} from "@lurkloot/core/tabs";
import type { PreparedWatchTab, WatchTabOptions } from "@lurkloot/core/adapter";

// Browser-backed wrappers binding the pure `*WithBrowser` engine functions in
// @lurkloot/core/tabs to the extension's live wxt/browser tabs/cookies APIs.
// This is the seam that keeps the engine browser-free: the headless CLI injects
// its own port implementations instead of these wrappers. New tab-bound logic
// belongs in core's `*WithBrowser` function; only the `browser` binding lives here.

export function openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab> {
  return openPinnedMutedTabWithBrowser(browser as BrowserTabApi, channel, session, options);
}

export function stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void> {
  return stopWatchTabWithBrowser(browser as BrowserTabApi, session, options);
}

export function applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode): Promise<void> {
  return applyAdFocusWithBrowser(browser as BrowserTabApi, platform, tabId, adActive, mode);
}

export function ensureTwitchIntegrity(): Promise<boolean> {
  return ensureTwitchIntegrityWithBrowser(browser as BrowserTabApi, TWITCH_PAGE_CONTEXT_URL);
}

export function fetchTwitchInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchTwitchInBackgroundWith<T>(browser as CookieApi, url, init);
}

export function fetchKickInBackground<T>(url: string, init?: RequestInit): Promise<T> {
  return fetchKickInBackgroundWith<T>(browser as CookieApi, url, init);
}

export function fetchJsonInPage<T>(originUrl: string, url: string, init?: RequestInit, options?: PageFetchOptions): Promise<T> {
  return fetchJsonInPageWithBrowser<T>(browser as BrowserTabApi, originUrl, url, init, options);
}

export function stopManagedPageContextTabs(
  contexts: SchedulerManagedPageContexts,
  options: { platforms?: Platform[] } = {},
): Promise<SchedulerManagedPageContexts> {
  return stopManagedPageContextTabsWithBrowser(browser as BrowserTabApi, contexts, options);
}
