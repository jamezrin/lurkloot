import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform, PlatformAuthReasonCode, PlatformAuthStatus } from "@lurkloot/shared/models";
import type { CredentialAvailability } from "@lurkloot/core/controller";

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

// Removes a platform's stored credentials from <authDir>/credentials.json,
// leaving the other platform untouched. Returns true if something was removed.
// Only the on-disk store is affected — an SA_* env override still wins in
// loadCredentials, so a caller may want to warn that the platform is still
// authenticated from the environment.
export function forgetCredentials(authDir: string, platform: keyof PlatformCredentials): boolean {
  const path = join(authDir, CREDENTIALS_FILE);
  const existing = readStore(path);
  if (!existing[platform]) return false;
  delete existing[platform];
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  return true;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function readStore(path: string): PlatformCredentials {
  return readStoreDetailed(path).store;
}

// Reads the store while distinguishing "there is no store yet" (a normal state —
// env overrides may still supply credentials) from "the store exists but could
// not be read/parsed" (a transient lookup failure worth surfacing as such). The
// callers that only care about the resulting credentials use readStore above.
function readStoreDetailed(path: string): { store: PlatformCredentials; lookupFailed: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // A missing file is expected; anything else (permissions, I/O) is a failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: {}, lookupFailed: false };
    return { store: {}, lookupFailed: true };
  }
  try {
    const parsed = JSON.parse(raw) as PlatformCredentials;
    return { store: parsed && typeof parsed === "object" ? parsed : {}, lookupFailed: false };
  } catch {
    // The file is present but corrupt — the login flow can rewrite it, but for
    // now the credential lookup has failed rather than come back empty.
    return { store: {}, lookupFailed: true };
  }
}

export function hasTwitchAuth(creds: PlatformCredentials): boolean {
  return Boolean(creds.twitch?.authToken);
}

export function hasKickAuth(creds: PlatformCredentials): boolean {
  return Boolean(creds.kick?.sessionToken);
}

// Where the effective credential for a platform came from. Kept internal to the
// CLI so status/logging can explain reachability without ever printing the value
// itself: "environment" means an SA_* override won, "stored" means the on-disk
// credentials.json supplied it, "none" means neither did.
export type CredentialSource = "environment" | "stored" | "none";

// A CLI-local, network-free reading of a platform's credential state, expressed
// in the shared safe auth-health vocabulary. It never inspects browser cookies
// and never carries a credential value — only whether one is present, where it
// came from, and the resulting safe status/reason code.
export interface LocalCredentialHealth {
  present: boolean;
  source: CredentialSource;
  status: Extract<PlatformAuthStatus, "checking" | "missing_credentials" | "unavailable">;
  reasonCode?: Extract<PlatformAuthReasonCode, "credentials_missing" | "credential_lookup_failed">;
}

const PRIMARY_ENV_KEY: Record<Platform, string> = {
  twitch: "SA_TWITCH_AUTH_TOKEN",
  kick: "SA_KICK_SESSION_TOKEN",
};

function primaryStoredValue(platform: Platform, store: PlatformCredentials): string | undefined {
  return platform === "twitch" ? store.twitch?.authToken : store.kick?.sessionToken;
}

// Mirrors loadCredentials' nullish env-over-store merge so the reported source
// matches the credential a transport would actually use.
function credentialPresence(platform: Platform, store: PlatformCredentials, env: NodeJS.ProcessEnv): { present: boolean; source: CredentialSource } {
  const envValue = env[PRIMARY_ENV_KEY[platform]];
  const effective = envValue ?? primaryStoredValue(platform, store);
  if (!effective) return { present: false, source: "none" };
  return { present: true, source: envValue != null ? "environment" : "stored" };
}

// Describes each platform's credential state without touching the network or a
// browser session: absent credentials map to missing_credentials, an unreadable
// store maps to the transient credential_lookup_failed, and a present credential
// stays "checking" until a live probe (adapter.checkAuthHealth) confirms it.
export function describeCredentialHealth(authDir: string, env: NodeJS.ProcessEnv = process.env): Record<Platform, LocalCredentialHealth> {
  const { store, lookupFailed } = readStoreDetailed(join(authDir, CREDENTIALS_FILE));
  const describe = (platform: Platform): LocalCredentialHealth => {
    const { present, source } = credentialPresence(platform, store, env);
    if (present) return { present: true, source, status: "checking" };
    if (lookupFailed) return { present: false, source, status: "unavailable", reasonCode: "credential_lookup_failed" };
    return { present: false, source, status: "missing_credentials", reasonCode: "credentials_missing" };
  };
  return { twitch: describe("twitch"), kick: describe("kick") };
}

// Bridges the CLI-local credential reading to the engine's pre-probe gate: an
// unreadable store is transiently unavailable, an absent credential is missing,
// and a present credential is available (the live probe still validates it).
export function credentialAvailabilityOf(health: LocalCredentialHealth): CredentialAvailability {
  if (health.status === "unavailable") return { status: "unavailable" };
  if (!health.present) return { status: "missing" };
  return { status: "available" };
}
