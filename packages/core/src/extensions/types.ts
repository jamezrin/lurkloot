import type { TwitchExtensionProviderId } from "@lurkloot/shared/models";
export type { TwitchExtensionProviderId } from "@lurkloot/shared/models";

export interface TwitchExtensionProviderDescriptor {
  readonly id: TwitchExtensionProviderId;
  readonly extensionId: string;
  readonly backendOrigin: `https://${string}/*`;
  readonly discoveryCategoryIds: readonly string[];
  readonly minRefreshIntervalMs: number;
}
