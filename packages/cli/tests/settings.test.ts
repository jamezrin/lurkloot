import { describe, expect, it } from "vitest";
import { DEFAULT_CLI_SETTINGS, parseCliSettings, toEngineSettings } from "../src/settings";

describe("parseCliSettings", () => {
  it("returns defaults for an empty/undefined settings block", () => {
    expect(parseCliSettings(undefined)).toEqual(DEFAULT_CLI_SETTINGS);
    expect(parseCliSettings({})).toEqual(DEFAULT_CLI_SETTINGS);
  });

  it("normalizes and merges known settings over the defaults", () => {
    const settings = parseCliSettings({
      autoClaim: false,
      pollIntervalMinutes: 9,
      excludedCampaignIds: [" Foo ", "Foo", "bar"],
      platform: { twitch: { enabled: false, watchQueueChannels: ["@Streamer", "streamer"] } },
    });
    expect(settings.autoClaim).toBe(false);
    expect(settings.pollIntervalMinutes).toBe(9);
    // Campaign ids are trimmed + deduped (case-sensitive).
    expect(settings.excludedCampaignIds).toEqual(["Foo", "bar"]);
    // Channels are lowercased, @-stripped and deduped.
    expect(settings.platform.twitch.enabled).toBe(false);
    expect(settings.platform.twitch.watchQueueChannels).toEqual(["streamer"]);
    // Untouched platform keeps its default.
    expect(settings.platform.kick.enabled).toBe(DEFAULT_CLI_SETTINGS.platform.kick.enabled);
  });

  it("clamps out-of-range numeric settings", () => {
    expect(parseCliSettings({ pollIntervalMinutes: 0 }).pollIntervalMinutes).toBe(1);
    expect(parseCliSettings({ pollIntervalMinutes: 999 }).pollIntervalMinutes).toBe(60);
    expect(parseCliSettings({ offlineRetryLimit: 0 }).offlineRetryLimit).toBe(1);
    expect(parseCliSettings({ offlineRetryLimit: 99 }).offlineRetryLimit).toBe(10);
  });

  it("hard-errors on extension-only keys, naming them", () => {
    expect(() => parseCliSettings({ adFocusMode: "window" })).toThrow(/"adFocusMode" is an extension-only setting/);
    expect(() => parseCliSettings({ running: true })).toThrow(/"running" is an extension-only setting/);
    expect(() => parseCliSettings({ tablessMode: true })).toThrow(/"tablessMode" is an extension-only setting/);
  });

  it("hard-errors on a truly unknown key", () => {
    expect(() => parseCliSettings({ turbo: true })).toThrow(/unknown CLI setting "turbo"/);
  });

  it("lists every offender in a single error", () => {
    let message = "";
    try {
      parseCliSettings({ adFocusMode: "window", turbo: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/adFocusMode/);
    expect(message).toMatch(/turbo/);
  });

  it("hard-errors on unknown platforms and unknown per-platform keys", () => {
    expect(() => parseCliSettings({ platform: { youtube: { enabled: true } } })).toThrow(/unknown platform "youtube"/);
    expect(() => parseCliSettings({ platform: { twitch: { muteFarmingTabs: true } } })).toThrow(/unknown setting "muteFarmingTabs" under platform.twitch/);
  });

  it("rejects a non-object settings block", () => {
    expect(() => parseCliSettings([])).toThrow(/must be a JSON object/);
    expect(() => parseCliSettings(null)).toThrow(/must be a JSON object/);
  });
});

describe("toEngineSettings", () => {
  it("pins the headless invariants regardless of CLI input", () => {
    const engine = toEngineSettings(DEFAULT_CLI_SETTINGS);
    expect(engine.running).toBe(true);
    expect(engine.tablessMode).toBe(true);
    expect(engine.pauseOnManualWatch).toBe(false);
    expect(engine.autoStartDropFarming).toBe(false);
  });

  it("maps the kept CLI fields through to the engine settings", () => {
    const cli = parseCliSettings({
      autoClaim: false,
      priorityMode: "lowest_availability",
      pollIntervalMinutes: 4,
      platform: { kick: { enabled: false } },
    });
    const engine = toEngineSettings(cli);
    expect(engine.autoClaim).toBe(false);
    expect(engine.priorityMode).toBe("lowest_availability");
    expect(engine.pollIntervalMinutes).toBe(4);
    expect(engine.platform.kick.enabled).toBe(false);
  });
});
