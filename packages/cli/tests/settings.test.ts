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

  it("round-trips compatibility profile and expert selections", () => {
    const settings = parseCliSettings({
      compatibility: {
        twitch: {
          profile: "twitch-2026-07",
          heartbeatTransport: "twitch-heartbeat-trowel-v1",
          inventoryQueryVersion: "twitch-inventory-v1",
        },
        kick: {
          profile: "kick-2026-07",
          claimLinkHandling: "kick-claim-v2",
        },
      },
    });

    expect(settings.compatibility).toEqual({
      twitch: {
        profile: "twitch-2026-07",
        heartbeatTransport: "twitch-heartbeat-trowel-v1",
        inventoryQueryVersion: "twitch-inventory-v1",
      },
      kick: {
        profile: "kick-2026-07",
        claimLinkHandling: "kick-claim-v2",
      },
    });
  });

  it("normalizes blank and non-string compatibility selections to auto", () => {
    const settings = parseCliSettings({
      compatibility: {
        twitch: { profile: "  ", heartbeatTransport: 42 },
        kick: { claimLinkHandling: null },
      },
    });

    expect(settings.compatibility).toEqual(DEFAULT_CLI_SETTINGS.compatibility);
  });

  it("hard-errors on unknown compatibility keys", () => {
    expect(() => parseCliSettings({ compatibility: { twitch: { endpoint: "https://example.test" } } }))
      .toThrow(/unknown setting "endpoint" under compatibility.twitch/);
    expect(() => parseCliSettings({ compatibility: { youtube: {} } }))
      .toThrow(/unknown compatibility platform "youtube"/);
  });

  it("hard-errors on extension-only keys, naming them", () => {
    expect(() => parseCliSettings({ adFocusMode: "window" })).toThrow(/"adFocusMode" is an extension-only setting/);
    expect(() => parseCliSettings({ running: true })).toThrow(/"running" is an extension-only setting/);
    expect(() => parseCliSettings({ tablessMode: true })).toThrow(/"tablessMode" is an extension-only setting/);
    expect(() => parseCliSettings({ diagnosticLogging: true })).toThrow(/"diagnosticLogging" is an extension-only setting/);
  });

  it("hard-errors on a truly unknown key", () => {
    expect(() => parseCliSettings({ turbo: true })).toThrow(/unknown CLI setting "turbo"/);
  });

  it("points a moved top-level key at its new per-platform home", () => {
    expect(() => parseCliSettings({ autoClaimChannelPoints: false }))
      .toThrow(/"autoClaimChannelPoints" moved to "platform.twitch.autoClaimChannelPoints"/);
  });

  it("accepts autoClaimChannelPoints under platform.twitch", () => {
    expect(parseCliSettings({ platform: { twitch: { autoClaimChannelPoints: false } } }).platform.twitch.autoClaimChannelPoints).toBe(false);
    expect(parseCliSettings({}).platform.twitch.autoClaimChannelPoints).toBe(true);
  });

  it("accepts autoClaimChallenges under platform.kick", () => {
    const parsed = parseCliSettings({ platform: { kick: { autoClaimChallenges: false } } });
    expect(parsed.platform.kick.autoClaimChallenges).toBe(false);
  });

  it("defaults autoClaimChallenges on when the config omits it", () => {
    expect(parseCliSettings({}).platform.kick.autoClaimChallenges).toBe(true);
  });

  it("rejects autoClaimChallenges under platform.twitch", () => {
    expect(() => parseCliSettings({ platform: { twitch: { autoClaimChallenges: true } } }))
      .toThrow('unknown setting "autoClaimChallenges" under platform.twitch');
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
    expect(engine.compatibility).toEqual(cli.compatibility);
  });
});
