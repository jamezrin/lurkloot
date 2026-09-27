import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, ManagedWatchTab, Platform, PreparedWatchTab, SchedulerManagedPageContexts, TabClosureOrigin, WatchSession, WatchTabOptions } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason } from "@lurkloot/shared/events";
import {
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  recordManagedPageContextFallback,
  type TabRegistry,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabRegistry";
import { fetchKickInBackgroundWith, type CookieApi } from "@lurkloot/core/transport";
import {
  applyAdFocusWithBrowser,
  closeManagedWatchTabsWithBrowser,
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchTwitchInBackgroundWith,
  openPinnedMutedTabWithBrowser,
  reconcileManagedPageContextRecoveryWithBrowser,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  TWITCH_PAGE_CONTEXT_URL,
  type BrowserTabApi,
  type PageFetchOptions,
} from "./browserTabs";
import type { KickPageContextCycleObservation } from "@lurkloot/core/adapter";

// Binds the tab mechanics in ./browserTabs to the live wxt/browser tabs and
// cookies APIs and to one tab registry, which the host also hands to the
// controller (#598). browserTabs.ts takes the browser API as an argument so tests
// can drive it with a fake; only the `browser` binding lives here.
export function createBrowserTabs(registry: TabRegistry) {
  const browserApi = browser as BrowserTabApi;
  return {
    openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<PreparedWatchTab> {
      return openPinnedMutedTabWithBrowser(registry, browserApi, channel, session, options, emit);
    },

    stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<void> {
      return stopWatchTabWithBrowser(registry, browserApi, session, options, emit);
    },

    applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, mode: AdFocusMode, emit?: EventEmitter): Promise<void> {
      return applyAdFocusWithBrowser(registry, browserApi, platform, tabId, adActive, mode, emit);
    },

    ensureTwitchIntegrity(emit?: EventEmitter, request?: TwitchIntegrityRequest): Promise<boolean> {
      return ensureTwitchIntegrityWithBrowser(registry, browserApi, TWITCH_PAGE_CONTEXT_URL, undefined, emit, request);
    },

    cancelTwitchIntegrityAcquisition(reason?: unknown): void {
      cancelTwitchIntegrityAcquisition(registry, reason);
    },

    currentValidTwitchIntegrity() {
      return currentValidTwitchIntegrity(registry);
    },

    fetchTwitchInBackground<T>(url: string, init?: RequestInit): Promise<T> {
      return fetchTwitchInBackgroundWith<T>(registry, browser as CookieApi, url, init);
    },

    fetchKickInBackground<T>(url: string, init?: RequestInit): Promise<T> {
      return fetchKickInBackgroundWith<T>(browser as CookieApi, url, init);
    },

    fetchJsonInPage<T>(originUrl: string, url: string, init?: RequestInit, options?: PageFetchOptions): Promise<T> {
      return fetchJsonInPageWithBrowser<T>(registry, browserApi, originUrl, url, init, options);
    },

    recordManagedPageContextFallback(host: string, emit?: EventEmitter): void {
      recordManagedPageContextFallback(registry, "kick", host, emit);
    },

    reconcileManagedPageContextRecovery(
      platform: Platform,
      observation: KickPageContextCycleObservation,
      requiredSuccesses: number,
      emit?: EventEmitter,
    ): Promise<boolean> {
      return reconcileManagedPageContextRecoveryWithBrowser(
        registry,
        browserApi,
        platform,
        observation,
        requiredSuccesses,
        emit,
      );
    },

    closeManagedWatchTabs(tabs: readonly ManagedWatchTab[], origin: Exclude<TabClosureOrigin, "user">): Promise<void> {
      return closeManagedWatchTabsWithBrowser(registry, browserApi, tabs, origin);
    },

    stopManagedPageContextTabs(
      contexts: SchedulerManagedPageContexts,
      options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
    ): Promise<SchedulerManagedPageContexts> {
      return stopManagedPageContextTabsWithBrowser(registry, browserApi, contexts, options);
    },
  };
}
