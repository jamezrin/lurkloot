import { describe, expect, it } from "vitest";
import { mergeSettings } from "@lurkloot/shared/settings";
import { migrateSettings } from "@lurkloot/shared/settingsSchema";
import { DEFAULT_CLI_SETTINGS, parseCliSettings, parseCliSettingsWithDiagnostics, toEngineSettings } from "../src/settings";

describe("parseCliSettings", () => {
  it("migrates legacy Watch Queue settings and reports them", () => {
    const { settings, diagnostics } = parseCliSettingsWithDiagnostics({
      watchQueueFallbackOnly: false,
      platform: { twitch: { watchQueueChannels: [" Legacy ", "legacy"] } },
    });
    expect(settings.idleWatchlistFallbackOnly).toBe(false);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacy"]);
    expect(settings).not.toHaveProperty("watchQueueFallbackOnly");
    expect(diagnostics.map((d) => d.path)).toEqual(["watchQueueFallbackOnly", "platform.twitch.watchQueueChannels"]);
  });

  it("prefers current keys over legacy ones", () => {
    const settings = parseCliSettings({
      idleWatchlistFallbackOnly: true,
      watchQueueFallbackOnly: false,
      platform: {
        twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"] },
        kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
      },
    });
    expect(settings.idleWatchlistFallbackOnly).toBe(true);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual([]);
    expect(settings.platform.kick.idleWatchlistChannels).toEqual(["new"]);
  });

  it("accepts a deprecated top-level autoClaimChannelPoints instead of erroring", () => {
    const { settings, diagnostics } = parseCliSettingsWithDiagnostics({ autoClaimChannelPoints: false });
    expect(settings.platform.twitch.autoClaimChannelPoints).toBe(false);
    expect(diagnostics.map((d) => d.path)).toEqual(["autoClaimChannelPoints"]);
  });

  it("still rejects unknown keys that are not registered aliases", () => {
    expect(() => parseCliSettings({ nonsense: 1 })).toThrow(/unknown CLI setting "nonsense"/);
  });

  it("still rejects extension-only keys", () => {
    expect(() => parseCliSettings({ muteFarmingTabs: true }))
      .toThrow(/"muteFarmingTabs" is an extension-only setting/);
  });

  it("names the key the user actually wrote when a migration renamed it", () => {
    // verboseLogging migrates to diagnosticLogging, which the CLI rejects as
    // extension-only. The error has to name verboseLogging or the user cannot
    // find the offending line in their config.
    expect(() => parseCliSettings({ verboseLogging: true }))
      .toThrow(/"verboseLogging" \(renamed to "diagnosticLogging"\) is an extension-only setting/);
  });

  it("accepts schemaVersion at the root of settings without exposing it", () => {
    const settings = parseCliSettings({ schemaVersion: 1, autoClaim: false });
    expect(settings.autoClaim).toBe(false);
    expect(settings).not.toHaveProperty("schemaVersion");
  });

  it("rejects a future schema version", () => {
    expect(() => parseCliSettings({ schemaVersion: 999 })).toThrow(/newer than this build supports/);
  });

  it("returns defaults for an empty/undefined settings block", () => {
    expect(parseCliSettings(undefined)).toEqual(DEFAULT_CLI_SETTINGS);
    expect(parseCliSettings({})).toEqual(DEFAULT_CLI_SETTINGS);
  });

  it("normalizes and merges known settings over the defaults", () => {
    const settings = parseCliSettings({
      autoClaim: false,
      pollIntervalMinutes: 9,
      excludedCampaignIds: [" Foo ", "Foo", "bar"],
      platform: { twitch: { enabled: false, idleWatchlistChannels: ["@Streamer", "streamer"] } },
    });
    expect(settings.autoClaim).toBe(false);
    expect(settings.pollIntervalMinutes).toBe(9);
    // Campaign ids are trimmed + deduped (case-sensitive).
    expect(settings.excludedCampaignIds).toEqual(["Foo", "bar"]);
    // Channels are lowercased, @-stripped and deduped.
    expect(settings.platform.twitch.enabled).toBe(false);
    expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["streamer"]);
    // Untouched platform keeps its default.
    expect(settings.platform.kick.enabled).toBe(DEFAULT_CLI_SETTINGS.platform.kick.enabled);
  });

  it("clamps out-of-range numeric settings", () => {
    expect(parseCliSettings({ pollIntervalMinutes: 0 }).pollIntervalMinutes).toBe(1);
    expect(parseCliSettings({ pollIntervalMinutes: 999 }).pollIntervalMinutes).toBe(60);
    expect(parseCliSettings({ offlineRetryLimit: 0 }).offlineRetryLimit).toBe(1);
    expect(parseCliSettings({ offlineRetryLimit: 99 }).offlineRetryLimit).toBe(10);
    expect(parseCliSettings({ deadlineSafetyMarginMinutes: -9 }).deadlineSafetyMarginMinutes).toBe(0);
    expect(parseCliSettings({ deadlineSafetyMarginMinutes: 0 }).deadlineSafetyMarginMinutes).toBe(0);
    expect(parseCliSettings({ deadlineSafetyMarginMinutes: 99 }).deadlineSafetyMarginMinutes).toBe(60);
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

  it("accepts campaignFilters now that it gates farming", () => {
    const result = parseCliSettingsWithDiagnostics({ campaignFilters: { notLinked: false } });

    expect(result.settings.campaignFilters.notLinked).toBe(false);
    // Unnamed keys keep their shared defaults.
    expect(result.settings.campaignFilters.subscription).toBe(DEFAULT_CLI_SETTINGS.campaignFilters.subscription);
    expect(result.diagnostics).toEqual([]);
    expect(toEngineSettings(result.settings).campaignFilters.notLinked).toBe(false);
  });

  it("migrates a config still using the old campaignVisibility name", () => {
    const { settings, diagnostics } = parseCliSettingsWithDiagnostics({ campaignVisibility: { notLinked: false } });

    expect(settings.campaignFilters.notLinked).toBe(false);
    expect(settings).not.toHaveProperty("campaignVisibility");
    expect(diagnostics).toEqual([
      expect.objectContaining({ path: "campaignVisibility", replacement: "campaignFilters" }),
    ]);
  });

  it("hard-errors on unknown campaignFilters keys", () => {
    expect(() => parseCliSettings({ campaignFilters: { nonsense: true } }))
      .toThrow(/unknown setting "nonsense" under campaignFilters/);
  });

  it("hard-errors on non-boolean campaignFilters values", () => {
    // Without this the value is dropped and the default silently farms the
    // wrong set of campaigns.
    expect(() => parseCliSettings({ campaignFilters: { notLinked: "yes" } }))
      .toThrow(/"campaignFilters.notLinked" must be a boolean/);
    expect(() => parseCliSettings({ campaignFilters: { subscription: null } }))
      .toThrow(/"campaignFilters.subscription" must be a boolean/);
    expect(() => parseCliSettings({ campaignFilters: [] })).toThrow(/"campaignFilters" must be a JSON object/);
  });

  it("hard-errors on a truly unknown key", () => {
    expect(() => parseCliSettings({ turbo: true })).toThrow(/unknown CLI setting "turbo"/);
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
      skipUnfinishableRewards: false,
      deadlineSafetyMarginMinutes: 5,
      platform: { kick: { enabled: false } },
    });
    const engine = toEngineSettings(cli);
    expect(engine.autoClaim).toBe(false);
    expect(engine.priorityMode).toBe("lowest_availability");
    expect(engine.pollIntervalMinutes).toBe(4);
    expect(engine.skipUnfinishableRewards).toBe(false);
    expect(engine.deadlineSafetyMarginMinutes).toBe(5);
    expect(engine.platform.kick.enabled).toBe(false);
    expect(engine.compatibility).toEqual(cli.compatibility);
  });

  // Guards the whole point of the shared registry: both hosts must derive the
  // same engine-contract values from one legacy document. The extension reaches
  // them via mergeSettings; the CLI via parseCliSettings + toEngineSettings. If
  // a future migration diverged the two, this is where it would show up.
  it("agrees with the extension on the engine contract for a legacy document", () => {
    const legacy = {
      watchQueueFallbackOnly: false,
      autoClaimChannelPoints: false,
      platform: {
        twitch: { watchQueueChannels: ["A"] },
        kick: { watchQueueChannels: ["B"] },
      },
    };
    const cliEngine = toEngineSettings(parseCliSettings(legacy));
    // The extension migrates then normalizes; replicate that exact pipeline.
    const extension = mergeSettings(migrateSettings(legacy).settings as never);
    expect(cliEngine.idleWatchlistFallbackOnly).toBe(extension.idleWatchlistFallbackOnly);
    expect(cliEngine.idleWatchlistFallbackOnly).toBe(false);
    expect(cliEngine.platform.twitch.idleWatchlistChannels).toEqual(extension.platform.twitch.idleWatchlistChannels);
    expect(cliEngine.platform.kick.idleWatchlistChannels).toEqual(extension.platform.kick.idleWatchlistChannels);
    expect(cliEngine.platform.twitch.autoClaimChannelPoints).toBe(extension.platform.twitch.autoClaimChannelPoints);
    expect(cliEngine.platform.twitch.autoClaimChannelPoints).toBe(false);
  });
});
