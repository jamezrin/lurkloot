import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseConfig } from "../src/config";

const CONFIG_PATH = "/tmp/lurkloot/config.json";

describe("parseConfig", () => {
  it("defaults the transport to http and authDir to <configDir>/auth", () => {
    const config = parseConfig({}, CONFIG_PATH);
    expect(config.transport).toBe("http");
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "auth"));
  });

  it("resolves authDir relative to the config file directory", () => {
    const config = parseConfig({ authDir: "creds" }, CONFIG_PATH);
    expect(config.authDir).toBe(resolve("/tmp/lurkloot", "creds"));
  });

  it("merges settings over the extension defaults", () => {
    const config = parseConfig({ settings: { pollIntervalMinutes: 7 } }, CONFIG_PATH);
    expect(config.settings.pollIntervalMinutes).toBe(7);
    // A field left out of the config still gets its extension default.
    expect(typeof config.settings.tablessMode).toBe("boolean");
    expect(config.settings.platform.twitch).toBeDefined();
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
