import { describe, expect, it } from "vitest";
import { twitchExtensionProviders, providerForOrigin } from "@lurkloot/core/extensions/registry";

describe("Twitch Extension registry", () => {
  it("resolves only the exact HTTPS frame origin", () => {
    for (const provider of twitchExtensionProviders) {
      expect(providerForOrigin(new URL(provider.origin).origin)).toBe(provider);
      expect(providerForOrigin(`http://${provider.extensionId}.ext-twitch.tv`)).toBeUndefined();
      expect(providerForOrigin(`https://${provider.extensionId}.ext-twitch.tv.evil.test`)).toBeUndefined();
    }
    expect(providerForOrigin("https://www.twitch.tv")).toBeUndefined();
    expect(providerForOrigin("not a URL")).toBeUndefined();
  });
  it("declares only the individual frame origin and bounded refresh floors", () => {
    expect(twitchExtensionProviders.map((provider) => provider.id)).toEqual(["nopixel", "fortnite"]);
    for (const provider of twitchExtensionProviders) {
      expect(provider.origin).toBe(`https://${provider.extensionId}.ext-twitch.tv/*`);
      expect(provider.minRefreshIntervalMs).toBeGreaterThanOrEqual(10_000);
      expect(Object.isFrozen(provider)).toBe(true);
    }
  });
});
