import type { BrowserTabsPort } from "@lurkloot/core/controller";
import type { KickPageContextRecoveryTracker } from "@lurkloot/core/kick";
import type { TabRegistry } from "@lurkloot/core/tabRegistry";
import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import {
  applyAdFocusWithBrowser,
  closeManagedWatchTabsWithBrowser,
  openPinnedMutedTabWithBrowser,
  reconcileManagedPageContextRecoveryWithBrowser,
  stopManagedPageContextTabsWithBrowser,
  stopWatchTabWithBrowser,
  type BrowserTabApi,
} from "./browserTabs";

type TabSettings = Pick<
  ExtensionSettings,
  "muteFarmingTabs" | "keepFarmingVideosUnmuted" | "autoCloseFinishedDrops" | "adFocusMode" | "kickPageContextRecoverySuccesses"
>;

// The route evidence a platform's fetcher gathers between recovery cycles:
// which hosts answered background requests and which fell back to the page.
export type PageContextRecoveryEvidence = Pick<KickPageContextRecoveryTracker, "take" | "restore" | "discard">;

// The extension's browser-tabs ports (#598): the tab mechanics in ./browserTabs,
// bound to one tab registry and one browser tab API, with the user's tab
// settings applied on top of the options the engine passes. It takes the
// browser API as an argument so the controller contract suite can run it
// against a fake browser; background.ts passes the live wxt/browser one.
// `recoveryEvidence` holds each platform's route evidence for page-context
// recovery; only Kick gathers any.
export function createExtensionTabPorts(
  registry: TabRegistry,
  browserApi: BrowserTabApi,
  loadSettings: () => Promise<TabSettings>,
  recoveryEvidence: Partial<Record<Platform, PageContextRecoveryEvidence>> = {},
): BrowserTabsPort {
  return {
    watch: {
      open: async (channel, session, options, emit) => {
        const settings = await loadSettings();
        return await openPinnedMutedTabWithBrowser(registry, browserApi, channel, session, {
          muted: settings.muteFarmingTabs,
          keepVideosUnmuted: settings.keepFarmingVideosUnmuted,
          closeManagedTabs: settings.autoCloseFinishedDrops,
          ...options,
        }, emit);
      },
      stop: async (session, options, emit) => {
        const settings = await loadSettings();
        await stopWatchTabWithBrowser(registry, browserApi, session, { closeManagedTabs: settings.autoCloseFinishedDrops, ...options }, emit);
      },
      closeManaged: (tabs, origin) => closeManagedWatchTabsWithBrowser(registry, browserApi, tabs, origin),
      applyAdFocus: async (platform, tabId, adActive, emit) => {
        const { adFocusMode } = await loadSettings();
        await applyAdFocusWithBrowser(registry, browserApi, platform, tabId, adActive, adFocusMode, emit);
      },
      loadPlaybackPolicy: async () => ({ keepVideosUnmuted: (await loadSettings()).keepFarmingVideosUnmuted !== false }),
    },
    pageContexts: {
      release: (contexts, options) => stopManagedPageContextTabsWithBrowser(registry, browserApi, contexts, options),
      recover: async (platform, options, emit) => {
        const evidence = recoveryEvidence[platform];
        const observation = evidence?.take();
        if (!evidence || !observation) return false;
        if (!options.countBackgroundSuccess) observation.backgroundHosts = [];
        try {
          const { kickPageContextRecoverySuccesses } = await loadSettings();
          return await reconcileManagedPageContextRecoveryWithBrowser(
            registry,
            browserApi,
            platform,
            observation,
            kickPageContextRecoverySuccesses,
            emit,
          );
        } catch (error) {
          // The cycle's evidence was not applied; keep it for the next one.
          evidence.restore(observation);
          throw error;
        }
      },
      discardRecoveryEvidence: (platform) => recoveryEvidence[platform]?.discard(),
    },
  };
}
