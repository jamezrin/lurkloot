import { readFile } from "node:fs/promises";
import type { TwitchIntegrity } from "@stream-autopilot/core/twitchIntegrity";
import { AuthStore } from "../authStore";

// The blob the extension's "Export CLI credentials" action produces. Versioned so
// the importer can reject incompatible shapes.
export interface CliCredentialExport {
  v: 1;
  twitch?: { authToken: string; deviceId?: string; clientId?: string };
  kick?: { sessionToken: string };
  integrity?: TwitchIntegrity;
}

// Reads an export blob (from a file path, or stdin when source is "-") and writes
// it into the auth store. Lets a user who already runs the extension onboard the
// CLI without a fresh login.
export async function importCredentials(authDir: string, source: string): Promise<void> {
  const raw = source === "-" ? await readStdin() : await readFile(source, "utf8");

  let blob: CliCredentialExport;
  try {
    blob = JSON.parse(raw) as CliCredentialExport;
  } catch (error) {
    throw new Error(`Import is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (blob.v !== 1) throw new Error(`Unsupported export version ${String(blob.v)}; expected 1.`);
  if (!blob.twitch && !blob.kick) throw new Error("Import contains no twitch or kick credentials.");

  const store = new AuthStore(authDir);
  const now = new Date().toISOString();
  const credentials = await store.loadCredentials();

  if (blob.twitch?.authToken) {
    credentials.twitch = {
      authToken: blob.twitch.authToken,
      deviceId: blob.twitch.deviceId,
      clientId: blob.twitch.clientId,
      source: "extension-export",
      obtainedAt: now,
    };
    console.log("✔ Imported Twitch credentials.");
  }
  if (blob.kick?.sessionToken) {
    credentials.kick = { sessionToken: blob.kick.sessionToken, source: "extension-export", obtainedAt: now };
    console.log("✔ Imported Kick credentials.");
  }
  await store.saveCredentials(credentials);

  if (blob.integrity?.integrity) {
    await store.saveIntegrity(blob.integrity);
    console.log("✔ Imported Twitch integrity token.");
  }
  console.log(`\nCredentials saved to ${authDir}. Run \`stream-autopilot auth status\` to confirm.`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
