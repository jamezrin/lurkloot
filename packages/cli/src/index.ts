#!/usr/bin/env -S node --import tsx
import { loadConfig } from "./config";
import { applyEnvOverrides, AuthStore } from "./authStore";
import { runTwitchDeviceFlow } from "./auth/twitchDeviceFlow";

interface ParsedArgs {
  command: string;
  subcommand?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? "help", subcommand: positionals[1], flags };
}

function configPath(flags: Record<string, string | boolean>): string {
  const value = flags.config;
  return typeof value === "string" ? value : "config.json";
}

const HELP = `stream-autopilot — headless drops farming CLI

Usage:
  stream-autopilot validate-config [--config <path>]
      Load and normalize the config file; print the effective settings.

  stream-autopilot auth status [--config <path>]
      Show which platform credentials are present and the Twitch integrity expiry.

  stream-autopilot login --twitch-device [--config <path>] [--client-id <id>] [--scopes <s>]
      Twitch device-code OAuth: shows a code to enter at the verification URL,
      then stores the resulting token in the auth dir.

Options:
  --config <path>   Path to the JSON config (default: ./config.json)
`;

async function validateConfig(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig(configPath(flags));
  const { settings } = config;
  console.log(`Config OK: ${config.path}`);
  console.log(`  transport:       ${config.transport}`);
  console.log(`  authDir:         ${config.authDir}`);
  console.log(`  running:         ${settings.running}`);
  console.log(`  tablessMode:     ${settings.tablessMode}`);
  console.log(`  pollInterval:    ${settings.pollIntervalMinutes} min`);
  console.log(`  priorityMode:    ${settings.priorityMode}`);
  for (const platform of ["twitch", "kick"] as const) {
    const p = settings.platform[platform];
    console.log(`  ${platform}: enabled=${p.enabled} farmAllCategories=${p.farmAllCategories} watchQueue=${p.watchQueueChannels.length} categories=${p.categories.length}`);
  }
}

async function authStatus(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig(configPath(flags));
  const store = new AuthStore(config.authDir);
  const credentials = applyEnvOverrides(await store.loadCredentials());
  console.log(`Auth store: ${config.authDir}`);

  if (credentials.twitch) {
    const { source, deviceId, clientId } = credentials.twitch;
    console.log(`  twitch: present (source=${source}${clientId ? `, clientId=${clientId}` : ""}${deviceId ? ", deviceId set" : ""})`);
  } else {
    console.log("  twitch: missing — run `login --twitch-device` or `login --import`");
  }

  if (credentials.kick) {
    console.log(`  kick:   present (source=${credentials.kick.source})`);
  } else {
    console.log("  kick:   missing — run `login` (browser-assisted) or `login --import`");
  }

  const integrity = await store.loadIntegrity();
  if (integrity) {
    const remaining = Math.round((integrity.expiresAt - Date.now()) / 1000);
    console.log(`  twitch integrity: ${remaining > 0 ? `valid (${remaining}s left)` : "expired"}`);
  } else {
    console.log("  twitch integrity: none captured (claims may fail under the http transport)");
  }
}

async function login(flags: Record<string, string | boolean>): Promise<void> {
  if (!flags["twitch-device"]) {
    throw new Error("Only `login --twitch-device` is implemented so far. Browser-assisted login and --import are coming next.");
  }
  const config = await loadConfig(configPath(flags));
  const store = new AuthStore(config.authDir);
  const result = await runTwitchDeviceFlow({
    clientId: typeof flags["client-id"] === "string" ? (flags["client-id"] as string) : undefined,
    scopes: typeof flags.scopes === "string" ? (flags.scopes as string) : undefined,
    onPrompt: (info) => {
      console.log("\nTo authorize, open this URL and enter the code:");
      console.log(`  URL:  ${info.verification_uri}`);
      console.log(`  Code: ${info.user_code}`);
      console.log(`\nWaiting for authorization (expires in ${info.expires_in}s)...`);
    },
  });
  await store.updateTwitch({
    authToken: result.accessToken,
    clientId: result.clientId,
    source: "device-flow",
    obtainedAt: new Date().toISOString(),
  });
  console.log(`\n✔ Twitch token stored in ${config.authDir}/credentials.json (clientId=${result.clientId}).`);
  console.log("Run `stream-autopilot auth status` to confirm.");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "validate-config":
      await validateConfig(flags);
      break;
    case "auth":
      // `auth status` — the only auth subcommand for now.
      await authStatus(flags);
      break;
    case "login":
      await login(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
