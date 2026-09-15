import { describe, expect, it } from "vitest";
import { twitchExtensionProviders, twitchExtensionProvider } from "@lurkloot/core/extensions/registry";

describe("tabless Twitch Extension registry", () => {
  it("resolves only supported provider IDs", () => {
    for (const provider of twitchExtensionProviders) expect(twitchExtensionProvider(provider.id)).toBe(provider);
    expect(twitchExtensionProvider("unknown")).toBeUndefined();
    expect(twitchExtensionProvider("__proto__")).toBeUndefined();
  });
  it("declares individual backend grants and bounded refresh floors", () => {
    expect(twitchExtensionProviders.map((provider) => provider.backendOrigin)).toEqual([
      "https://nopixel.streamingtoolsmith.com/*", "https://backend.p-n6412w7dsu.exmggames.com/*",
    ]);
    expect(twitchExtensionProviders[0].minRefreshIntervalMs).toBe(60_000);
    for (const provider of twitchExtensionProviders) {
      expect(provider.minRefreshIntervalMs).toBeGreaterThanOrEqual(10_000);
      expect(Object.isFrozen(provider)).toBe(true);
      expect(provider).not.toHaveProperty("origin");
    }
  });
});
