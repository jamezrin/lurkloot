import { browser } from "wxt/browser";
import type { AdFocusMode, ChannelCandidate, Platform, SchedulerManagedPageContexts, WatchSession } from "@lurkloot/shared/models";
import type { EventEmitter, PageContextCloseReason } from "@lurkloot/shared/events";
import {
  applyAdFocusWithBrowser,
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchKickInBackgroundWith,
  fetchTwitchInBackgroundWith,
  openPinnedMutedTabWithBrowser,
  recordManagedPageContextFallback,
  reconcileManagedPageContextRecoveryWithBrowser,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  TWITCH_PAGE_CONTEXT_URL,
  type BrowserTabApi,
  type CookieApi,
  type PageFetchOptions,
  type TabRegistry,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabs";
import type { KickPageContextCycleObservation, PreparedWatchTab, WatchTabOptions } from "@lurkloot/core/adapter";

// Browser-backed wrappers binding the pure `*WithBrowser` engine functions in
// @lurkloot/core/tabs to the extension's live wxt/browser tabs/cookies APIs and
// to one tab registry, which the host also hands to the controller (#598).
// This is the seam that keeps the engine browser-free: the headless CLI injects
// its own port implementations instead of these wrappers. New tab-bound logic
// belongs in core's `*WithBrowser` function; only the `browser` binding lives here.
export function createBrowserTabs(registry: TabRegistry) {
  const browserApi = browser as BrowserTabApi;
  return {
    openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<PreparedWatchTab> {
      return openPinnedMutedTabWithBrowser(registry, browserApi, channel, session, options, emit);
    },

    stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>, emit?: EventEmitter): Promise<void> {
      return stopWatchTabWithBrowser(browserApi, session, options, emit);
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

    stopManagedPageContextTabs(
      contexts: SchedulerManagedPageContexts,
      options: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter } = {},
    ): Promise<SchedulerManagedPageContexts> {
      return stopManagedPageContextTabsWithBrowser(registry, browserApi, contexts, options);
    },
  };
}
