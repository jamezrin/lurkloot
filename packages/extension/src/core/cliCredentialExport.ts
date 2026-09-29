import type { CliCredentialBlob } from "@lurkloot/shared/messages";

export type ReadSessionCookie = (url: string, name: string) => Promise<string | undefined>;

// Used only by the explicit, confirmed popup export. The Kasada cookie belongs
// to k.twitchcdn.net, so querying twitch.tv would silently omit it.
export async function buildCliCredentialBlob(cookie: ReadSessionCookie): Promise<CliCredentialBlob> {
  return {
    version: 1,
    credentials: {
      twitch: {
        authToken: await cookie("https://www.twitch.tv", "auth-token"),
        deviceId: await cookie("https://www.twitch.tv", "unique_id"),
        kasadaSessionCookie: await cookie("https://k.twitchcdn.net", "KP_UIDz-ssn"),
      },
      kick: { sessionToken: await cookie("https://kick.com", "session_token") },
    },
  };
}
