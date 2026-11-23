import type { Transport } from "../config";
import { refreshCredentials, saveCredentials, type PlatformCredentials } from "../authStore";
import { TwitchWebIntegrityManager } from "../auth/twitchWebIntegrity";
import { TWITCH_WEB_CLIENT_ID } from "../twitch";
import { createHttpTransport } from "./http";
import { createImpersonateTransport } from "./impersonate";
import type { EnabledPlatforms, TransportHandle } from "./common";
import type { ImpersonationBackend } from "./impersonation";

export type { TransportHandle, EnabledPlatforms } from "./common";
export type { ImpersonationBackend } from "./impersonation";

// The browser-impersonating library each transport sends Kick through, or
// undefined for plain fetch. "impersonate" names whichever one is the default,
// impit today, and is resolved here rather than rewritten in config.json.
export function impersonationBackendOf(transport: Transport): ImpersonationBackend | undefined {
  switch (transport) {
    case "http":
      return undefined;
    case "cycletls":
      return "cycletls";
    case "impit":
    case "impersonate":
      return "impit";
  }
}

// The library the Kick TV-link sign-in uses under a transport. Its endpoint
// sits behind Kick's WAF, so the plain http transport still signs in through
// the default impersonating backend.
export function signInBackendOf(transport: Transport): ImpersonationBackend {
  return impersonationBackendOf(transport) ?? "impit";
}

// Builds the adapter set for the configured transport. Returns a disposable
// handle so callers can release transport-owned resources. Async because the
// impersonating transports load their library (and cycletls starts its helper
// process) on creation; `http` resolves immediately.
export async function createTransport(
  transport: Transport,
  credentials: PlatformCredentials,
  authDir: string,
  enabled: EnabledPlatforms,
): Promise<TransportHandle> {
  const twitch = credentials.twitch;
  const webIntegrity =
    enabled.twitch && twitch?.clientId === TWITCH_WEB_CLIENT_ID && twitch.authToken
      ? new TwitchWebIntegrityManager({
          authToken: twitch.authToken,
          deviceId: twitch.deviceId ?? "",
          kasadaSessionCookie: twitch.kasadaSessionCookie,
          // A sign-in since start may have replaced the web session; its
          // rotated cookie must not be merged into the new login.
          onSessionCookie: (value) => {
            if (credentials.twitch?.clientId !== TWITCH_WEB_CLIENT_ID) return;
            saveCredentials(authDir, { twitch: { kasadaSessionCookie: value } });
          },
        })
      : undefined;
  const backend = impersonationBackendOf(transport);
  if (backend === undefined) {
    if (transport !== "http") throw new Error(`Unknown transport: ${transport as string}`);
    return createHttpTransport(credentials, enabled, webIntegrity);
  }
  return createImpersonateTransport(credentials, enabled, { backend }, webIntegrity);
}

// Reloads the credential store into the transport's credentials object before
// each adapter is built, so `run` and `serve` pick up a login or logout made
// while they run (from `auth …` in another terminal or the control plane's
// sign-in routes) without a restart. Before the adapter, not in the
// availability check: the adapter fixes the Twitch Client-ID when it is built,
// and a new token sent with the previous login's Client-ID would be rejected.
export function createCredentialRefreshingTransport(
  handle: TransportHandle,
  credentials: PlatformCredentials,
  authDir: string,
  env: NodeJS.ProcessEnv = process.env,
): TransportHandle {
  const refresh = () => refreshCredentials(credentials, authDir, env);
  return {
    adapters: handle.adapters,
    createAdapter: (platform, emit, settings) => {
      refresh();
      return handle.createAdapter(platform, emit, settings);
    },
    createAdapters: (emit, settings) => {
      refresh();
      return handle.createAdapters(emit, settings);
    },
    twitchExtensionAccess: () => {
      refresh();
      return handle.twitchExtensionAccess?.();
    },
    dispose: () => handle.dispose(),
  };
}
