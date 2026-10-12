// The extension's own requests carry its chrome-extension:// (or
// moz-extension://) origin. Chrome attaches that Origin to every non-GET
// request from the service worker, popup or offscreen document, whatever the
// fetch mode or referrer policy. These dynamic rules present the platform's own
// site origin instead, on the platforms' hosts only.
//
// The rules leave WebSockets alone: Chrome never applies DNR to a socket the
// service worker opens, so Kick's realtime socket still opens from the kick.com
// relay frame (#754). Sockets are tracked in #792.

// Granted GET and HEAD requests carry no Origin, so they are left alone. That
// keeps the HLS playlist and segment requests exactly as they were (#752).
const UNCHANGED_METHODS = ["get", "head"] as const;

export const PLATFORM_ORIGIN_RULE_IDS = [9101, 9102] as const;

interface PlatformOrigin {
  id: number;
  origin: string;
  requestDomains: string[];
}

const PLATFORM_ORIGINS: PlatformOrigin[] = [
  {
    id: PLATFORM_ORIGIN_RULE_IDS[0],
    origin: "https://www.twitch.tv",
    // gql, spade and the rest of *.twitch.tv; the video CDN; Kasada; and the
    // web player's telemetry beacon on Amazon IVS.
    requestDomains: ["twitch.tv", "ttvnw.net", "twitchcdn.net", "live-video.net"],
  },
  {
    id: PLATFORM_ORIGIN_RULE_IDS[1],
    origin: "https://kick.com",
    requestDomains: ["kick.com"],
  },
];

export interface PlatformOriginRule {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: {
    initiatorDomains: string[];
    requestDomains: string[];
    excludedRequestMethods: string[];
  };
}

export interface DynamicRulesApi {
  updateDynamicRules(options: { removeRuleIds: number[]; addRules: PlatformOriginRule[] }): Promise<void>;
}

// The extension's own requests have its origin's host as initiator: the id on
// Chrome, the per-install UUID on Firefox.
export function platformOriginRules(extensionHost: string): PlatformOriginRule[] {
  return PLATFORM_ORIGINS.map(({ id, origin, requestDomains }) => ({
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "origin", operation: "set", value: origin }],
    },
    condition: {
      initiatorDomains: [extensionHost],
      requestDomains,
      excludedRequestMethods: [...UNCHANGED_METHODS],
    },
  }));
}

// Dynamic rules survive browser restarts, so the first request after a cold
// start is covered too. Replaced on every background start, which also drops
// an older version's rules.
export async function installPlatformOriginRules(api: DynamicRulesApi | undefined, extensionHost: string): Promise<void> {
  if (!api || !extensionHost) return;
  await api.updateDynamicRules({
    removeRuleIds: [...PLATFORM_ORIGIN_RULE_IDS],
    addRules: platformOriginRules(extensionHost),
  });
}
