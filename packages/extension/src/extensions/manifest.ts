import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";

interface ProviderManifest {
  manifest_version?: number;
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
}

export function applyProviderOptionalPermissions(manifest: ProviderManifest): void {
  const origins = twitchExtensionProviders.map((provider) => provider.origin);
  // WXT promotes runtime script matches to host_permissions. Run after WXT
  // has generated the manifest, before its MV2 conversion, to undo only the
  // provider-origin promotions and preserve every existing required grant.
  if (manifest.host_permissions) manifest.host_permissions = manifest.host_permissions.filter((origin) => !origins.includes(origin as typeof origins[number]));
  if (manifest.manifest_version === 2) {
    manifest.optional_permissions = [...new Set([...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? []), ...origins])];
    delete manifest.optional_host_permissions;
  } else {
    manifest.optional_host_permissions = [...new Set([...(manifest.optional_host_permissions ?? []), ...origins])];
  }
}
