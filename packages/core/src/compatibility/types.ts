import type {
  CompatibilityHost,
  CompatibilitySelections,
  KickClaimId,
  KickProfileId,
  TwitchHeartbeatId,
  TwitchIdentity,
  TwitchInventoryId,
  TwitchProfileId,
} from "@lurkloot/shared/compatibility";

export type {
  CompatibilityHost,
  CompatibilityHostFacts,
  CompatibilityPlatform,
  CompatibilityResolution,
  CompatibilitySelections,
  CompatibilityWarning,
  KickClaimId,
  KickProfileId,
  ResolvedCompatibility,
  TwitchHeartbeatId,
  TwitchIdentity,
  TwitchInventoryId,
  TwitchProfileId,
} from "@lurkloot/shared/compatibility";

export type CompatibilityLifecycle = "recommended" | "legacy" | "experimental";
export interface CompatibilityMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly lifecycle: CompatibilityLifecycle;
  readonly replacement?: string;
}

export interface TwitchProfileMetadata extends CompatibilityMetadata {
  readonly id: TwitchProfileId;
  readonly hosts: readonly CompatibilityHost[];
  readonly identities: readonly TwitchIdentity[];
  readonly heartbeatByIdentity: Readonly<Record<TwitchIdentity, TwitchHeartbeatId>>;
  readonly inventory: TwitchInventoryId;
}

export interface TwitchHeartbeatMetadata extends CompatibilityMetadata {
  readonly id: TwitchHeartbeatId;
  readonly hosts: readonly CompatibilityHost[];
  readonly identities: readonly TwitchIdentity[];
}

export interface TwitchInventoryMetadata extends CompatibilityMetadata {
  readonly id: TwitchInventoryId;
  readonly hosts: readonly CompatibilityHost[];
  readonly identities: readonly TwitchIdentity[];
}

export interface KickProfileMetadata extends CompatibilityMetadata {
  readonly id: KickProfileId;
  readonly hosts: readonly CompatibilityHost[];
  readonly claim: KickClaimId;
}

export interface KickClaimMetadata extends CompatibilityMetadata {
  readonly id: KickClaimId;
  readonly hosts: readonly CompatibilityHost[];
}

export interface CompatibilityRegistry {
  readonly twitch: {
    readonly profiles: Readonly<Record<TwitchProfileId, TwitchProfileMetadata>>;
    readonly heartbeat: Readonly<Record<TwitchHeartbeatId, TwitchHeartbeatMetadata>>;
    readonly inventory: Readonly<Record<TwitchInventoryId, TwitchInventoryMetadata>>;
  };
  readonly kick: {
    readonly profiles: Readonly<Record<KickProfileId, KickProfileMetadata>>;
    readonly claim: Readonly<Record<KickClaimId, KickClaimMetadata>>;
  };
}
