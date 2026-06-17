import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Merges new credentials into <authDir>/credentials.json, preserving any
// existing fields a partial login did not set (e.g. a Twitch-only login keeps
// the stored Kick token). The login flows write the store; loadCredentials reads
// it back (with SA_* overrides).
export function saveCredentials(authDir: string, creds: PlatformCredentials): void {
  mkdirSync(authDir, { recursive: true });
  const path = join(authDir, CREDENTIALS_FILE);
  const existing = readStore(path);
  const merged: PlatformCredentials = {
    twitch: pruneUndefined({ ...existing.twitch, ...creds.twitch }),
    kick: pruneUndefined({ ...existing.kick, ...creds.kick }),
  };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
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
