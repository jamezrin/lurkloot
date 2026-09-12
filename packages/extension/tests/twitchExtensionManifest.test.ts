import { describe, expect, it } from "vitest";
import { applyProviderOptionalPermissions } from "../src/extensions/manifest";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

const origins = twitchExtensionProviders.map((provider) => provider.origin);
describe("Twitch Extension manifest permissions", () => {
  it.each([2, 3])("keeps WXT runtime provider matches optional for MV%i", (version) => {
    const manifest = {
      manifest_version: version,
      permissions: ["tabs", "scripting"],
      host_permissions: ["https://*.twitch.tv/*", ...origins],
    };
    applyProviderOptionalPermissions(manifest);
    expect(manifest.permissions).toEqual(["tabs", "scripting"]);
    expect(manifest.host_permissions).toEqual(["https://*.twitch.tv/*"]);
    expect(version === 3 ? (manifest as { optional_host_permissions?: string[] }).optional_host_permissions
      : (manifest as { optional_permissions?: string[] }).optional_permissions).toEqual(origins);
    expect(JSON.stringify(manifest)).not.toContain("streamingtoolsmith.com");
    expect(JSON.stringify(manifest)).not.toContain("exmggames.com");
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
