import type { Transport } from "../config";
import { saveCredentials, type PlatformCredentials } from "../authStore";
import { TwitchWebIntegrityManager } from "../auth/twitchWebIntegrity";
import { TWITCH_WEB_CLIENT_ID } from "../twitch";
import { createHttpTransport } from "./http";
import { createImpersonateTransport } from "./impersonate";
import type { EnabledPlatforms, TransportHandle } from "./common";

export type { TransportHandle, EnabledPlatforms } from "./common";

// Builds the adapter set for the configured transport. Returns a disposable
// handle so callers can release transport-owned resources. Async because the
// impersonate transport spins up a cycletls subprocess on creation; `http`
// resolves immediately.
export async function createTransport(
  transport: Transport,
  credentials: PlatformCredentials,
  authDir: string,
  enabled: EnabledPlatforms,
): Promise<TransportHandle> {
  const twitch = credentials.twitch;
  const webIntegrity = enabled.twitch && twitch?.clientId === TWITCH_WEB_CLIENT_ID && twitch.authToken
    ? new TwitchWebIntegrityManager({
      authToken: twitch.authToken,
      deviceId: twitch.deviceId ?? "",
      kasadaSessionCookie: twitch.kasadaSessionCookie,
      onSessionCookie: (value) => saveCredentials(authDir, { twitch: { kasadaSessionCookie: value } }),
    })
    : undefined;
  switch (transport) {
    case "http":
      return createHttpTransport(credentials, enabled, webIntegrity);
    case "impersonate":
      return createImpersonateTransport(credentials, enabled, {}, webIntegrity);
    default:
      throw new Error(`Unknown transport: ${transport as string}`);
  }
}
