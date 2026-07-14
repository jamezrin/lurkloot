import type { CompatibilityRegistry } from "./types";

const ALL_HOSTS = Object.freeze(["extension", "cli"] as const);
const ALL_IDENTITIES = Object.freeze(["web", "android"] as const);

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

const twitchProfiles = frozen({
  "twitch-2026-07": frozen({
    id: "twitch-2026-07",
    title: "Twitch July 2026",
    description: "Recommended Twitch profile with host-aware watch heartbeats.",
    lifecycle: "recommended",
    hosts: ALL_HOSTS,
    identities: ALL_IDENTITIES,
    heartbeatByIdentity: frozen({
      web: "twitch-heartbeat-spade-v1",
      android: "twitch-heartbeat-trowel-v1",
    }),
    inventory: "twitch-inventory-v1",
  }),
});

const twitchHeartbeat = frozen({
  "twitch-heartbeat-gql-v1": frozen({
    id: "twitch-heartbeat-gql-v1",
    title: "GraphQL heartbeat v1",
    description: "Legacy SendEvents GraphQL watch heartbeat.",
    lifecycle: "legacy",
    replacement: "twitch-heartbeat-spade-v1",
    hosts: ALL_HOSTS,
    identities: ALL_IDENTITIES,
  }),
  "twitch-heartbeat-spade-v1": frozen({
    id: "twitch-heartbeat-spade-v1",
    title: "Spade heartbeat v1",
    description: "Twitch web-identity Spade beacon heartbeat.",
    lifecycle: "recommended",
    hosts: ALL_HOSTS,
    identities: Object.freeze(["web"] as const),
  }),
  "twitch-heartbeat-trowel-v1": frozen({
    id: "twitch-heartbeat-trowel-v1",
    title: "Trowel heartbeat v1",
    description: "Twitch Android-identity Trowel heartbeat.",
    lifecycle: "recommended",
    hosts: Object.freeze(["cli"] as const),
    identities: Object.freeze(["android"] as const),
  }),
});

const twitchInventory = frozen({
  "twitch-inventory-v1": frozen({
    id: "twitch-inventory-v1",
    title: "Inventory query v1",
    description: "Current verified Twitch inventory query and parser contract.",
    lifecycle: "recommended",
    hosts: ALL_HOSTS,
    identities: ALL_IDENTITIES,
  }),
  "twitch-inventory-v2": frozen({
    id: "twitch-inventory-v2",
    title: "Inventory query v2",
    description: "Experimental Twitch inventory query and parser contract.",
    lifecycle: "experimental",
    hosts: ALL_HOSTS,
    identities: ALL_IDENTITIES,
  }),
});

const kickProfiles = frozen({
  "kick-2026-07": frozen({
    id: "kick-2026-07",
    title: "Kick July 2026",
    description: "Recommended Kick profile with claim response link handling.",
    lifecycle: "recommended",
    hosts: ALL_HOSTS,
    claim: "kick-claim-v2",
  }),
});

const kickClaim = frozen({
  "kick-claim-v1": frozen({
    id: "kick-claim-v1",
    title: "Claim handling v1",
    description: "Legacy metadata-only account-link detection.",
    lifecycle: "legacy",
    replacement: "kick-claim-v2",
    hosts: ALL_HOSTS,
  }),
  "kick-claim-v2": frozen({
    id: "kick-claim-v2",
    title: "Claim handling v2",
    description: "Claim-response and metadata account-link detection.",
    lifecycle: "recommended",
    hosts: ALL_HOSTS,
  }),
});

export const COMPATIBILITY_REGISTRY: CompatibilityRegistry = frozen({
  twitch: frozen({ profiles: twitchProfiles, heartbeat: twitchHeartbeat, inventory: twitchInventory }),
  kick: frozen({ profiles: kickProfiles, claim: kickClaim }),
});
