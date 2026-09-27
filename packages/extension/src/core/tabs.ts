import { browser } from "wxt/browser";
import type { Platform } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import {
  cancelTwitchIntegrityAcquisition,
  currentValidTwitchIntegrity,
  recordManagedPageContextFallback,
  type TabRegistry,
  type TwitchIntegrityRequest,
} from "@lurkloot/core/tabRegistry";
import { fetchKickInBackgroundWith, type CookieApi } from "@lurkloot/core/transport";
import {
  ensureTwitchIntegrityWithBrowser,
  fetchJsonInPageWithBrowser,
  fetchTwitchInBackgroundWith,
  reconcileManagedPageContextRecoveryWithBrowser,
  TWITCH_PAGE_CONTEXT_URL,
  type BrowserTabApi,
  type PageFetchOptions,
} from "./browserTabs";
import type { KickPageContextCycleObservation } from "@lurkloot/core/adapter";

// The live wxt/browser tab API. background.ts hands it to createExtensionTabPorts
// (./tabPorts) for the controller's tab ports; everything else here is bound to
// it directly.
export const liveBrowserTabApi = browser as BrowserTabApi;

// Binds the remaining tab mechanics in ./browserTabs (integrity capture, page
// fetches, Kick page-context recovery) and the cookie fetchers to the live
// browser and to one tab registry, which the host also hands to the controller
// (#598). browserTabs.ts takes the browser API as an argument so tests can drive
// it with a fake; only the `browser` binding lives here.
export function createBrowserTabs(registry: TabRegistry) {
  const browserApi = liveBrowserTabApi;
  return {
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

  };
}
