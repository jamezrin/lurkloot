import type { CliCredentialBlob } from "@lurkloot/shared/messages";

// `partitionedUnder` names the top-level site whose partitioned cookie jar to
// read. Omitted, browsers return only unpartitioned cookies.
export type ReadSessionCookie = (url: string, name: string, partitionedUnder?: string) => Promise<string | undefined>;

// Twitch's Kasada session cookie lives on k.twitchcdn.net, outside the required
// twitch.tv grant. The origin is optional and requested only by the explicit
// popup export, so installs and updates never ask for it.
export const KASADA_COOKIE_ORIGIN = "https://k.twitchcdn.net/*";

// Used only by the explicit, confirmed popup export. The Kasada cookie belongs
// to k.twitchcdn.net, so querying twitch.tv would silently omit it. Without the
// optional grant the export still carries the login cookies; the CLI then asks
// for a fresh export or a device login.
export async function buildCliCredentialBlob(
  cookie: ReadSessionCookie,
  hasKasadaAccess: () => Promise<boolean>,
): Promise<CliCredentialBlob> {
  return {
    version: 1,
    credentials: {
      twitch: {
        authToken: await cookie("https://www.twitch.tv", "auth-token"),
        deviceId: await cookie("https://www.twitch.tv", "unique_id"),
        kasadaSessionCookie: await hasKasadaAccess() ? await readKasadaCookie(cookie) : undefined,
      },
      kick: { sessionToken: await cookie("https://kick.com", "session_token") },
    },
  };
}

// k.twitchcdn.net sets this cookie from twitch.tv pages, so it is third-party.
// Firefox's Total Cookie Protection (and Chrome with third-party cookies
// partitioned) keeps it in twitch.tv's partition, which a plain lookup skips.
async function readKasadaCookie(cookie: ReadSessionCookie): Promise<string | undefined> {
  return await cookie("https://k.twitchcdn.net", "KP_UIDz-ssn")
    ?? await cookie("https://k.twitchcdn.net", "KP_UIDz-ssn", "https://twitch.tv");
}
