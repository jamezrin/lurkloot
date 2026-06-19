#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import yargs, { type Argv, type ArgumentsCamelCase, type CommandModule } from "yargs";
import { hideBin } from "yargs/helpers";
import type { Platform } from "@lurkloot/shared/models";
import { KickWafBlockedError } from "@lurkloot/core/tabs";
import { loadConfig, TRANSPORTS, type CliConfig, type Transport } from "./config";
import { forgetCredentials, hasKickAuth, hasTwitchAuth, loadCredentials } from "./authStore";
import { createTransport, type EnabledPlatforms } from "./transport";
import { runLoop } from "./runtime/run";
import { importCredentials } from "./auth/importCredentials";
import { twitchDeviceLogin } from "./auth/twitchDeviceFlow";
import { kickDeviceLogin } from "./auth/kickDeviceFlow";
import { createLogger } from "./logger";
import type { LogLevel } from "@lurkloot/shared/logging";

// Global options carried by every command (yargs makes them inheritable), so the
// handlers below read them straight off argv.
function loggerOf(argv: ArgumentsCamelCase): ReturnType<typeof createLogger> {
  return createLogger((argv.log as LogLevel | undefined) ?? "info");
}
function configOf(argv: ArgumentsCamelCase): CliConfig {
  return loadConfig((argv.config as string | undefined) ?? "config.json");
}

function resolveTransport(config: CliConfig, override?: string): Transport {
  // yargs `choices` already rejects bad values, but discover/run can also fall
  // back to the configured transport when none is passed.
  return (override as Transport | undefined) ?? config.transport;
}

function enabledPlatforms(config: CliConfig): EnabledPlatforms {
  return {
    twitch: config.settings.platform.twitch.enabled,
    kick: config.settings.platform.kick.enabled,
  };
}

function statePath(stateArg: string | undefined, config: CliConfig): string {
  if (stateArg) return resolve(process.cwd(), stateArg);
  return join(dirname(config.configPath), "state.json");
}

const validateConfigCommand: CommandModule = {
  command: "validate-config",
  describe: "Load + normalize the config and print the effective settings",
  handler: (argv) => {
    const config = configOf(argv);
    process.stdout.write(`${JSON.stringify({ transport: config.transport, authDir: config.authDir, settings: config.settings }, null, 2)}\n`);
  },
};

const discoverCommand: CommandModule = {
  command: "discover",
  describe: "Run one discovery pass per enabled platform",
  builder: (y) => y.option("transport", { type: "string", choices: TRANSPORTS, describe: "Override the config transport" }),
  handler: async (argv) => {
    const logger = loggerOf(argv);
    const config = configOf(argv);
    const transport = resolveTransport(config, argv.transport as string | undefined);
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
  },
};

const runCommand: CommandModule = {
  command: "run",
  describe: "Full farming loop until SIGINT/SIGTERM",
  builder: (y) => y
    .option("transport", { type: "string", choices: TRANSPORTS, describe: "Override the config transport" })
    .option("state", { type: "string", describe: "State file (default: <configDir>/state.json)" })
    .option("once", { type: "boolean", default: false, describe: "Run a single tick, then exit" }),
  handler: async (argv) => {
    const logger = loggerOf(argv);
    const config = configOf(argv);
    const transport = resolveTransport(config, argv.transport as string | undefined);
    const creds = loadCredentials(config.authDir);
    const handle = await createTransport(transport, creds, config.authDir, enabledPlatforms(config));
    await runLoop({
      settings: config.settings,
      statePath: statePath(argv.state as string | undefined, config),
      transport: handle,
      logger,
      once: Boolean(argv.once),
    });
  },
};

// `auth <platform> device-login | logout` — declared explicitly per platform so
// each verb gets its own --help entry and shows up in shell completion.
function platformAuthCommand(platform: "twitch" | "kick"): CommandModule {
  const loginBrief = platform === "twitch" ? "Twitch device-code OAuth (no browser)" : "Kick smart-TV link flow (no browser)";
  return {
    command: platform,
    describe: `Manage ${platform} credentials`,
    builder: (y) => y
      .command({
        command: "device-login",
        describe: loginBrief,
        handler: async (argv) => {
          const logger = loggerOf(argv);
          const { authDir } = configOf(argv);
          if (platform === "twitch") await twitchDeviceLogin(authDir, logger);
          else await kickDeviceLogin(authDir, logger);
        },
      })
      .command({
        command: "logout",
        describe: `Forget stored ${platform} credentials`,
        handler: (argv) => {
          const logger = loggerOf(argv);
          const { authDir } = configOf(argv);
          const forgotten = forgetCredentials(authDir, platform);
          logger.info(forgotten ? `Forgot stored ${platform} credentials` : `No stored ${platform} credentials to forget`, "auth");
          // The on-disk store is gone, but loadCredentials still layers SA_* env
          // overrides on top — flag that so "logged out" is not misleading.
          const remaining = loadCredentials(authDir);
          if (platform === "twitch" ? hasTwitchAuth(remaining) : hasKickAuth(remaining)) {
            logger.warn(`${platform} is still authenticated via an SA_* env override; unset it to fully log out`, "auth");
          }
        },
      })
      .demandCommand(1, "Specify a verb: device-login or logout")
      .strict(),
    handler: () => { /* a subcommand always runs; see demandCommand above */ },
  };
}

const authCommand: CommandModule = {
  command: "auth",
  describe: "Manage stored credentials",
  builder: (y) => y
    .command({
      command: "import <file>",
      describe: 'Import an extension credential export ("-" = stdin)',
      builder: (yy) => yy.positional("file", { type: "string", describe: "Export file, or - to read stdin", demandOption: true }),
      handler: (argv) => {
        const logger = loggerOf(argv);
        const { authDir } = configOf(argv);
        // yargs-parser renders a bare "-" positional as "" — restore the stdin sentinel.
        const file = argv.file === "" ? "-" : String(argv.file);
        const creds = importCredentials(authDir, file);
        logger.info(`Imported credentials${creds.twitch?.authToken ? " (twitch)" : ""}${creds.kick?.sessionToken ? " (kick)" : ""} into ${authDir}`, "auth");
      },
    })
    .command(platformAuthCommand("twitch"))
    .command(platformAuthCommand("kick"))
    .command({
      command: "status",
      describe: "Report which credentials are available",
      handler: (argv) => {
        const { authDir } = configOf(argv);
        const creds = loadCredentials(authDir);
        process.stdout.write(`${JSON.stringify({
          authDir,
          twitch: { authToken: hasTwitchAuth(creds), deviceId: Boolean(creds.twitch?.deviceId) },
          kick: { sessionToken: hasKickAuth(creds) },
        }, null, 2)}\n`);
      },
    })
    .demandCommand(1, "Specify an auth subcommand (import | twitch | kick | status)")
    .strict(),
  handler: () => { /* a subcommand always runs; see demandCommand above */ },
};

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

function buildCli(argv: string[]): Argv {
  return yargs(argv)
    .scriptName("lurkloot")
    .usage("$0 <command> [options]")
    .option("config", { type: "string", default: "config.json", describe: "Config file", global: true })
    .option("log", { type: "string", choices: ["debug", "info", "warn", "error"], default: "info", describe: "Log level", global: true })
    .command(validateConfigCommand)
    .command(discoverCommand)
    .command(runCommand)
    .command(authCommand)
    .demandCommand(1, "Specify a command (run with --help to list them)")
    .strict()
    .completion("completion", "Print a shell-completion script (eval it in bash/zsh)")
    .alias("h", "help")
    .help()
    .wrap(Math.min(110, process.stdout.columns ?? 110));
}

buildCli(hideBin(process.argv))
  .parseAsync()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
