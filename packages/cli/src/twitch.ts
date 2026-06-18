import type { PlatformCredentials } from "./authStore";

// Twitch's Android app identity. Unlike the web client id, Twitch does not gate
// it behind Client-Integrity (Kasada), so a headless runtime can discover, watch,
// and CLAIM drops with just OAuth — no browser, no integrity token. This is the
// same client TwitchDropsMiner uses (ClientType.ANDROID_APP). The persisted-query
// hashes the engine sends are client-agnostic, so claims work unchanged.
export const TWITCH_ANDROID_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

export const TWITCH_ANDROID_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/25.3.0/2503006";

// The GQL Client-ID must match the client the OAuth token was issued for, so the
// transport derives it from the stored credentials (the device flow records the
// Android client it used; SA_TWITCH_CLIENT_ID can override). Defaults to the
// Android client — the integrity-free path. The Android user agent is sent only
// when the client is actually Android, so a custom client id is not misrepresented.
export function twitchClientIdentity(creds: PlatformCredentials): { clientId: string; userAgent?: string } {
  const clientId = creds.twitch?.clientId ?? TWITCH_ANDROID_CLIENT_ID;
  return {
    clientId,
    userAgent: clientId === TWITCH_ANDROID_CLIENT_ID ? TWITCH_ANDROID_USER_AGENT : undefined,
  };
}
