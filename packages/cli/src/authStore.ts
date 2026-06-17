import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TwitchCredentials {
  authToken?: string;
  deviceId?: string;
  clientId?: string;
}

export interface KickCredentials {
  sessionToken?: string;
}

export interface PlatformCredentials {
  twitch?: TwitchCredentials;
  kick?: KickCredentials;
}

export const CREDENTIALS_FILE = "credentials.json";

// Loads credentials from <authDir>/credentials.json, then layers SA_* env
// overrides on top so Docker secrets / CI win over the on-disk store. Every
// field is optional — a transport simply runs anonymously where a credential is
// missing. The login flows that populate the store land in a later phase.
export function loadCredentials(authDir: string, env: NodeJS.ProcessEnv = process.env): PlatformCredentials {
  const stored = readStore(join(authDir, CREDENTIALS_FILE));
  return {
    twitch: {
      authToken: env.SA_TWITCH_AUTH_TOKEN ?? stored.twitch?.authToken,
      deviceId: env.SA_TWITCH_DEVICE_ID ?? stored.twitch?.deviceId,
      clientId: env.SA_TWITCH_CLIENT_ID ?? stored.twitch?.clientId,
    },
    kick: {
      sessionToken: env.SA_KICK_SESSION_TOKEN ?? stored.kick?.sessionToken,
    },
  };
}

function readStore(path: string): PlatformCredentials {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PlatformCredentials;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // No store yet (or unreadable) — env overrides may still supply credentials.
    return {};
  }
}

export function hasTwitchAuth(creds: PlatformCredentials): boolean {
  return Boolean(creds.twitch?.authToken);
}

export function hasKickAuth(creds: PlatformCredentials): boolean {
  return Boolean(creds.kick?.sessionToken);
}
