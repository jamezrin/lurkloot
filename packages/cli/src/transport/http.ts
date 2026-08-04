import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter, KickClaimState, KickDiscoveryState } from "@lurkloot/core/kick";
import { TwitchAdapter, TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { resolveCompatibility } from "@lurkloot/core";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { Platform } from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../authStore";
import { twitchClientIdentity } from "../twitch";
import { kickCookieApi, twitchCookieApi } from "./cookieApi";
import { createLazyAdapters, tablessWatchPort, withHeartbeatTimeout, type EnabledPlatforms, type TransportHandle } from "./common";

// Plain Node fetch transport. Twitch GQL works (no WAF). Kick's Cloudflare WAF
// fingerprints the TLS/HTTP-2 stack, so pure-Node requests get HTTP 403 — that
// surfaces as the engine's KickWafBlockedError, which `discover`/`run` report
// cleanly (reach Kick without a browser via the impersonate transport instead).
export function createHttpTransport(creds: PlatformCredentials, _enabled: EnabledPlatforms): TransportHandle {
  const twitchApi = twitchCookieApi(creds);
  const kickApi = kickCookieApi(creds);
  const kickClaimState = new KickClaimState();
  const kickDiscoveryState = new KickDiscoveryState();
  const twitchDiscoveryState = new TwitchDiscoveryState();
  const createAdapter = (platform: Platform, emit: EventEmitter | undefined, settings = DEFAULT_ENGINE_SETTINGS) => {
    const identity = twitchClientIdentity(creds);
    const twitchIdentity = identity.userAgent ? "android" : "web";
    const resolution = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity });
    const adapter = platform === "twitch"
      ? new TwitchAdapter(
        { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchApi, url, init) },
        async () => false,
        tablessWatchPort,
        {
          ...identity,
          compatibility: resolution.compatibility.twitch,
          discoveryState: twitchDiscoveryState,
          heartbeatIdentity: twitchIdentity,
          heartbeatFetchText: async (url, init) => {
            const response = await withHeartbeatTimeout(
              (signal) => fetch(url, { ...init, signal }),
              init?.signal,
            );
            return response.text();
          },
          heartbeatPost: async (url, init) => {
            const response = await withHeartbeatTimeout(
              (signal) => fetch(url, { ...init, signal }),
              init.signal,
            );
            return { status: response.status };
          },
        },
        emit,
      )
      : new KickAdapter(
        { fetchJson: (url, init) => fetchKickInBackgroundWith(kickApi, url, init) },
        tablessWatchPort,
        undefined,
        emit,
        { compatibility: resolution.compatibility.kick, claimState: kickClaimState, discoveryState: kickDiscoveryState },
      );
    return { adapter, ...resolution };
  };
  const createAdapters = (emit: EventEmitter | undefined, settings = DEFAULT_ENGINE_SETTINGS) => {
    const twitch = createAdapter("twitch", emit, settings);
    const kick = createAdapter("kick", emit, settings);
    return {
      adapters: {
        twitch: twitch.adapter,
        kick: kick.adapter,
      },
      compatibility: twitch.compatibility,
      warnings: twitch.warnings,
    };
  };
  return {
    adapters: createLazyAdapters((platform) => createAdapter(platform, undefined).adapter),
    createAdapter,
    createAdapters,
    async dispose() {
      // The http transport holds no long-lived resources.
    },
  };
}
