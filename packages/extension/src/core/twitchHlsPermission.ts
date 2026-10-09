import { resolveCompatibility } from "@lurkloot/core";
import { TWITCH_HLS_HEARTBEAT_ID } from "@lurkloot/core/twitch/heartbeat";
import type { ExtensionSettings } from "@lurkloot/shared/models";

// Twitch's video CDN. Playlist and segment hosts are nested ttvnw.net names,
// outside the required twitch.tv grant. Optional: requested when Twitch is
// turned on and the resolved watch heartbeat is the HLS variant.
export const TWITCH_HLS_HOST_ORIGIN = "https://*.ttvnw.net/*";

/** Twitch is on, the resolved watch heartbeat is HLS, and the video CDN grant is absent. */
export function shouldSuspendTwitchForMissingHlsHost(settings: ExtensionSettings, hasVideoCdnAccess: boolean): boolean {
  if (hasVideoCdnAccess || !settings.platform.twitch.enabled) return false;
  return resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }).compatibility.twitch.heartbeat === TWITCH_HLS_HEARTBEAT_ID;
}

/** Turn Twitch off when an extension restart would farm HLS without the video CDN grant.
 * The next manual enable is the gesture that asks for the permission. */
export async function suspendTwitchUntilHlsHostGranted(deps: {
  loadSettings(): Promise<ExtensionSettings>;
  hasVideoCdnAccess(): Promise<boolean>;
  disableTwitch(): Promise<void>;
}): Promise<void> {
  const settings = await deps.loadSettings();
  if (!shouldSuspendTwitchForMissingHlsHost(settings, false)) return;
  if (await deps.hasVideoCdnAccess()) return;
  await deps.disableTwitch();
}
