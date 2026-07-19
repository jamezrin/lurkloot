import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfigJsonc, loadConfig, parseConfig } from "../src/config";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";

const CONFIG_PATH = "/tmp/lurkloot/config.json";
const CLI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(CLI_PACKAGE_DIR, "dist/index.mjs");
const LEGACY_WARNING = "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error";

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: CLI_PACKAGE_DIR, stdio: "pipe" });
});

function runCli(configPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args, "--config", configPath], {
    cwd: CLI_PACKAGE_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      SA_TWITCH_AUTH_TOKEN: undefined,
      SA_TWITCH_DEVICE_ID: undefined,
      SA_KICK_SESSION_TOKEN: undefined,
    },
  });
}

function writeLegacyConfig(dir: string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    transport: "http",
    settings: {
      enabledLogLevels: ["error"],
      platform: {
        twitch: { enabled: false },
        kick: { enabled: false },
      },
    },
  }));
  return path;
}

describe("parseConfig", () => {
  it("defaults to the impersonate transport and <configDir>/auth", () => {
    const config = parseConfig({}, CONFIG_PATH);
    expect(config.transport).toBe("impersonate");
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "auth"));
  });

  it("resolves authDir relative to the config file directory", () => {
    const config = parseConfig({ authDir: "creds" }, CONFIG_PATH);
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "creds"));
  });

  it("merges settings over the CLI defaults", () => {
    const config = parseConfig({ settings: { pollIntervalMinutes: 7 } }, CONFIG_PATH);
    expect(config.settings.pollIntervalMinutes).toBe(7);
    // A field left out of the config still gets its default.
    expect(typeof config.settings.autoClaim).toBe("boolean");
    expect(config.settings.platform.twitch).toBeDefined();
  });

  it("warns once when enabledLogLevels is present", () => {
    const config = parseConfig({ settings: { enabledLogLevels: ["error"] } }, CONFIG_PATH);
    expect(config.warnings).toEqual([
      "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error",
    ]);
  });

  it("has no config warnings by default", () => {
    expect(parseConfig({}, CONFIG_PATH).warnings).toEqual([]);
  });

  it("surfaces credential-safe compatibility resolver warnings", () => {
    const config = parseConfig({
      settings: { compatibility: { twitch: { profile: "secret-unknown-profile" } } },
    }, CONFIG_PATH);

    expect(config.warnings).toEqual([
      "Unknown Twitch profile compatibility selection; using twitch-2026-07",
    ]);
    expect(config.warnings.join(" ")).not.toContain("secret-unknown-profile");
  });

  it("defers identity-specific Twitch compatibility warnings until credentials are loaded", () => {
    const config = parseConfig({
      settings: { compatibility: { twitch: { heartbeatTransport: "twitch-heartbeat-trowel-v1" } } },
    }, CONFIG_PATH);

    expect(config.warnings).toEqual([]);
  });

  it("rejects extension-only settings copied from the browser config", () => {
    expect(() => parseConfig({ settings: { adFocusMode: "window" } }, CONFIG_PATH)).toThrow(/extension-only/);
  });

  it("rejects diagnosticLogging as extension-only", () => {
    expect(() => parseConfig({ settings: { diagnosticLogging: true } }, CONFIG_PATH)).toThrow(/extension-only/);
  });

  it("rejects an unknown top-level config key", () => {
    expect(() => parseConfig({ credentials: {} }, CONFIG_PATH)).toThrow(/Unknown config key/);
  });

  it("accepts every known transport", () => {
    for (const transport of ["http", "impersonate"] as const) {
      expect(parseConfig({ transport }, CONFIG_PATH).transport).toBe(transport);
    }
  });

  it("rejects the retired browser transport", () => {
    expect(() => parseConfig({ transport: "browser" }, CONFIG_PATH)).toThrow(/Unknown transport/);
  });

  it("rejects an unknown transport", () => {
    expect(() => parseConfig({ transport: "carrier-pigeon" }, CONFIG_PATH)).toThrow(/Unknown transport/);
  });

  it("rejects a non-object config", () => {
    expect(() => parseConfig([], CONFIG_PATH)).toThrow(/must be a JSON object/);
    expect(() => parseConfig(null, CONFIG_PATH)).toThrow(/must be a JSON object/);
  });
});

describe("loadConfig", () => {
  it("creates and loads a documented default JSONC config when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "nested", "config.json");
      const config = loadConfig(path);
      const generated = readFileSync(path, "utf8");

      expect(generated).toContain("// Credentials are stored separately");
      expect(generated).toContain('"transport": "impersonate"');
      expect(generated).toContain("Compatibility identifiers are bundled");
      expect(generated).toContain("Raw destinations and hashes cannot be supplied");
      expect(generated).toContain('"heartbeatTransport": "auto"');
      expect(generated).toContain('"inventoryQueryVersion": "auto"');
      expect(generated).toContain('"claimLinkHandling": "auto"');
      expect(config.transport).toBe("impersonate");
      expect(config.authDir).toBe(join(dir, "nested", "auth"));
      expect(config.settings).toEqual(DEFAULT_CLI_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts comments and trailing commas in an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.jsonc");
      writeFileSync(path, `{
        // Kick-compatible transport
        "transport": "impersonate",
        "settings": {
          "pollIntervalMinutes": 7,
        },
      }`);

      expect(loadConfig(path).settings.pollIntervalMinutes).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a useful location for malformed JSONC", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{\n  \"transport\":,\n}\n");
      expect(() => loadConfig(path)).toThrow(/not valid JSONC: .*line 2, column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the generated template aligned with runtime defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, defaultConfigJsonc());
      expect(defaultConfigJsonc()).toContain('"skipUnfinishableRewards": true');
      expect(defaultConfigJsonc()).toContain("0 uses exact feasibility; 1-60 adds a safety buffer.");
      expect(defaultConfigJsonc()).toContain('"deadlineSafetyMarginMinutes": 5');
      expect(loadConfig(path).settings).toEqual(DEFAULT_CLI_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents the post-claim handoff settings in the template", () => {
    // The round-trip above merges defaults, so an omitted key would still pass
    // there. Assert the template itself carries them, with the rendered values.
    const template = defaultConfigJsonc();
    expect(template).toContain(`"postClaimHandoff": ${DEFAULT_CLI_SETTINGS.postClaimHandoff}`);
    expect(template).toContain(`"postClaimHandoffIntervalSeconds": ${DEFAULT_CLI_SETTINGS.postClaimHandoffIntervalSeconds}`);
    expect(template).toContain(`"postClaimHandoffMaxSeconds": ${DEFAULT_CLI_SETTINGS.postClaimHandoffMaxSeconds}`);
  });
});

describe("CLI config warning integration", () => {
  it.each([
    ["validate-config", ["validate-config"]],
    ["discover", ["discover"]],
    ["run once", ["run", "--once"]],
    ["auth status", ["auth", "status"]],
  ])("emits the legacy warning exactly once for %s", (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.split(LEGACY_WARNING)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters the legacy warning at --log error", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), ["validate-config", "--log", "error"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain(LEGACY_WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps validate-config stdout as valid JSON while warning on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "lurkloot-command-"));
    try {
      const result = runCli(writeLegacyConfig(dir), ["validate-config"]);
      expect(result.status, result.stderr).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({ transport: "http" });
      expect(result.stdout).not.toContain(LEGACY_WARNING);
      expect(result.stderr).toContain(LEGACY_WARNING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
