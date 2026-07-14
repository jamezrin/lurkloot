import { COMPATIBILITY_REGISTRY } from "./registry";
import type {
  CompatibilityHostFacts,
  CompatibilityResolution,
  CompatibilityWarning,
  KickClaimId,
  KickProfileId,
  TwitchHeartbeatId,
  TwitchInventoryId,
  TwitchProfileId,
  CompatibilitySelections,
} from "./types";

const RECOMMENDED_TWITCH_PROFILE: TwitchProfileId = "twitch-2026-07";
const RECOMMENDED_KICK_PROFILE: KickProfileId = "kick-2026-07";

function hasOwn<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function warning(
  code: CompatibilityWarning["code"],
  platform: CompatibilityWarning["platform"],
  field: string,
  requested: string,
  resolved: string,
): CompatibilityWarning {
  return { code, platform, field, requested, resolved };
}

function resolveAutomaticHeartbeat(
  preferred: TwitchHeartbeatId,
  host: CompatibilityHostFacts,
): TwitchHeartbeatId {
  const candidates = [
    COMPATIBILITY_REGISTRY.twitch.heartbeat[preferred],
    ...Object.values(COMPATIBILITY_REGISTRY.twitch.heartbeat),
  ];
  const compatible = candidates.find((candidate) =>
    candidate.hosts.includes(host.host) && candidate.identities.includes(host.twitchIdentity));

  if (!compatible) throw new Error(`No compatible Twitch heartbeat for ${host.host}/${host.twitchIdentity}`);
  return compatible.id;
}

export function resolveCompatibility(
  settings: CompatibilitySelections,
  host: CompatibilityHostFacts,
): CompatibilityResolution {
  const warnings: CompatibilityWarning[] = [];

  let twitchProfile = RECOMMENDED_TWITCH_PROFILE;
  if (settings.twitch.profile !== "auto") {
    if (hasOwn(COMPATIBILITY_REGISTRY.twitch.profiles, settings.twitch.profile)) {
      const candidate = COMPATIBILITY_REGISTRY.twitch.profiles[settings.twitch.profile];
      if (candidate.hosts.includes(host.host) && candidate.identities.includes(host.twitchIdentity)) {
        twitchProfile = candidate.id;
      } else {
        warnings.push(warning("incompatible_override", "twitch", "profile", settings.twitch.profile, twitchProfile));
      }
    } else {
      warnings.push(warning("unknown_selection", "twitch", "profile", settings.twitch.profile, twitchProfile));
    }
  }

  const twitchDefaults = COMPATIBILITY_REGISTRY.twitch.profiles[twitchProfile];
  let heartbeat = resolveAutomaticHeartbeat(twitchDefaults.heartbeatByIdentity[host.twitchIdentity], host);
  let inventory: TwitchInventoryId = twitchDefaults.inventory;

  if (settings.twitch.heartbeatTransport !== "auto") {
    const requested = settings.twitch.heartbeatTransport;
    if (!hasOwn(COMPATIBILITY_REGISTRY.twitch.heartbeat, requested)) {
      warnings.push(warning("unknown_selection", "twitch", "heartbeatTransport", requested, heartbeat));
    } else {
      const candidate = COMPATIBILITY_REGISTRY.twitch.heartbeat[requested];
      if (candidate.hosts.includes(host.host) && candidate.identities.includes(host.twitchIdentity)) heartbeat = candidate.id;
      else warnings.push(warning("incompatible_override", "twitch", "heartbeatTransport", requested, heartbeat));
    }
  }

  if (settings.twitch.inventoryQueryVersion !== "auto") {
    const requested = settings.twitch.inventoryQueryVersion;
    if (!hasOwn(COMPATIBILITY_REGISTRY.twitch.inventory, requested)) {
      warnings.push(warning("unknown_selection", "twitch", "inventoryQueryVersion", requested, inventory));
    } else {
      const candidate = COMPATIBILITY_REGISTRY.twitch.inventory[requested];
      if (candidate.hosts.includes(host.host) && candidate.identities.includes(host.twitchIdentity)) inventory = candidate.id;
      else warnings.push(warning("incompatible_override", "twitch", "inventoryQueryVersion", requested, inventory));
    }
  }

  let kickProfile = RECOMMENDED_KICK_PROFILE;
  if (settings.kick.profile !== "auto") {
    if (hasOwn(COMPATIBILITY_REGISTRY.kick.profiles, settings.kick.profile)) {
      const candidate = COMPATIBILITY_REGISTRY.kick.profiles[settings.kick.profile];
      if (candidate.hosts.includes(host.host)) kickProfile = candidate.id;
      else warnings.push(warning("incompatible_override", "kick", "profile", settings.kick.profile, kickProfile));
    } else {
      warnings.push(warning("unknown_selection", "kick", "profile", settings.kick.profile, kickProfile));
    }
  }

  const kickDefaults = COMPATIBILITY_REGISTRY.kick.profiles[kickProfile];
  let claim: KickClaimId = kickDefaults.claim;
  if (settings.kick.claimLinkHandling !== "auto") {
    const requested = settings.kick.claimLinkHandling;
    if (!hasOwn(COMPATIBILITY_REGISTRY.kick.claim, requested)) {
      warnings.push(warning("unknown_selection", "kick", "claimLinkHandling", requested, claim));
    } else {
      const candidate = COMPATIBILITY_REGISTRY.kick.claim[requested];
      if (candidate.hosts.includes(host.host)) claim = candidate.id;
      else warnings.push(warning("incompatible_override", "kick", "claimLinkHandling", requested, claim));
    }
  }

  return {
    compatibility: {
      twitch: { profile: twitchProfile, heartbeat, inventory },
      kick: { profile: kickProfile, claim },
    },
    warnings,
  };
}
