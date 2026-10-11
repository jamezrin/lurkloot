import type { TwitchExtensionProviderId } from "@lurkloot/shared/models";
export type { TwitchExtensionProviderId } from "@lurkloot/shared/models";

export interface TwitchExtensionProviderDescriptor {
  readonly id: TwitchExtensionProviderId;
  readonly extensionId: string;
  readonly backendOrigin: `https://${string}/*`;
  readonly discoveryCategoryIds: readonly string[];
  readonly minRefreshIntervalMs: number;
  // The provider credits rewards only while the viewer is in the channel's
  // chat (NoPixelV reads the chatter list, #683), so chat presence follows it.
  readonly needsChatPresence: boolean;
  // Messages on the extension's Hermes broadcast topic that change what a
  // refresh would read, so the driver refreshes at once on them (#757).
  readonly broadcastRefreshEvents?: readonly string[];
}
