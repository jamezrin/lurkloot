import type { PageFetcher } from "@lurkloot/core/adapter";
import {
  TwitchExtensionClientRefusal,
  type SessionSource,
} from "@lurkloot/core/extensions/host/session";
import { createTwitchExtensionSessionSource } from "@lurkloot/core/extensions/host/transport";
import { CURRENT_USER_LOGIN_QUERY } from "@lurkloot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { TWITCH_WEB_CLIENT_ID, twitchClientIdentity } from "../twitch";

export interface TwitchExtensionAccess {
  source: SessionSource;
  viewerLogin(signal?: AbortSignal): Promise<string | undefined>;
}

// Refusals are different from network errors, rate limits, and 5xx responses.
// Match explicit authorization or query validation failures, and keep the
// server's response text inside the transport.
function refused(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const result = response as {
    __twitchGqlStatus?: number;
    error?: unknown;
    message?: unknown;
    errors?: { message?: unknown; extensions?: { code?: unknown } }[];
  };
  if (result.__twitchGqlStatus === 401 || result.__twitchGqlStatus === 403) return true;
  const refusalText =
    /\b(?:unauthori[sz]ed|forbidden|access denied|not authori[sz]ed|permission denied|cannot query field|client[ -]?id mismatch)\b/i;
  return (
    [result.error, result.message].some(
      (message) => typeof message === "string" && refusalText.test(message),
    )
    || (Array.isArray(result.errors)
      && result.errors.some((error) => {
        const code = error?.extensions?.code;
        return (
          code === "FORBIDDEN"
          || code === "UNAUTHORIZED"
          || code === "UNAUTHENTICATED"
          || code === "GRAPHQL_VALIDATION_FAILED"
          || (typeof error?.message === "string" && refusalText.test(error.message))
        );
      }))
  );
}

// The access object is an opaque revision. A session read and its identity
// query use the same credential snapshot, even if the auth store is reloaded
// while a request is pending.
export function createTwitchExtensionAccessReader(
  credentials: PlatformCredentials,
  createFetcher: (credentials: PlatformCredentials) => PageFetcher,
): () => TwitchExtensionAccess | undefined {
  let access: TwitchExtensionAccess | undefined;
  let previous: PlatformCredentials["twitch"];
  return () => {
    const twitch = credentials.twitch;
    if (!twitch?.authToken) {
      previous = undefined;
      access = undefined;
      return;
    }
    if (
      previous?.authToken === twitch.authToken
      && previous.clientId === twitch.clientId
      && previous.deviceId === twitch.deviceId
    )
      return access;

    previous = {
      authToken: twitch.authToken,
      deviceId: twitch.deviceId,
      clientId: twitch.clientId,
    };
    const fetcher = createFetcher({ twitch: previous });
    const { clientId, userAgent } = twitchClientIdentity({ twitch: previous });
    const source = createTwitchExtensionSessionSource({
      clientId,
      hasSession: async () => true,
      fetchJson: async (url, init) => {
        const headers = new Headers(init.headers);
        if (userAgent) headers.set("User-Agent", userAgent);
        const result = await fetcher.fetchJson(url, { ...init, headers });
        if (clientId !== TWITCH_WEB_CLIENT_ID && refused(result))
          throw new TwitchExtensionClientRefusal();
        return result;
      },
    });
    access = {
      source,
      viewerLogin: async (signal) => {
        const result = (await source.query(CURRENT_USER_LOGIN_QUERY, {}, signal)) as {
          data?: { currentUser?: { login?: unknown } };
        } | null;
        const login = result?.data?.currentUser?.login;
        return typeof login === "string" ? login : undefined;
      },
    };
    return access;
  };
}
