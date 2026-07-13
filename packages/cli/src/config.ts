import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { DEFAULT_CLI_SETTINGS, parseCliSettings, type CliSettings } from "./settings";

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

function json(value: unknown): string {
  return JSON.stringify(value);
}

// The generated file is intentionally verbose: it doubles as the complete CLI
// settings reference while remaining safe to edit as JSONC. Values are read
// from DEFAULT_CLI_SETTINGS so the template cannot silently drift from runtime
// behavior when a shared default changes.
export function defaultConfigJsonc(): string {
  const defaults = DEFAULT_CLI_SETTINGS;
  const twitch = defaults.platform.twitch;
  const kick = defaults.platform.kick;
  return `{
  // "impersonate" works with both Twitch and Kick. Use "http" only for a
  // lighter Twitch-only setup; Kick's API rejects plain Node TLS requests.
  "transport": "impersonate",

  // Credentials are stored separately in this directory, relative to this file.
  "authDir": "auth",

  "settings": {
    // Automatically claim completed drops and Twitch channel-point bonuses.
    "autoClaim": ${json(defaults.autoClaim)},
    "autoClaimChannelPoints": ${json(defaults.autoClaimChannelPoints)},

    // ending_soonest | lowest_availability | priority_list_only
    "priorityMode": ${json(defaults.priorityMode)},
    // Map campaign IDs to numeric priorities; larger numbers are preferred.
    "campaignPriorities": ${json(defaults.campaignPriorities)},
    "excludedCampaignIds": ${json(defaults.excludedCampaignIds)},

    // Prefer explicit watch queues; fall back to discovered eligible channels.
    "watchQueueFallbackOnly": ${json(defaults.watchQueueFallbackOnly)},
    "offlineRetryLimit": ${json(defaults.offlineRetryLimit)},
    // How often campaign discovery and watch state are refreshed (1-60 minutes).
    "pollIntervalMinutes": ${json(defaults.pollIntervalMinutes)},
    "notifyRewardEarned": ${json(defaults.notifyRewardEarned)},
    "notifyNoDropsLeft": ${json(defaults.notifyNoDropsLeft)},

    "platform": {
      "twitch": {
        "enabled": ${json(twitch.enabled)},
        "watchQueueChannels": ${json(twitch.watchQueueChannels)},
        "excludedChannels": ${json(twitch.excludedChannels)},
        "farmAllCategories": ${json(twitch.farmAllCategories)},
        // Used when farmAllCategories is false.
        "categories": ${json(twitch.categories)}
      },
      "kick": {
        "enabled": ${json(kick.enabled)},
        "watchQueueChannels": ${json(kick.watchQueueChannels)},
        "excludedChannels": ${json(kick.excludedChannels)},
        "farmAllCategories": ${json(kick.farmAllCategories)},
        // Used when farmAllCategories is false.
        "categories": ${json(kick.categories)}
      }
    }
  }
}
`;
}

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
  const transport = (data.transport as string | undefined) ?? "impersonate";
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
    if (!isErrno(error, "ENOENT")) {
      throw new Error(`Could not read config at ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, defaultConfigJsonc(), { encoding: "utf8", flag: "wx", mode: 0o644 });
      process.stderr.write(`Created default config at ${absolute}\n`);
    } catch (writeError) {
      // Another process may have initialized the same mounted data directory
      // between our read and write. In that case, keep its file and read it.
      if (!isErrno(writeError, "EEXIST")) {
        throw new Error(`Could not create default config at ${absolute}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
    try {
      text = readFileSync(absolute, "utf8");
    } catch (readError) {
      throw new Error(`Could not read config at ${absolute}: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
  }
  const errors: ParseError[] = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    const before = text.slice(0, first.offset);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const column = first.offset - lastNewline;
    throw new Error(`Config at ${absolute} is not valid JSONC: ${printParseErrorCode(first.error)} at line ${line}, column ${column}`);
  }
  return parseConfig(raw, absolute);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
