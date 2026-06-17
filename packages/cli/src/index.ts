#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import type { Platform } from "@lurkloot/shared/models";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { loadConfig, TRANSPORTS, type CliConfig, type Transport } from "./config";
import { hasKickAuth, hasTwitchAuth, loadCredentials } from "./authStore";
import { createTransport, type EnabledPlatforms } from "./transport";
import { runLoop } from "./runtime/run";
import { importCredentials } from "./auth/importCredentials";
import { twitchDeviceLogin } from "./auth/twitchDeviceFlow";
import { browserLogin } from "./auth/browserLogin";
import { createLogger } from "./logger";
import type { LogLevel } from "@lurkloot/shared/logging";

interface Args {
  command: string;
  rest: string[];
  config: string;
  transport?: string;
  state?: string;
  once: boolean;
  logLevel: LogLevel;
  importFile?: string;
  twitchDevice: boolean;
  twitchOnly: boolean;
  kickOnly: boolean;
}

const USAGE = `lurkloot <command> [options]

Commands:
  validate-config   Load + normalize the config and print the effective settings
  discover          Run one discovery pass per enabled platform
  run               Full farming loop until SIGINT/SIGTERM
  login             Sign in and store credentials (see login options)
  auth status       Report which credentials are available

Options:
  --config <path>   Config file (default: ./config.json)
  --transport <t>   Override config transport (${TRANSPORTS.join(" | ")})
  --state <path>    State file (default: <configDir>/state.json)
  --once            run: a single tick, then exit
  --log <level>     debug | info | warn | error (default: info)

login options:
  --import <file>   Import an extension-exported credential blob ("-" = stdin)
  --twitch-device   Twitch device-code OAuth (no browser)
  --twitch-only     Browser login: Twitch only
  --kick-only       Browser login: Kick only
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "", rest: [], config: "config.json", once: false, logLevel: "info",
    twitchDevice: false, twitchOnly: false, kickOnly: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--config": args.config = argv[++i]; break;
      case "--transport": args.transport = argv[++i]; break;
      case "--state": args.state = argv[++i]; break;
      case "--once": args.once = true; break;
      case "--log": args.logLevel = argv[++i] as LogLevel; break;
      case "--import": args.importFile = argv[++i]; break;
      case "--twitch-device": args.twitchDevice = true; break;
      case "--twitch-only": args.twitchOnly = true; break;
      case "--kick-only": args.kickOnly = true; break;
      case "-h": case "--help": positional.push("help"); break;
      default: positional.push(arg);
    }
  }
  args.command = positional[0] ?? "";
  args.rest = positional.slice(1);
  return args;
}

function resolveTransport(config: CliConfig, override?: string): Transport {
  if (!override) return config.transport;
  if (!TRANSPORTS.includes(override as Transport)) {
    throw new Error(`Unknown --transport "${override}"; expected one of: ${TRANSPORTS.join(", ")}`);
  }
  return override as Transport;
}

function enabledPlatforms(config: CliConfig): EnabledPlatforms {
  return {
    twitch: config.settings.platform.twitch.enabled,
    kick: config.settings.platform.kick.enabled,
  };
}

function statePath(args: Args, config: CliConfig): string {
  if (args.state) return resolve(process.cwd(), args.state);
  return join(dirname(config.configPath), "state.json");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger(args.logLevel);

  if (!args.command || args.command === "help") {
    process.stdout.write(USAGE);
    return args.command ? 0 : 1;
  }

  if (args.command === "validate-config") {
    const config = loadConfig(args.config);
    process.stdout.write(`${JSON.stringify({ transport: config.transport, authDir: config.authDir, settings: config.settings }, null, 2)}\n`);
    return 0;
  }

  if (args.command === "login") {
    const config = loadConfig(args.config);
    if (args.importFile) {
      const creds = importCredentials(config.authDir, args.importFile);
      logger.info(`Imported credentials${creds.twitch?.authToken ? " (twitch)" : ""}${creds.kick?.sessionToken ? " (kick)" : ""} into ${config.authDir}`, "login");
      return 0;
    }
    if (args.twitchDevice) {
      await twitchDeviceLogin(config.authDir, logger);
      return 0;
    }
    await browserLogin(config.authDir, { twitchOnly: args.twitchOnly, kickOnly: args.kickOnly }, logger);
    return 0;
  }

  if (args.command === "auth") {
    if (args.rest[0] !== "status") {
      logger.error(`Unknown auth subcommand "${args.rest[0] ?? ""}"; expected: auth status`);
      return 1;
    }
    const config = loadConfig(args.config);
    const creds = loadCredentials(config.authDir);
    process.stdout.write(`${JSON.stringify({
      authDir: config.authDir,
      twitch: { authToken: hasTwitchAuth(creds), deviceId: Boolean(creds.twitch?.deviceId) },
      kick: { sessionToken: hasKickAuth(creds) },
    }, null, 2)}\n`);
    return 0;
  }

  if (args.command === "discover") {
    const config = loadConfig(args.config);
    const transport = resolveTransport(config, args.transport);
    const creds = loadCredentials(config.authDir);
    const enabled = enabledPlatforms(config);
    const handle = await createTransport(transport, creds, config.authDir, enabled);
    try {
      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (!enabled[platform]) {
          logger.info("disabled in config — skipping", platform);
          continue;
        }
        await discoverPlatform(platform, handle.adapters[platform], logger);
      }
    } finally {
      await handle.dispose();
    }
    return 0;
  }

  if (args.command === "run") {
    const config = loadConfig(args.config);
    const transport = resolveTransport(config, args.transport);
    const creds = loadCredentials(config.authDir);
    const handle = await createTransport(transport, creds, config.authDir, enabledPlatforms(config));
    await runLoop({
      settings: config.settings,
      statePath: statePath(args, config),
      transport: handle,
      logger,
      once: args.once,
    });
    return 0;
  }

  logger.error(`Unknown command "${args.command}"`);
  process.stdout.write(USAGE);
  return 1;
}

async function discoverPlatform(platform: Platform, adapter: { discoverCampaigns(): Promise<{ name: string }[]> }, logger: ReturnType<typeof createLogger>): Promise<void> {
  try {
    const campaigns = await adapter.discoverCampaigns();
    logger.info(`discovered ${campaigns.length} campaign(s)`, platform);
    for (const campaign of campaigns.slice(0, 20)) logger.info(`• ${campaign.name}`, platform);
  } catch (error) {
    if (error instanceof KickWafBlockedError) {
      logger.warn(`Cloudflare WAF blocked the request (HTTP 403). Use the "impersonate" transport to reach Kick without a browser. (${error.message})`, platform);
      return;
    }
    logger.error(error instanceof Error ? error.message : String(error), platform);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
