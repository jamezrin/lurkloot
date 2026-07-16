import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { PlatformAdapter, WatchTabPort } from "@lurkloot/core/adapter";
import type { CompatibilityResolution } from "@lurkloot/core";

// A built set of platform adapters plus a teardown hook (e.g. to stop the
// cycletls subprocess the impersonate transport owns). Every transport returns
// this shape so the commands can dispose uniformly.
export interface TransportHandle {
  adapters: Record<Platform, PlatformAdapter>;
  createAdapters(emit: EventEmitter, settings: EngineSettings): {
    adapters: Record<Platform, PlatformAdapter>;
  } & CompatibilityResolution;
  dispose(): Promise<void>;
}

// Which platforms the run actually farms, so a transport can skip building heavy
// resources for a disabled platform.
export interface EnabledPlatforms {
  twitch: boolean;
  kick: boolean;
}

export const HEARTBEAT_REQUEST_TIMEOUT_MS = 15_000;

export async function withHeartbeatTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null,
  timeoutMs = HEARTBEAT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Twitch heartbeat request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

// Watch port for the headless transports, which never open a tab: opening fails
// clearly (the CLI farms tabless only — keep tablessMode on), while stopping is
// a harmless no-op (nothing to stop without a tab, but the scheduler still calls
// it to clean up idle/disabled platforms).
export const tablessWatchPort: WatchTabPort = {
  openPinnedMutedTab() {
    throw new Error('Tab-based watch is unavailable headlessly; keep "tablessMode" enabled in the config');
  },
  async stopWatchTab() {
    // nothing to stop without a tab
  },
};

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
