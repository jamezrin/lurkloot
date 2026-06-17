import type { Platform } from "@lurkloot/shared/models";
import type { PageFetcher, PlatformAdapter, WatchTabPort } from "@lurkloot/core/adapter";

// A built set of platform adapters plus a teardown hook (e.g. to stop a
// cycletls/Playwright subprocess a later transport owns). Every transport
// returns this shape so the commands can dispose uniformly.
export interface TransportHandle {
  adapters: Record<Platform, PlatformAdapter>;
  dispose(): Promise<void>;
}

// Which platforms the run actually farms, so a transport can skip building heavy
// resources for a disabled platform.
export interface EnabledPlatforms {
  twitch: boolean;
  kick: boolean;
}

// Watch port for non-tab runtimes: opening a watch tab fails clearly (keep
// tablessMode on, or use the browser transport once it exists), while stopping
// is a harmless no-op (nothing to stop without a tab, but the scheduler still
// calls it to clean up idle/disabled platforms).
export const tablessWatchPort: WatchTabPort = {
  openPinnedMutedTab() {
    throw new Error('Tab-based watch is unavailable in this transport; keep "tablessMode" on or use the "browser" transport');
  },
  async stopWatchTab() {
    // nothing to stop without a tab
  },
};

// Fetcher for a platform disabled in config: the adapter set is built per
// platform (Record<Platform, …>), but the scheduler never ticks a disabled one,
// so this only fires if that invariant is ever broken — fail loudly then.
export function disabledFetcher(platform: Platform): PageFetcher {
  return {
    fetchJson() {
      throw new Error(`${platform} is disabled in this config; its adapter should not be used`);
    },
  };
}
