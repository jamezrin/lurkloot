import type { ExtensionSettings } from "@lurkloot/shared/models";
import type { PopupAdapter } from "./types";

const TWITCH_HLS_HEARTBEAT_ID = "twitch-heartbeat-hls-v1";

function twitchUsesHlsHeartbeat(
  adapter: Pick<PopupAdapter, "resolveCompatibility">,
  settings: ExtensionSettings,
): boolean {
  return adapter.resolveCompatibility?.(settings.compatibility)?.compatibility.twitch.heartbeat === TWITCH_HLS_HEARTBEAT_ID;
}

/** Ask for the Twitch video CDN in the current user gesture.
 * Returns undefined when the next settings would not watch with HLS, so the
 * caller applies the change with no prompt. When they would, returns the grant:
 * a decline must leave Twitch off, or leave a non-HLS heartbeat in place.
 * The caller must invoke this before any await. */
export function requestTwitchHlsAccess(
  adapter: Pick<PopupAdapter, "resolveCompatibility" | "requestTwitchHlsPermission">,
  current: ExtensionSettings,
  next: ExtensionSettings,
): Promise<boolean> | undefined {
  const request = adapter.requestTwitchHlsPermission;
  if (!request) return undefined;
  if (!next.platform.twitch.enabled || !twitchUsesHlsHeartbeat(adapter, next)) return undefined;
  if (current.platform.twitch.enabled && twitchUsesHlsHeartbeat(adapter, current)) return undefined;
  try {
    return request().catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
