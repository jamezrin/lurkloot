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
}
