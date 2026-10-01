import type { PlatformCredentials } from "./authStore";

// The Android client remains supported for previously issued tokens, but Twitch
// no longer accepts new device-code requests for it.
export const TWITCH_ANDROID_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
export const TWITCH_SMARTBOX_CLIENT_ID = "ue6666qo983tsx6so1t0vnawi233wa";
export const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export const TWITCH_ANDROID_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/25.3.0/2503006";

// The GQL Client-ID must match the client the OAuth token was issued for, so the
// transport derives it from the stored credentials (the device flow records the
// client it used; SA_TWITCH_CLIENT_ID can override). Defaults to Smart TV for
// new logins. The Android user agent is sent only when the
// client is actually Android, so a custom client id is not misrepresented.
export function twitchClientIdentity(creds: PlatformCredentials): { clientId: string; userAgent?: string } {
  const clientId = creds.twitch?.clientId ?? TWITCH_SMARTBOX_CLIENT_ID;
  return {
    clientId,
    userAgent: clientId === TWITCH_ANDROID_CLIENT_ID ? TWITCH_ANDROID_USER_AGENT : undefined,
  };
}
