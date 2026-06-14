import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TwitchIntegrity } from "@stream-autopilot/core/twitchIntegrity";

// Where a credential came from, for diagnostics in `auth status`.
export type CredentialSource = "login" | "extension-export" | "device-flow" | "manual";

export interface TwitchCredentials {
  authToken: string;
  deviceId?: string;
  // The Client-ID the authToken was issued for. Web-session tokens use the web
  // client id (left undefined → adapter default); device-flow tokens carry their
  // own and MUST send it on GQL.
  clientId?: string;
  source: CredentialSource;
  obtainedAt: string;
}

export interface KickCredentials {
  sessionToken: string;
  source: CredentialSource;
  obtainedAt: string;
}

export interface PlatformCredentials {
  twitch?: TwitchCredentials;
  kick?: KickCredentials;
}

const CREDENTIALS_FILE = "credentials.json";
const INTEGRITY_FILE = "twitch-integrity.json";
/** Persistent Playwright profile dir for the browser transport / browser login. */
export const BROWSER_PROFILE_DIR = "browser-profile";

export class AuthStore {
  constructor(private readonly dir: string) {}

  get browserProfileDir(): string {
    return join(this.dir, BROWSER_PROFILE_DIR);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, file), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read ${file} in ${this.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.ensureDir();
    await writeFile(join(this.dir, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async loadCredentials(): Promise<PlatformCredentials> {
    return (await this.readJson<PlatformCredentials>(CREDENTIALS_FILE)) ?? {};
  }

  async saveCredentials(credentials: PlatformCredentials): Promise<void> {
    await this.writeJson(CREDENTIALS_FILE, credentials);
  }

  async updateTwitch(twitch: TwitchCredentials): Promise<PlatformCredentials> {
    const next = { ...(await this.loadCredentials()), twitch };
    await this.saveCredentials(next);
    return next;
  }

  async updateKick(kick: KickCredentials): Promise<PlatformCredentials> {
    const next = { ...(await this.loadCredentials()), kick };
    await this.saveCredentials(next);
    return next;
  }

  async loadIntegrity(): Promise<TwitchIntegrity | undefined> {
    return this.readJson<TwitchIntegrity>(INTEGRITY_FILE);
  }

  async saveIntegrity(value: TwitchIntegrity): Promise<void> {
    await this.writeJson(INTEGRITY_FILE, value);
  }
}

// Env vars override the stored credentials (Docker-secrets path, and the manual
// escape hatch). A token supplied this way is reported as source "manual".
export function applyEnvOverrides(credentials: PlatformCredentials, env: NodeJS.ProcessEnv = process.env): PlatformCredentials {
  const next: PlatformCredentials = { ...credentials };
  const now = new Date().toISOString();

  const twitchToken = env.SA_TWITCH_AUTH_TOKEN;
  if (twitchToken) {
    next.twitch = {
      authToken: twitchToken,
      deviceId: env.SA_TWITCH_DEVICE_ID ?? next.twitch?.deviceId,
      clientId: env.SA_TWITCH_CLIENT_ID ?? next.twitch?.clientId,
      source: "manual",
      obtainedAt: now,
    };
  }

  const kickToken = env.SA_KICK_SESSION_TOKEN;
  if (kickToken) {
    next.kick = { sessionToken: kickToken, source: "manual", obtainedAt: now };
  }

  return next;
}
