import { describe, expect, it } from "vitest";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { CompatibilitySettings } from "@lurkloot/shared/models";
import { readFileSync } from "node:fs";

function settings(overrides: {
  twitch?: Partial<CompatibilitySettings["twitch"]>;
  kick?: Partial<CompatibilitySettings["kick"]>;
} = {}): CompatibilitySettings {
  return {
    twitch: { ...DEFAULT_ENGINE_SETTINGS.compatibility.twitch, ...overrides.twitch },
    kick: { ...DEFAULT_ENGINE_SETTINGS.compatibility.kick, ...overrides.kick },
  };
}

describe("compatibility registry", () => {
  it("publishes frozen lifecycle metadata for bundled profiles and capabilities", () => {
    expect(COMPATIBILITY_REGISTRY.twitch.profiles["twitch-2026-07"].lifecycle).toBe("recommended");
    expect(COMPATIBILITY_REGISTRY.twitch.inventory["twitch-inventory-v2"].lifecycle).toBe("experimental");
    expect(COMPATIBILITY_REGISTRY.kick.claim["kick-claim-v1"].lifecycle).toBe("legacy");
    expect(Object.isFrozen(COMPATIBILITY_REGISTRY)).toBe(true);
    expect(Object.isFrozen(COMPATIBILITY_REGISTRY.twitch.heartbeat)).toBe(true);
    expect(Object.isFrozen(COMPATIBILITY_REGISTRY.twitch.heartbeat["twitch-heartbeat-spade-v1"])).toBe(true);
  });
});

describe("extension compatibility construction", () => {
  it("injects the resolved web selection into both adapter option boundaries", () => {
    const backgroundSource = readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8");

    expect(backgroundSource).toContain("{ compatibility: resolution.compatibility.twitch }");
    expect(backgroundSource).toContain("{ compatibility: resolution.compatibility.kick }");
  });
});

describe("resolveCompatibility", () => {
  it("resolves automatic extension web selections", () => {
    expect(resolveCompatibility(settings(), { host: "extension", twitchIdentity: "web" })).toEqual({
      compatibility: {
        twitch: {
          profile: "twitch-2026-07",
          heartbeat: "twitch-heartbeat-spade-v1",
          inventory: "twitch-inventory-v1",
        },
        kick: { profile: "kick-2026-07", claim: "kick-claim-v2" },
      },
      warnings: [],
    });
  });

  it("resolves automatic CLI Android heartbeat selection", () => {
    expect(resolveCompatibility(settings(), { host: "cli", twitchIdentity: "android" }).compatibility.twitch.heartbeat)
      .toBe("twitch-heartbeat-trowel-v1");
  });

  it.each([
    { host: "extension", twitchIdentity: "android", expected: "twitch-heartbeat-gql-v1" },
    { host: "cli", twitchIdentity: "web", expected: "twitch-heartbeat-spade-v1" },
  ] as const)("resolves automatic $host/$twitchIdentity selection to a compatible heartbeat", (hostFacts) => {
    const heartbeat = resolveCompatibility(settings(), hostFacts).compatibility.twitch.heartbeat;
    const metadata = COMPATIBILITY_REGISTRY.twitch.heartbeat[heartbeat];

    expect(heartbeat).toBe(hostFacts.expected);
    expect(metadata.hosts).toContain(hostFacts.host);
    expect(metadata.identities).toContain(hostFacts.twitchIdentity);
  });

  it("accepts known compatible legacy and experimental overrides", () => {
    const result = resolveCompatibility(settings({
      twitch: {
        profile: "twitch-2026-07",
        heartbeatTransport: "twitch-heartbeat-gql-v1",
        inventoryQueryVersion: "twitch-inventory-v2",
      },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    }), { host: "extension", twitchIdentity: "web" });

    expect(result.compatibility).toEqual({
      twitch: {
        profile: "twitch-2026-07",
        heartbeat: "twitch-heartbeat-gql-v1",
        inventory: "twitch-inventory-v2",
      },
      kick: { profile: "kick-2026-07", claim: "kick-claim-v1" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls back for unknown profiles and overrides", () => {
    const result = resolveCompatibility(settings({
      twitch: { profile: "twitch-2099-01", heartbeatTransport: "unknown-heartbeat" },
      kick: { claimLinkHandling: "unknown-claim" },
    }), { host: "extension", twitchIdentity: "web" });

    expect(result.compatibility).toEqual({
      twitch: {
        profile: "twitch-2026-07",
        heartbeat: "twitch-heartbeat-spade-v1",
        inventory: "twitch-inventory-v1",
      },
      kick: { profile: "kick-2026-07", claim: "kick-claim-v2" },
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown_selection", platform: "twitch", field: "profile", requested: "twitch-2099-01", resolved: "twitch-2026-07" }),
      expect.objectContaining({ code: "unknown_selection", platform: "twitch", field: "heartbeatTransport", requested: "unknown-heartbeat", resolved: "twitch-heartbeat-spade-v1" }),
      expect.objectContaining({ code: "unknown_selection", platform: "kick", field: "claimLinkHandling", requested: "unknown-claim", resolved: "kick-claim-v2" }),
    ]);
  });

  it("warns and uses the web default for an incompatible Trowel override", () => {
    const result = resolveCompatibility(settings({ twitch: { heartbeatTransport: "twitch-heartbeat-trowel-v1" } }), {
      host: "extension",
      twitchIdentity: "web",
    });

    expect(result.compatibility.twitch.heartbeat).toBe("twitch-heartbeat-spade-v1");
    expect(result.warnings).toEqual([{
      code: "incompatible_override",
      platform: "twitch",
      field: "heartbeatTransport",
      requested: "twitch-heartbeat-trowel-v1",
      resolved: "twitch-heartbeat-spade-v1",
    }]);
  });
});
