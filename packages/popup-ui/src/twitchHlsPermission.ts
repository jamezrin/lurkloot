import { TWITCH_HLS_HEARTBEAT_ID } from "@lurkloot/shared/compatibility";
import type { RuntimeSnapshot, TwitchHlsGrantIntent } from "@lurkloot/shared/messages";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import type { PopupAdapter } from "./types";

function twitchUsesHlsHeartbeat(
  adapter: Pick<PopupAdapter, "resolveCompatibility">,
  settings: ExtensionSettings,
): boolean {
  return adapter.resolveCompatibility?.(settings.compatibility)?.compatibility.twitch.heartbeat === TWITCH_HLS_HEARTBEAT_ID;
}

/** Ask for the Twitch video CDN in the current user gesture.
 * Returns undefined when the next settings would not watch with HLS, so the
 * caller applies the change itself with no prompt. When they would, the
 * background applies `intent` once the host is granted, even if the prompt
 * closes this popup, and the promise resolves the snapshot that results. It
 * resolves undefined on a decline, which must leave Twitch off or leave a
 * non-HLS heartbeat in place. The caller must not apply the change itself in
 * that case, and must invoke this before any await. */
export function requestTwitchHlsAccess(
  adapter: Pick<PopupAdapter, "resolveCompatibility" | "requestTwitchHlsGrant">,
  current: ExtensionSettings,
  next: ExtensionSettings,
  intent: TwitchHlsGrantIntent,
): Promise<RuntimeSnapshot | undefined> | undefined {
  const request = adapter.requestTwitchHlsGrant;
  if (!request) return undefined;
  if (!next.platform.twitch.enabled || !twitchUsesHlsHeartbeat(adapter, next)) return undefined;
  if (current.platform.twitch.enabled && twitchUsesHlsHeartbeat(adapter, current)) return undefined;
  try {
    return request(intent).catch((error: unknown) => {
      console.error("Failed to apply the Twitch video CDN grant", error);
      return undefined;
    });
  } catch (error) {
    console.error("Failed to request the Twitch video CDN grant", error);
    return Promise.resolve(undefined);
  }
}
