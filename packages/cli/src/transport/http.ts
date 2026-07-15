import { fetchKickInBackgroundWith, fetchTwitchInBackgroundWith } from "@lurkloot/core/tabs";
import { KickAdapter, KickClaimState } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import { resolveCompatibility } from "@lurkloot/core";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformCredentials } from "../authStore";
import { twitchClientIdentity } from "../twitch";
import { kickCookieApi, twitchCookieApi } from "./cookieApi";
import { tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";

// Plain Node fetch transport. Twitch GQL works (no WAF). Kick's Cloudflare WAF
// fingerprints the TLS/HTTP-2 stack, so pure-Node requests get HTTP 403 — that
// surfaces as the engine's KickWafBlockedError, which `discover`/`run` report
// cleanly (reach Kick without a browser via the impersonate transport instead).
export function createHttpTransport(creds: PlatformCredentials, _enabled: EnabledPlatforms): TransportHandle {
  const twitchApi = twitchCookieApi(creds);
  const kickApi = kickCookieApi(creds);
  const kickClaimState = new KickClaimState();
  const createAdapters = (emit: EventEmitter | undefined, settings = DEFAULT_ENGINE_SETTINGS) => {
    const identity = twitchClientIdentity(creds);
    const twitchIdentity = identity.userAgent ? "android" : "web";
    const resolution = resolveCompatibility(settings.compatibility, { host: "cli", twitchIdentity });
    return {
      adapters: {
        twitch: new TwitchAdapter(
          { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchApi, url, init) },
          async () => false,
          tablessWatchPort,
          {
            ...identity,
            compatibility: resolution.compatibility.twitch,
            heartbeatIdentity: twitchIdentity,
            heartbeatFetchText: async (url, init) => {
              const response = await fetch(url, init);
              return response.text();
            },
            heartbeatPost: async (url, init) => {
              const response = await fetch(url, init);
              return { status: response.status };
            },
          },
          emit,
        ),
        kick: new KickAdapter(
          { fetchJson: (url, init) => fetchKickInBackgroundWith(kickApi, url, init) },
          tablessWatchPort,
          undefined,
          emit,
          { compatibility: resolution.compatibility.kick, claimState: kickClaimState },
        ),
      },
      ...resolution,
    };
  };
  return {
    adapters: createAdapters(undefined).adapters,
    createAdapters,
    async dispose() {
      // The http transport holds no long-lived resources.
    },
  };
}
