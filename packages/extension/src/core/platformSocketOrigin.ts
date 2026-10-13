import { platformSocketOrigin } from "./platformRequestOrigin";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import { KICK_SOCKET_ORIGIN, PUSHER_SOCKET_ORIGIN, TWITCH_SOCKET_ORIGIN } from "./platformHosts";

// Firefox has no offscreen document, and its declarativeNetRequest leaves the
// background page's sockets alone. Blocking webRequest rewrites their
// handshake Origin instead (#792). Chrome uses the offscreen socket host.

interface HttpHeader { name: string; value?: string }

interface SocketHeadersDetails {
  url: string;
  originUrl?: string;
  documentUrl?: string;
  requestHeaders?: HttpHeader[];
}

export interface BlockingWebRequestApi {
  onBeforeSendHeaders: {
    addListener(
      listener: (details: SocketHeadersDetails) => { requestHeaders: HttpHeader[] } | undefined,
      filter: { urls: string[]; types?: string[] },
      extraInfoSpec: string[],
    ): void;
  };
}

export const PLATFORM_SOCKET_ORIGINS: string[] = [
  TWITCH_SOCKET_ORIGIN,
  KICK_SOCKET_ORIGIN,
  PUSHER_SOCKET_ORIGIN,
  // Optional provider backends (#798): listened to, rewritten once granted.
  ...twitchExtensionProviders.flatMap((provider) => provider.backendSocketOrigin ? [provider.backendSocketOrigin] : []),
];

// The handshake headers with the platform's Origin, for the extension's own
// platform sockets only. A Twitch or Kick tab's sockets have the site as
// origin and are never touched.
export function rewriteSocketOrigin(details: SocketHeadersDetails, extensionOrigin: string): { requestHeaders: HttpHeader[] } | undefined {
  const initiator = details.originUrl ?? details.documentUrl;
  if (!initiator?.startsWith(`${extensionOrigin}/`) || !details.requestHeaders) return undefined;
  const origin = platformSocketOrigin(details.url);
  if (!origin) return undefined;
  const others = details.requestHeaders.filter((header) => header.name.toLowerCase() !== "origin");
  return { requestHeaders: [...others, { name: "Origin", value: origin }] };
}

// Register at the background's top level, synchronously: Firefox's event page
// must have the listener before its first socket opens.
export function installSocketOriginListener(webRequest: BlockingWebRequestApi | undefined, extensionOrigin: string): boolean {
  if (!webRequest?.onBeforeSendHeaders) return false;
  webRequest.onBeforeSendHeaders.addListener(
    (details) => rewriteSocketOrigin(details, extensionOrigin),
    { urls: PLATFORM_SOCKET_ORIGINS, types: ["websocket"] },
    ["blocking", "requestHeaders"],
  );
  return true;
}
