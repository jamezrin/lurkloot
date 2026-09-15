import { describe, expect, it } from "vitest";
import { applyProviderOptionalPermissions } from "../src/extensions/manifest";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

const origins = twitchExtensionProviders.map((provider) => provider.backendOrigin);
describe("Twitch Extension manifest permissions", () => {
  it.each([2, 3])("adds only optional backend grants for MV%i", (version) => {
    const manifest = {
      manifest_version: version,
      permissions: ["tabs", "scripting"],
      host_permissions: ["https://*.twitch.tv/*"],
    };
    applyProviderOptionalPermissions(manifest);
    expect(manifest.permissions).toEqual(["tabs", "scripting"]);
    expect(manifest.host_permissions).toEqual(["https://*.twitch.tv/*"]);
    expect(version === 3 ? (manifest as { optional_host_permissions?: string[] }).optional_host_permissions
      : (manifest as { optional_permissions?: string[] }).optional_permissions).toEqual(origins);
    expect((manifest as { minimum_chrome_version?: string }).minimum_chrome_version).toBe(version === 3 ? "116" : undefined);
    expect(JSON.stringify(manifest)).not.toContain("ext-twitch.tv");
  });
  it("preserves unrelated optional grants and removes MV3-only keys from MV2", () => {
    const manifest = {
      manifest_version: 2, optional_permissions: ["bookmarks"], optional_host_permissions: origins,
    };
    applyProviderOptionalPermissions(manifest);
    expect(manifest.optional_permissions).toEqual(["bookmarks", ...origins]);
    expect(manifest.optional_host_permissions).toBeUndefined();
  });
});
