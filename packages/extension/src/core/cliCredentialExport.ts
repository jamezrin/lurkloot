import type { CliCredentialBlob } from "@lurkloot/shared/messages";

// `partitionedUnder` names the top-level site whose partitioned cookie jar to
// read. Omitted, browsers return only unpartitioned cookies.
export type ReadSessionCookie = (
  url: string,
  name: string,
  partitionedUnder?: string,
) => Promise<string | undefined>;

// Twitch's Kasada session cookie lives on k.twitchcdn.net. The required
// `*.twitchcdn.net` host grant covers it, so the export can read the cookie
// without a separate optional permission.
export const KASADA_COOKIE_URL = "https://k.twitchcdn.net";

// Used only by the explicit, confirmed popup export. The Kasada cookie belongs
// to k.twitchcdn.net, so querying twitch.tv would silently omit it.
export async function buildCliCredentialBlob(
  cookie: ReadSessionCookie,
): Promise<CliCredentialBlob> {
  return {
    version: 1,
    credentials: {
      twitch: {
        authToken: await cookie("https://www.twitch.tv", "auth-token"),
        deviceId: await cookie("https://www.twitch.tv", "unique_id"),
        kasadaSessionCookie: await readKasadaCookie(cookie),
      },
      kick: { sessionToken: await cookie("https://kick.com", "session_token") },
    },
  };
}

// k.twitchcdn.net sets this cookie from twitch.tv pages, so it is third-party.
// Firefox's Total Cookie Protection (and Chrome with third-party cookies
// partitioned) keeps it in twitch.tv's partition, which a plain lookup skips.
async function readKasadaCookie(cookie: ReadSessionCookie): Promise<string | undefined> {
  return (
    (await cookie(KASADA_COOKIE_URL, "KP_UIDz-ssn"))
    ?? (await cookie(KASADA_COOKIE_URL, "KP_UIDz-ssn", "https://twitch.tv"))
  );
}
