import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { saveCredentials, type PlatformCredentials } from "../authStore";

interface CredentialBlob {
  // The extension export wraps credentials in { version, credentials }; a bare
  // PlatformCredentials object is also accepted.
  version?: number;
  credentials?: PlatformCredentials;
  twitch?: PlatformCredentials["twitch"];
  kick?: PlatformCredentials["kick"];
}

// Parses an extension-exported credential blob from a file (or stdin when the
// source is "-"). Tolerant of both the wrapped { credentials } shape and a bare
// { twitch, kick } object.
export function readCredentialBlob(source: string): PlatformCredentials {
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(process.cwd(), source), "utf8");
  let parsed: CredentialBlob;
  try {
    parsed = JSON.parse(text) as CredentialBlob;
  } catch (error) {
    throw new Error(`Credential blob is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const creds = parsed.credentials ?? { twitch: parsed.twitch, kick: parsed.kick };
  if (!creds.twitch?.authToken && !creds.kick?.sessionToken) {
    throw new Error("Credential blob has no Twitch auth token or Kick session token");
  }
  return {
    twitch: creds.twitch ? { ...creds.twitch } : undefined,
    kick: creds.kick ? { ...creds.kick } : undefined,
  };
}

export function importCredentials(authDir: string, source: string): PlatformCredentials {
  const creds = readCredentialBlob(source);
  saveCredentials(authDir, creds);
  return creds;
}
