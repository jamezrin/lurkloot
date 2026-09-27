import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { saveCredentials, type PlatformCredentials } from "../authStore";

interface CredentialBlob {
  // The canonical extension export: { version, credentials: { twitch, kick } }.
  version?: number;
  credentials?: PlatformCredentials;
}

// Parses an extension-exported credential blob from a file (or stdin when the
// source is "-"). Accepts only the canonical { version, credentials } shape.
export function readCredentialBlob(source: string): PlatformCredentials {
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(process.cwd(), source), "utf8");
  let parsed: CredentialBlob;
  try {
    parsed = JSON.parse(text) as CredentialBlob;
  } catch (error) {
    throw new Error(`Credential blob is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const creds = parsed.credentials;
  if (!creds || typeof creds !== "object") {
    throw new Error('Credential blob is missing a "credentials" object (expected an extension export)');
  }
  if (!creds.twitch?.authToken && !creds.kick?.sessionToken) {
    throw new Error("Credential blob has no Twitch auth token or Kick session token");
  }
  return {
    twitch: creds.twitch ? { ...creds.twitch } : undefined,
    kick: creds.kick ? { ...creds.kick } : undefined,
  };
}

export function importCredentials(authDir: string, source: string): { credentials: PlatformCredentials; ignoredTwitch: boolean } {
  const creds = readCredentialBlob(source);
  // The extension exports a web-session token without its OAuth Client-ID.
  // Guessing the CLI's Smart TV ID would create a mismatched authorization
  // header, and the web identity cannot discover campaigns without integrity.
  const ignoredTwitch = Boolean(creds.twitch?.authToken && !creds.twitch.clientId);
  if (ignoredTwitch && !creds.kick?.sessionToken) {
    throw new Error("A browser Twitch token cannot be used by the headless CLI; run auth twitch device-login instead");
  }
  const credentials = { ...creds, twitch: ignoredTwitch ? undefined : creds.twitch };
  saveCredentials(authDir, credentials);
  return { credentials, ignoredTwitch };
}
