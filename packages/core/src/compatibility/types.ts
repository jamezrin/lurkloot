import type { CompatibilitySettings } from "@lurkloot/shared/models";

export type CompatibilityLifecycle = "recommended" | "legacy" | "experimental";
export type CompatibilityPlatform = "twitch" | "kick";
export type CompatibilityHost = "extension" | "cli";
export type TwitchIdentity = "web" | "android";

export type TwitchProfileId = "twitch-2026-07";
export type TwitchHeartbeatId =
  | "twitch-heartbeat-gql-v1"
  | "twitch-heartbeat-spade-v1"
  | "twitch-heartbeat-trowel-v1";
export type TwitchInventoryId = "twitch-inventory-v1" | "twitch-inventory-v2";
export type KickProfileId = "kick-2026-07";
export type KickClaimId = "kick-claim-v1" | "kick-claim-v2";

export interface CompatibilityHostFacts {
  host: CompatibilityHost;
  twitchIdentity: TwitchIdentity;
}

export interface ResolvedCompatibility {
  twitch: {
    profile: TwitchProfileId;
    heartbeat: TwitchHeartbeatId;
    inventory: TwitchInventoryId;
  };
  kick: {
    profile: KickProfileId;
    claim: KickClaimId;
  };
}

export interface CompatibilityWarning {
  code: "unknown_selection" | "incompatible_override";
  platform: CompatibilityPlatform;
  field: string;
  requested: string;
  resolved: string;
}

export interface CompatibilityResolution {
  compatibility: ResolvedCompatibility;
  warnings: CompatibilityWarning[];
}

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

export type CompatibilitySelections = CompatibilitySettings;
