import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mergeSettings } from "@lurkloot/shared/settings";
import type { ExtensionSettings } from "@lurkloot/shared/models";

export const TRANSPORTS = ["http", "impersonate", "browser"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface CliConfig {
  transport: Transport;
  // Absolute, resolved relative to the config file's directory.
  authDir: string;
  settings: ExtensionSettings;
  configPath: string;
}

interface RawConfig {
  transport?: string;
  authDir?: string;
  settings?: Partial<ExtensionSettings>;
}

// Builds a validated config from already-parsed JSON. Only `transport` and
// `authDir` are CLI-specific; `settings` is the extension's ExtensionSettings
// model verbatim, normalized through the shared mergeSettings so defaults and
// validation match the extension. Credentials never live here (see authStore).
export function parseConfig(raw: unknown, configPath: string): CliConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config must be a JSON object");
  }
  const data = raw as RawConfig;
  const transport = data.transport ?? "http";
  if (!TRANSPORTS.includes(transport as Transport)) {
    throw new Error(`Unknown transport "${transport}"; expected one of: ${TRANSPORTS.join(", ")}`);
  }
  const authDir = resolve(dirname(configPath), data.authDir ?? "auth");
  return {
    transport: transport as Transport,
    authDir,
    settings: mergeSettings(data.settings),
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
