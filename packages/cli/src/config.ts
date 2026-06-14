import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { mergeSettings } from "@stream-autopilot/shared/settings";
import type { ExtensionSettings } from "@stream-autopilot/shared/models";

export type Transport = "http" | "impersonate" | "browser";

// The on-disk config wrapper. `settings` is the extension's ExtensionSettings
// shape verbatim (validated/normalized through the shared mergeSettings), so the
// CLI reuses the exact same settings model and defaults as the extension. Only
// `transport` and `authDir` are CLI-runtime concerns. Credentials never live
// here — they are kept in the auth store (see authStore.ts) so config files can
// be shared/committed without leaking tokens.
export interface CliConfigFile {
  transport?: Transport;
  authDir?: string;
  settings?: Partial<ExtensionSettings>;
}

export interface CliConfig {
  transport: Transport;
  authDir: string;
  settings: ExtensionSettings;
  /** Absolute path the config was loaded from (for diagnostics). */
  path: string;
}

const TRANSPORTS: Transport[] = ["http", "impersonate", "browser"];

export async function loadConfig(configPath: string): Promise<CliConfig> {
  const path = resolve(configPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read config file at ${path}: ${reason}`);
  }

  let parsed: CliConfigFile;
  try {
    parsed = JSON.parse(raw) as CliConfigFile;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Config file at ${path} is not valid JSON: ${reason}`);
  }

  const transport = parsed.transport ?? "browser";
  if (!TRANSPORTS.includes(transport)) {
    throw new Error(`Invalid transport "${transport}" in ${path}; expected one of: ${TRANSPORTS.join(", ")}`);
  }

  // authDir is resolved relative to the config file, not the cwd, so a config and
  // its auth dir travel together.
  const authDirRaw = parsed.authDir ?? "auth";
  const authDir = isAbsolute(authDirRaw) ? authDirRaw : resolve(dirname(path), authDirRaw);

  return {
    transport,
    authDir,
    settings: mergeSettings(parsed.settings),
    path,
  };
}
