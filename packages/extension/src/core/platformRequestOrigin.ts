// The extension's own requests carry its chrome-extension:// (or
// moz-extension://) origin. Chrome attaches that Origin to every non-GET
// request from the service worker, popup or offscreen document, whatever the
// fetch mode or referrer policy, and to every WebSocket handshake. These
// dynamic rules present the platform's own site origin instead, on the
// platforms' hosts only.
//
// Chrome never applies DNR to a WebSocket the service worker opens, so the
// platform sockets open from the offscreen socket host (socketHostFactory.ts),
// where the socket rules apply. Firefox applies neither to its background
// page's sockets; platformSocketOrigin.ts rewrites them there (#792).

import {
  twitchExtensionFrameOrigin,
  twitchExtensionProviders,
} from "@lurkloot/core/extensions/registry";

// Granted GET and HEAD requests carry no Origin, so the HTTP rules leave them
// alone. That keeps the HLS playlist and segment requests exactly as they
// were (#752). A WebSocket handshake is a GET too, so sockets have their own
// rules.
const UNCHANGED_METHODS = ["get", "head"] as const;

// Twitch Extension providers' own socket backends present the provider's
// extension frame origin, as on Twitch (#798). One rule each, from 9105.
interface ProviderSocketOrigin {
  id: number;
  origin: string;
  domain: string;
}

const PROVIDER_SOCKET_ORIGINS: ProviderSocketOrigin[] = twitchExtensionProviders
  .filter((provider) => provider.backendSocketOrigin)
  .map((provider, index) => ({
    id: 9105 + index,
    origin: twitchExtensionFrameOrigin(provider),
    domain: new URL(provider.backendSocketOrigin!.replace("/*", "/")).hostname,
  }));

export const PLATFORM_ORIGIN_RULE_IDS = [9101, 9102, 9103, 9104, ...PROVIDER_SOCKET_ORIGINS.map(({ id }) => id)] as const;

interface PlatformOrigin {
  origin: string;
  request: { id: number; domains: string[] };
  socket: { id: number; domains: string[] };
}

const PLATFORM_ORIGINS: PlatformOrigin[] = [
  {
    origin: "https://www.twitch.tv",
    // gql, spade and the rest of *.twitch.tv; the video CDN; Kasada; and the
    // web player's telemetry beacon on Amazon IVS.
    request: { id: 9101, domains: ["twitch.tv", "ttvnw.net", "twitchcdn.net", "live-video.net"] },
    // Hermes and chat IRC.
    socket: { id: 9103, domains: ["twitch.tv"] },
  },
  {
    origin: "https://kick.com",
    request: { id: 9102, domains: ["kick.com"] },
    // Realtime (Centrifugo), the viewer socket, and Kick's Pusher fallback,
    // which kick.com itself opens with its own origin.
    socket: { id: 9104, domains: ["kick.com", "pusher.com"] },
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
    excludedRequestMethods?: string[];
    resourceTypes?: string[];
  };
}

export interface DynamicRulesApi {
  updateDynamicRules(options: { removeRuleIds: number[]; addRules: PlatformOriginRule[] }): Promise<void>;
}

function originRule(id: number, origin: string, condition: PlatformOriginRule["condition"]): PlatformOriginRule {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "origin", operation: "set", value: origin }],
    },
    condition,
  };
}

// The extension's own requests have its origin's host as initiator: the id on
// Chrome, the per-install UUID on Firefox.
export function platformOriginRules(extensionHost: string): PlatformOriginRule[] {
  const providers = PROVIDER_SOCKET_ORIGINS.map(({ id, origin, domain }) => originRule(id, origin, {
    initiatorDomains: [extensionHost],
    requestDomains: [domain],
    resourceTypes: ["websocket"],
  }));
  return [...PLATFORM_ORIGINS.flatMap(({ origin, request, socket }) => [
    originRule(request.id, origin, {
      initiatorDomains: [extensionHost],
      requestDomains: request.domains,
      excludedRequestMethods: [...UNCHANGED_METHODS],
    }),
    originRule(socket.id, origin, {
      initiatorDomains: [extensionHost],
      requestDomains: socket.domains,
      resourceTypes: ["websocket"],
    }),
  ]), ...providers];
}

// The site origin a platform socket presents, or undefined for any other
// socket, which is never rewritten.
export function platformSocketOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "wss:") return undefined;
  const host = parsed.hostname.toLowerCase();
  return PLATFORM_ORIGINS.find(({ socket }) => socket.domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  ))?.origin ?? PROVIDER_SOCKET_ORIGINS.find(({ domain }) => host === domain)?.origin;
}

// Dynamic rules survive browser restarts, so the first request after a cold
// start is covered too. Replaced on every background start, which also drops
// an older version's rules. Resolves false where the rules cannot be
// installed, so sockets that depend on them stay closed.
export async function installPlatformOriginRules(api: DynamicRulesApi | undefined, extensionHost: string): Promise<boolean> {
  if (!api || !extensionHost) return false;
  await api.updateDynamicRules({
    removeRuleIds: [...PLATFORM_ORIGIN_RULE_IDS],
    addRules: platformOriginRules(extensionHost),
  });
  return true;
}
