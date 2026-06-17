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

// Chrome 124 fingerprint for TLS/JA3 + HTTP/2 impersonation (what Cloudflare
// inspects in front of Kick). Mirrors curl_cffi's impersonate="chrome124" used
// by comparable Kick miners. A fingerprint can itself become flagged over time;
// bump these together — JA3 + HTTP/2 + UA must stay mutually consistent — if
// Kick starts rejecting them.
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0";
export const CHROME_HTTP2 = "1:65536,2:0,4:6291456,6:262144|15663105|0|m,a,s,p";

// Normalizes the various RequestInit.headers shapes into a plain object so the
// cycletls request options can carry them.
export function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    Object.assign(out, headers);
  }
  return out;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
