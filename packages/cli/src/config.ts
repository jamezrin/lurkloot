import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCliSettings, type CliSettings } from "./settings";

export const TRANSPORTS = ["http", "impersonate"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface CliConfig {
  transport: Transport;
  // Absolute, resolved relative to the config file's directory.
  authDir: string;
  settings: CliSettings;
  configPath: string;
}

const CONFIG_KEYS = new Set<string>(["transport", "authDir", "settings"]);

// Builds a validated config from already-parsed JSON. `transport` and `authDir`
// are CLI-specific; `settings` is the CLI's own settings schema (see settings.ts)
// — decoupled from the extension's ExtensionSettings and strict about unknown or
// extension-only keys. Credentials never live here (see authStore).
export function parseConfig(raw: unknown, configPath: string): CliConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config must be a JSON object");
  }
  const data = raw as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown config ${unknown.length === 1 ? "key" : "keys"}: ${unknown.map((k) => `"${k}"`).join(", ")}; expected one of: ${[...CONFIG_KEYS].join(", ")}`);
  }
  const transport = (data.transport as string | undefined) ?? "http";
  if (!TRANSPORTS.includes(transport as Transport)) {
    throw new Error(`Unknown transport "${transport}"; expected one of: ${TRANSPORTS.join(", ")}`);
  }
  const authDir = resolve(dirname(configPath), (data.authDir as string | undefined) ?? "auth");
  return {
    transport: transport as Transport,
    authDir,
    settings: parseCliSettings(data.settings),
    configPath,
  };
}

export function loadConfig(configPath: string): CliConfig {
  const absolute = resolve(process.cwd(), configPath);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new Error(`Could not read config at ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Config at ${absolute} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw, absolute);
}
