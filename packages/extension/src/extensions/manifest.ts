import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

interface ProviderManifest {
  manifest_version?: number;
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
}

export function applyProviderOptionalPermissions(manifest: ProviderManifest): void {
  const origins = twitchExtensionProviders.map((provider) => provider.backendOrigin);
  // Backend access is optional. Required grants are never modified here.
  if (manifest.manifest_version === 2) {
    manifest.optional_permissions = [...new Set([...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? []), ...origins])];
    delete manifest.optional_host_permissions;
  } else {
    manifest.optional_host_permissions = [...new Set([...(manifest.optional_host_permissions ?? []), ...origins])];
  }
}
