import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfigJsonc, loadConfig, parseConfig } from "../src/config";
import { DEFAULT_CLI_SETTINGS } from "../src/settings";

const CONFIG_PATH = "/tmp/lurkloot/config.json";

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

  it("rejects extension-only settings copied from the browser config", () => {
    expect(() => parseConfig({ settings: { adFocusMode: "window" } }, CONFIG_PATH)).toThrow(/extension-only/);
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
      expect(loadConfig(path).settings).toEqual(DEFAULT_CLI_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
