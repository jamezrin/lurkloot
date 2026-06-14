#!/usr/bin/env -S node --import tsx
import type { Platform } from "@stream-autopilot/shared/models";
import { setTwitchIntegrity } from "@stream-autopilot/core/tabs";
import { loadConfig } from "./config";
import { applyEnvOverrides, AuthStore } from "./authStore";
import { runTwitchDeviceFlow } from "./auth/twitchDeviceFlow";
import { createHttpAdapters } from "./transport/http";
import { registerConsoleLogger } from "./logger";
import { runLoop } from "./runtime/run";

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

  stream-autopilot discover [--config <path>]
      Run one discovery pass per enabled platform (http transport) and print the
      campaigns found. Uses credentials from the auth dir.

  stream-autopilot run [--config <path>]
      Start the full farming loop (discovery + watch heartbeats) until stopped.

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

async function discover(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig(configPath(flags));
  registerConsoleLogger(config.settings.enabledLogLevels);

  const store = new AuthStore(config.authDir);
  const credentials = applyEnvOverrides(await store.loadCredentials());
  // Prime the captured integrity token (claims need it; discovery does not, but
  // this keeps a later claim in the same process best-effort ready).
  const integrity = await store.loadIntegrity();
  if (integrity) setTwitchIntegrity(integrity);

  if (config.transport !== "http") {
    throw new Error(`The "${config.transport}" transport is not implemented yet; use transport: "http" for now.`);
  }
  const adapters = createHttpAdapters(credentials);

  const enabled = (["twitch", "kick"] as Platform[]).filter((platform) => config.settings.platform[platform].enabled);
  if (enabled.length === 0) {
    console.log("No platforms enabled in config.settings.platform.*.enabled");
    return;
  }

  for (const platform of enabled) {
    console.log(`\n=== ${platform} ===`);
    if (platform === "twitch" && !credentials.twitch) {
      console.log("  (no twitch credentials; run `login --twitch-device` first — results will be anonymous/empty)");
    }
    try {
      const campaigns = await adapters[platform].discoverCampaigns();
      console.log(`  ${campaigns.length} campaign(s) discovered`);
      for (const campaign of campaigns.slice(0, 20)) {
        const rewards = campaign.rewards.map((reward) => reward.status).join(",");
        console.log(`  • ${campaign.name} [${campaign.status}] rewards: ${rewards || "none"}`);
      }
      if (campaigns.length > 20) console.log(`  …and ${campaigns.length - 20} more`);
    } catch (error) {
      console.error(`  ${platform} discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    case "discover":
      await discover(flags);
      break;
    case "run":
      await runLoop(await loadConfig(configPath(flags)));
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
