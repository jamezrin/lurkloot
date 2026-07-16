import type { CompatibilitySettings } from "./models";

export type CompatibilityPlatform = "twitch" | "kick";
export type CompatibilityHost = "extension" | "cli";
export type TwitchIdentity = "web" | "android";

export type TwitchProfileId = "twitch-2026-07";
export type TwitchHeartbeatId =
  | "twitch-heartbeat-gql-v1"
  | "twitch-heartbeat-spade-v1"
  | "twitch-heartbeat-trowel-v1";
export type TwitchInventoryId = "twitch-inventory-v1";
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

export type CompatibilitySelections = CompatibilitySettings;
