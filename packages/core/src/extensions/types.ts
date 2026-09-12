export type TwitchExtensionProviderId = "nopixel" | "fortnite";

export interface TwitchExtensionProviderDescriptor {
  readonly id: TwitchExtensionProviderId;
  readonly extensionId: string;
  // Published frame origin is metadata only; tabless drivers never mount it.
  readonly origin: `https://${string}.ext-twitch.tv/*`;
  readonly backendOrigin: `https://${string}/*`;
  readonly discoveryCategoryIds: readonly string[];
  readonly minRefreshIntervalMs: number;
}

// Reports are explicit DTOs, never raw vendor responses. Provider-specific
// contracts extend this table when their reducers and drivers are introduced.
export interface TwitchExtensionReportContract {
  readonly keys: readonly string[];
  readonly unsolicited: boolean;
}
export type TwitchExtensionReportContracts = Readonly<Record<string, TwitchExtensionReportContract>>;

export interface TwitchExtensionCommand {
  readonly provider: TwitchExtensionProviderId;
  readonly requestId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
