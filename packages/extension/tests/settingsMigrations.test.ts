import { describe, expect, it } from "vitest";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  UnsupportedSettingsVersionError,
  migrateSettings,
  withSchemaVersion,
} from "@lurkloot/shared/settingsSchema";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { mergeSettings } from "@lurkloot/shared/settings";

const defaultSourceSettings = {
  twitch: {
    watchSourcePriority: ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"],
  },
  kick: { watchSourcePriority: ["drops", "watchlist"] },
};

describe("settings schema versions", () => {
  it("treats an unversioned object as version 0", () => {
    const result = migrateSettings({ autoClaim: false });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.changed).toBe(true);
  });

  it("treats a missing or non-object payload as an empty version 0 document", () => {
    for (const raw of [undefined, null, "nope", 42, ["a"]]) {
      const result = migrateSettings(raw);
      expect(result.settings).toEqual({
        criticalFailurePromptEnabled: true,
        platform: defaultSourceSettings,
      });
      expect(result.fromVersion).toBe(0);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("is a no-op for a current-version document", () => {
    const stored = withSchemaVersion({ autoClaim: false });
    const result = migrateSettings(stored);
    expect(result.changed).toBe(false);
    expect(result.fromVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.diagnostics).toEqual([]);
    expect(result.settings).toEqual({ autoClaim: false });
  });

  it("strips the reserved schemaVersion property from the migrated payload", () => {
    const result = migrateSettings(withSchemaVersion({ autoClaim: true }));
    expect(result.settings).not.toHaveProperty(SETTINGS_SCHEMA_VERSION_KEY);
  });

  it("never mutates its input", () => {
    const stored = {
      watchQueueFallbackOnly: false,
      platform: { twitch: { watchQueueChannels: ["A"] } },
    };
    const snapshot = structuredClone(stored);
    migrateSettings(stored);
    expect(stored).toEqual(snapshot);
  });

  it("is idempotent when re-run on its own output", () => {
    const first = migrateSettings({ watchQueueFallbackOnly: false });
    const second = migrateSettings(withSchemaVersion(first.settings));
    expect(second.settings).toEqual(first.settings);
    expect(second.changed).toBe(false);
  });

  it("rejects a future schema version", () => {
    const future = CURRENT_SETTINGS_SCHEMA_VERSION + 1;
    expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future })).toThrow(
      UnsupportedSettingsVersionError,
    );
    try {
      migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: future });
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSettingsVersionError);
      expect((error as UnsupportedSettingsVersionError).version).toBe(future);
      expect((error as UnsupportedSettingsVersionError).reason).toBe("future");
    }
  });

  it("rejects a malformed schema version", () => {
    for (const version of [-1, 1.5, Number.NaN, "1", null]) {
      expect(() => migrateSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: version })).toThrow(
        UnsupportedSettingsVersionError,
      );
    }
  });

  it("stamps the current version with withSchemaVersion", () => {
    expect(withSchemaVersion({ autoClaim: true })).toEqual({
      autoClaim: true,
      [SETTINGS_SCHEMA_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION,
    });
  });

  it("upgrades a version 0 document all the way to the current version", () => {
    // Guards sequential application: whatever CURRENT_SETTINGS_SCHEMA_VERSION
    // becomes, entering at 0 must land on it. The contiguity of the registry
    // itself is asserted at module load, so a missing step throws on import
    // rather than letting a host write a half-migrated document.
    expect(migrateSettings({}).toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(migrateSettings({}).fromVersion).toBe(0);
  });

  it("enters at every intermediate version without skipping steps", () => {
    // Re-migrating from each supported version must converge on the same
    // document as migrating the whole way from 0.
    const target = migrateSettings({ autoClaim: false }).settings;
    for (let version = 0; version <= CURRENT_SETTINGS_SCHEMA_VERSION; version += 1) {
      const result = migrateSettings({ ...target, [SETTINGS_SCHEMA_VERSION_KEY]: version });
      expect(result.settings).toEqual(target);
      expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    }
  });
});

describe("migration 1: legacy aliases", () => {
  it("renames the Watch Queue properties", () => {
    const result = migrateSettings({
      watchQueueFallbackOnly: false,
      platform: {
        twitch: { watchQueueChannels: ["Legacy"] },
        kick: { watchQueueChannels: ["KickLegacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: false,
      criticalFailurePromptEnabled: true,
      platform: {
        twitch: {
          watchlistChannels: ["Legacy"],
          watchSourcePriority: ["watch_streaks", "watchlist", "drops", "nopixel", "fortnite"],
        },
        kick: {
          watchlistChannels: ["KickLegacy"],
          watchSourcePriority: ["watchlist", "drops"],
        },
      },
    });
    expect(result.settings).not.toHaveProperty("watchQueueFallbackOnly");
  });

  it("moves a top-level autoClaimChannelPoints onto platform.twitch", () => {
    const result = migrateSettings({ autoClaimChannelPoints: false });
    expect(result.settings).toEqual({
      platform: {
        ...defaultSourceSettings,
        twitch: { ...defaultSourceSettings.twitch, autoClaimChannelPoints: false },
      },
      criticalFailurePromptEnabled: true,
    });
    expect(result.diagnostics).toContainEqual({
      code: "moved_property",
      path: "autoClaimChannelPoints",
      replacement: "platform.twitch.autoClaimChannelPoints",
      message: "autoClaimChannelPoints moved to platform.twitch.autoClaimChannelPoints",
    });
  });

  it("renames verboseLogging to diagnosticLogging", () => {
    expect(migrateSettings({ verboseLogging: true }).settings).toEqual({
      diagnosticLogging: true,
      criticalFailurePromptEnabled: true,
      platform: defaultSourceSettings,
    });
    expect(migrateSettings({ verboseLogging: false }).settings).toEqual({
      diagnosticLogging: false,
      criticalFailurePromptEnabled: true,
      platform: defaultSourceSettings,
    });
  });

  it("drops an unhomeable legacy autoClaimChannelPoints when platform is not an object", () => {
    // The value cannot be rehomed into a corrupt platform block, and leaving it
    // at the top level would be dead data. Normalization defaults the whole
    // corrupt block anyway, so this is consistent, not a meaningful loss. The
    // malformed platform is left verbatim for each host to surface.
    const result = migrateSettings({ autoClaimChannelPoints: false, platform: "nope" });
    expect(result.settings).toEqual({ platform: "nope", criticalFailurePromptEnabled: true });
    expect(result.diagnostics).toEqual([]);
  });

  it("drops an unhomeable legacy autoClaimChannelPoints when platform.twitch is not an object", () => {
    const result = migrateSettings({ autoClaimChannelPoints: false, platform: { twitch: null } });
    expect(result.settings).toEqual({
      platform: { ...defaultSourceSettings, twitch: null },
      criticalFailurePromptEnabled: true,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("lets a wrong-typed current value win over a legacy one", () => {
    // Deliberate: migrations never inspect types, so normalization sees the
    // wrong-typed current value and applies its default. The pre-registry
    // inline fallbacks instead fell through to the legacy value here.
    const logging = migrateSettings({ diagnosticLogging: "yes", verboseLogging: true });
    expect(logging.settings).toEqual({
      diagnosticLogging: "yes",
      criticalFailurePromptEnabled: true,
      platform: defaultSourceSettings,
    });
    expect(logging.diagnostics.map((d) => d.path)).toEqual(["verboseLogging"]);

    const points = migrateSettings({
      autoClaimChannelPoints: false,
      platform: { twitch: { autoClaimChannelPoints: "yes" } },
    });
    expect(points.settings).toEqual({
      platform: {
        ...defaultSourceSettings,
        twitch: { ...defaultSourceSettings.twitch, autoClaimChannelPoints: "yes" },
      },
      criticalFailurePromptEnabled: true,
    });
    expect(points.diagnostics.map((d) => d.path)).toEqual(["autoClaimChannelPoints"]);
  });

  it("keeps a non-boolean legacy value verbatim so normalization decides", () => {
    // mergeSettings applies booleanOr afterwards; the migration only reshapes.
    expect(migrateSettings({ autoClaimChannelPoints: "yes" }).settings).toEqual({
      platform: {
        ...defaultSourceSettings,
        twitch: { ...defaultSourceSettings.twitch, autoClaimChannelPoints: "yes" },
      },
      criticalFailurePromptEnabled: true,
    });
  });

  it("lets the current property win while still reporting the deprecated one", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      watchQueueFallbackOnly: false,
      diagnosticLogging: false,
      verboseLogging: true,
      autoClaimChannelPoints: false,
      platform: {
        twitch: {
          idleWatchlistChannels: [],
          watchQueueChannels: ["legacy"],
          autoClaimChannelPoints: true,
        },
        kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
      },
    });
    expect(result.settings).toEqual({
      idleWatchlistFallbackOnly: true,
      diagnosticLogging: false,
      criticalFailurePromptEnabled: true,
      platform: {
        twitch: {
          ...defaultSourceSettings.twitch,
          watchlistChannels: [],
          autoClaimChannelPoints: true,
        },
        kick: { ...defaultSourceSettings.kick, watchlistChannels: ["new"] },
      },
    });
    expect(result.diagnostics.map((d) => d.path)).toEqual([
      "watchQueueFallbackOnly",
      "verboseLogging",
      "autoClaimChannelPoints",
      "platform.twitch.watchQueueChannels",
      "platform.kick.watchQueueChannels",
      "platform.twitch.idleWatchlistChannels",
      "platform.kick.idleWatchlistChannels",
    ]);
  });

  it("emits a stable, deduplicated diagnostic per deprecated property", () => {
    const result = migrateSettings({ watchQueueFallbackOnly: false });
    expect(result.diagnostics).toEqual([
      {
        code: "deprecated_property",
        path: "watchQueueFallbackOnly",
        replacement: "idleWatchlistFallbackOnly",
        message: "watchQueueFallbackOnly is deprecated; use idleWatchlistFallbackOnly",
      },
    ]);
  });

  it("reports nothing for a payload that only uses current names", () => {
    const result = migrateSettings({
      idleWatchlistFallbackOnly: true,
      platform: { twitch: { watchlistChannels: ["a"] } },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.changed).toBe(true); // unversioned input still gets stamped
  });

  it("leaves unrelated and malformed platform blocks alone", () => {
    expect(migrateSettings({ platform: "nope", other: 1 }).settings).toEqual({
      platform: "nope",
      other: 1,
      criticalFailurePromptEnabled: true,
    });
    expect(migrateSettings({ platform: { twitch: null } }).settings).toEqual({
      platform: { ...defaultSourceSettings, twitch: null },
      criticalFailurePromptEnabled: true,
    });
  });
});

describe("schema v2", () => {
  it("moves all six display keys of campaignVisibility into dropsListFilter", () => {
    // campaignVisibility was DISPLAY-ONLY in the shipped release. All six keys —
    // including notLinked/subscription, which dropsListFilter now expresses as
    // showNotLinked/showSubscription — carry over as display preferences.
    // farmingEligibility is NEVER produced here, so normalization defaults both
    // farming flags on. A false value survives verbatim.
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: {
        notLinked: false,
        subscription: true,
        upcoming: false,
        expired: true,
        finished: false,
        excluded: true,
      },
    });

    // v2 moved these display preferences to dropsListFilter; v7 retired that
    // block entirely, so the end state carries neither. What matters is that a
    // display-only preference never became a farming decision on the way.
    expect(result.settings.dropsListFilter).toBeUndefined();
    // The migration never derives farming eligibility from a display-only
    // setting; normalization defaults both flags to on.
    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.campaignVisibility).toBeUndefined();
    expect(result.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.changed).toBe(true);
    // v7 retired dropsListFilter, so the diagnostic names no replacement, and
    // v7's own report of a dropsListFilter the document never had is dropped.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "deprecated_property", path: "campaignVisibility" }),
    ]);
    expect(result.diagnostics[0].replacement).toBeUndefined();
  });

  it("never carries a legacy notLinked display preference into farming eligibility", () => {
    // Guard for the migration-safety fix: a user who had merely hidden unlinked
    // campaigns from their list must keep farming them. farmUnlinkedCampaigns is
    // NOT derived from notLinked; farmingEligibility stays absent so it defaults
    // to on. The notLinked display preference IS preserved — as the display flag
    // showNotLinked, never as a farming flag. If the old notLinked -> farming
    // mapping returns, this fails.
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { notLinked: false, subscription: false },
    });

    expect(result.settings.farmingEligibility).toBeUndefined();
    // The two class keys were display preferences, and v7 retired the block
    // that held them; neither may reappear as a farming flag.
    expect(result.settings.dropsListFilter).toBeUndefined();
    // The move is still reported.
    expect(result.diagnostics.map((d) => d.path)).toContain("campaignVisibility");
  });

  it("carries over only the lifecycle keys present, leaving the rest for normalization", () => {
    const result = migrateSettings({
      schemaVersion: 1,
      campaignVisibility: { expired: true },
    });

    expect(result.settings.dropsListFilter).toBeUndefined();
    expect(result.settings.farmingEligibility).toBeUndefined();
  });

  it("leaves a document that never had the key alone", () => {
    const result = migrateSettings({ schemaVersion: 1, autoClaim: false });

    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.dropsListFilter).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("drops a non-object campaignVisibility without writing garbage", () => {
    const result = migrateSettings({ schemaVersion: 1, campaignVisibility: "nonsense" });

    expect(result.settings.campaignVisibility).toBeUndefined();
    expect(result.settings.farmingEligibility).toBeUndefined();
    expect(result.settings.dropsListFilter).toBeUndefined();
  });

  it("drops a stray interim campaignFilters key that never shipped", () => {
    const result = migrateSettings({ schemaVersion: 1, campaignFilters: { notLinked: false } });

    expect(result.settings.campaignFilters).toBeUndefined();
  });
});

describe("schema v4", () => {
  it("drops the running flag and keeps enabled platforms farming when it was on", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: true,
      platform: { twitch: { enabled: true }, kick: { enabled: true } },
    });

    expect(migrated.settings.running).toBeUndefined();
    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: true },
      kick: { enabled: true },
    });
    expect(migrated.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  // The popup rendered `running && enabled`, so a stored `running: false` showed
  // every platform as off. Carrying the enabled flags across unchanged would
  // start farming on upgrade for platforms the user last saw switched off.
  it("switches every platform off when automation was off, whatever the flags said", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: false,
      platform: { twitch: { enabled: true }, kick: { enabled: true } },
    });

    expect(migrated.settings.running).toBeUndefined();
    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: false },
      kick: { enabled: false },
    });
    expect(migrated.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "deprecated_property",
        path: "running",
      }),
    );
  });

  it("reports nothing when automation was off and the platforms already were", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      running: false,
      platform: { twitch: { enabled: false }, kick: { enabled: false } },
    });

    expect(migrated.diagnostics.filter((diagnostic) => diagnostic.path === "running")).toEqual([]);
  });

  it("leaves a document without the flag untouched", () => {
    const migrated = migrateSettings({
      schemaVersion: 3,
      platform: { twitch: { enabled: true }, kick: { enabled: false } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { enabled: true },
      kick: { enabled: false },
    });
  });
});

describe("schema v3", () => {
  it("adds the critical failure prompt toggle at version 3", () => {
    const migrated = migrateSettings({ schemaVersion: 2, running: true });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(true);
    expect(migrated.toVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
  });

  it("preserves an explicit opt-out through migration", () => {
    const migrated = migrateSettings({ schemaVersion: 2, criticalFailurePromptEnabled: false });

    expect(migrated.settings.criticalFailurePromptEnabled).toBe(false);
  });
});

describe("schema v5", () => {
  const CATEGORIES = [
    { id: "13", name: "Rust" },
    { id: "21", name: "Other" },
  ];

  it("maps an explicit farm-all off to include mode, preserving the list and its order", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: false, categories: CATEGORIES } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { categoryMode: "include", categories: CATEGORIES },
    });
    expect(
      (migrated.settings.platform as Record<string, Record<string, unknown>>).twitch
        .farmAllCategories,
    ).toBeUndefined();
    expect(migrated.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "deprecated_property",
        path: "platform.twitch.farmAllCategories",
        replacement: "platform.twitch.categoryMode",
      }),
    );
  });

  it("maps farm-all on to all mode on both platforms", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: true }, kick: { farmAllCategories: true } },
    });

    expect(migrated.settings.platform).toMatchObject({
      twitch: { categoryMode: "all" },
      kick: { categoryMode: "all" },
    });
  });

  // The old normalizer read the boolean as booleanOr(value, true), so anything
  // that was not exactly `false` already meant farm-all.
  it("treats a wrong-typed legacy value the way the old normalizer did", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { kick: { farmAllCategories: "no" } },
    });

    expect(migrated.settings.platform).toMatchObject({ kick: { categoryMode: "all" } });
  });

  it("lets an already-current key win over the legacy one", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { farmAllCategories: false, categoryMode: "include" } },
    });

    expect(migrated.settings.platform).toMatchObject({ twitch: { categoryMode: "include" } });
  });

  it("leaves a document without the legacy key untouched and reports nothing", () => {
    const migrated = migrateSettings({
      schemaVersion: 4,
      platform: { twitch: { categories: CATEGORIES } },
    });

    expect(migrated.settings.platform).toMatchObject({ twitch: { categories: CATEGORIES } });
    expect(
      (migrated.settings.platform as Record<string, Record<string, unknown>>).twitch.categoryMode,
    ).toBeUndefined();
    expect(
      migrated.diagnostics.filter((diagnostic) => diagnostic.path.endsWith("farmAllCategories")),
    ).toEqual([]);
  });
});

describe("schema v8 and v9", () => {
  const platformOf = (settings: Record<string, unknown>, platform: "twitch" | "kick") =>
    (settings.platform as Record<string, Record<string, unknown>>)[platform];

  it("v8 turns the subscription toggle off into skip on both platforms", () => {
    const migrated = migrateSettings(
      withSchemaVersion({ farmingEligibility: { farmSubscriptionCampaigns: false } }, 7),
    );

    expect(platformOf(migrated.settings, "twitch").rewardFilter).toEqual({ subscriptions: "skip" });
    expect(platformOf(migrated.settings, "kick").rewardFilter).toEqual({ subscriptions: "skip" });
    expect(migrated.settings.farmingEligibility).toBeUndefined();
    expect(migrated.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "moved_property",
        path: "farmingEligibility.farmSubscriptionCampaigns",
      }),
    );
  });

  it("v8 copies the unlinked toggle and farm pinned only to both platforms", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        { farmingEligibility: { farmUnlinkedCampaigns: false }, farmPinnedOnly: true },
        7,
      ),
    );

    for (const platform of ["twitch", "kick"] as const) {
      // v9 then turns the copied switch into the unlinked mode, and v12 the
      // copied pinned-only switch into reward kinds only pins farm.
      expect(platformOf(migrated.settings, platform)).toMatchObject({
        unlinkedCampaigns: "skip",
        rewardFilter: {
          kinds: [],
          favouriteKinds: [],
          pinnedKinds: ["item", "badge", "emote"],
        },
      });
      expect(platformOf(migrated.settings, platform).farmUnlinkedCampaigns).toBeUndefined();
      expect(platformOf(migrated.settings, platform).farmPinnedOnly).toBeUndefined();
    }
    expect(migrated.settings.farmingEligibility).toBeUndefined();
    expect(migrated.settings.farmPinnedOnly).toBeUndefined();
    expect(migrated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "moved_property",
          path: "farmingEligibility.farmUnlinkedCampaigns",
        }),
        expect.objectContaining({ code: "moved_property", path: "farmPinnedOnly" }),
      ]),
    );
  });

  it("v8 maps the Queue tab types", () => {
    const cases: Array<[unknown[], Record<string, unknown> | undefined]> = [
      [[], undefined],
      [["badge"], { kinds: ["badge"] }],
      [["no_subscription"], { subscriptions: "skip" }],
      [["subscription"], { subscriptions: "only" }],
      [["no_subscription", "subscription"], undefined],
      // 1.18.0 farmed a reward matching any tab. A filter cannot express a
      // badge with a subscription type, so these farm everything rather than
      // narrowing to the intersection.
      [["badge", "no_subscription"], undefined],
      [["badge", "subscription"], undefined],
      [["badge", "no_subscription", "subscription"], undefined],
    ];
    for (const [types, rewardFilter] of cases) {
      const migrated = migrateSettings(
        withSchemaVersion({ platform: { twitch: { farmRewardTypes: types } } }, 7),
      );
      const twitch = platformOf(migrated.settings, "twitch");
      expect(twitch.rewardFilter).toEqual(rewardFilter);
      expect(twitch.farmRewardTypes).toBeUndefined();
      expect(migrated.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "moved_property",
          path: "platform.twitch.farmRewardTypes",
          replacement: "platform.twitch.rewardFilter",
        }),
      );
    }
  });

  it("v8 lets the tab subscription choice win over the old toggle", () => {
    const migrate = (farmRewardTypes: string[]) =>
      platformOf(
        migrateSettings(
          withSchemaVersion(
            {
              farmingEligibility: { farmSubscriptionCampaigns: false },
              platform: { twitch: { farmRewardTypes } },
            },
            7,
          ),
        ).settings,
        "twitch",
      ).rewardFilter;

    expect(migrate(["subscription"])).toEqual({ subscriptions: "only" });
    expect(migrate(["badge"])).toEqual({ kinds: ["badge"], subscriptions: "skip" });
    // Tabs the filter cannot express fall back to the toggle alone, which
    // farms at least everything the toggle and the tabs together did.
    expect(migrate(["badge", "subscription"])).toEqual({ subscriptions: "skip" });
    expect(migrate(["badge", "no_subscription"])).toEqual({ subscriptions: "skip" });
  });

  it("v8 ignores a Kick badge tab, as the old normalizer did", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        { platform: { kick: { farmRewardTypes: ["badge", "no_subscription"] } } },
        7,
      ),
    );
    expect(platformOf(migrated.settings, "kick").rewardFilter).toEqual({ subscriptions: "skip" });
  });

  it("v8 reports an unknown farmingEligibility key instead of dropping it silently", () => {
    const migrated = migrateSettings(
      withSchemaVersion({ farmingEligibility: { farmUnlinkedCampaign: false } }, 7),
    );

    expect(migrated.settings.farmingEligibility).toBeUndefined();
    expect(migrated.diagnostics).toEqual([
      expect.objectContaining({
        code: "deprecated_property",
        path: "farmingEligibility.farmUnlinkedCampaign",
      }),
    ]);
  });

  it("v8 keeps a current rewardFilter", () => {
    const current = { kinds: ["item"], subscriptions: "include" };
    const migrated = migrateSettings(
      withSchemaVersion(
        {
          farmingEligibility: { farmSubscriptionCampaigns: false },
          platform: { kick: { farmRewardTypes: ["subscription"], rewardFilter: current } },
        },
        7,
      ),
    );

    expect(platformOf(migrated.settings, "kick").rewardFilter).toEqual(current);
    expect(platformOf(migrated.settings, "kick").farmRewardTypes).toBeUndefined();
  });

  it("v8 keeps current per-platform switches over the old top-level ones", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        {
          farmingEligibility: { farmUnlinkedCampaigns: false },
          farmPinnedOnly: true,
          platform: { twitch: { farmUnlinkedCampaigns: true, farmPinnedOnly: false } },
        },
        7,
      ),
    );

    // v12: the pinned-only switch the platform kept decides its reward kinds.
    expect(platformOf(migrated.settings, "twitch")).toMatchObject({
      unlinkedCampaigns: "include",
    });
    expect(platformOf(migrated.settings, "twitch").rewardFilter).toBeUndefined();
    expect(platformOf(migrated.settings, "kick")).toMatchObject({
      unlinkedCampaigns: "skip",
      rewardFilter: { kinds: [], favouriteKinds: [] },
    });
  });

  it("v9 turns the unlinked switch into the unlinked mode", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        {
          platform: {
            twitch: { farmUnlinkedCampaigns: true },
            kick: { farmUnlinkedCampaigns: false },
          },
        },
        8,
      ),
    );

    expect(platformOf(migrated.settings, "twitch")).toEqual({ unlinkedCampaigns: "include" });
    expect(platformOf(migrated.settings, "kick")).toEqual({ unlinkedCampaigns: "skip" });
    expect(migrated.diagnostics).toEqual([
      expect.objectContaining({
        code: "moved_property",
        path: "platform.twitch.farmUnlinkedCampaigns",
        replacement: "platform.twitch.unlinkedCampaigns",
      }),
      expect.objectContaining({
        code: "moved_property",
        path: "platform.kick.farmUnlinkedCampaigns",
        replacement: "platform.kick.unlinkedCampaigns",
      }),
    ]);
  });

  it("v9 keeps a current unlinked mode and leaves platforms without the switch alone", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        { platform: { twitch: { farmUnlinkedCampaigns: false, unlinkedCampaigns: "last" } } },
        8,
      ),
    );

    expect(platformOf(migrated.settings, "twitch")).toEqual({ unlinkedCampaigns: "last" });
    expect(platformOf(migrated.settings, "kick")).toBeUndefined();
  });

  it("v9 moves a wrong-typed switch across for normalization to judge", () => {
    const migrated = migrateSettings(
      withSchemaVersion({ platform: { kick: { farmUnlinkedCampaigns: "yes" } } }, 8),
    );

    expect(platformOf(migrated.settings, "kick")).toEqual({ unlinkedCampaigns: "yes" });
    expect(mergeSettings(migrated.settings).platform.kick.unlinkedCampaigns).toBe("include");
  });
});

describe("schema v12", () => {
  const platformOf = (settings: Record<string, unknown>, platform: "twitch" | "kick") =>
    (settings.platform as Record<string, Record<string, unknown>>)[platform];

  it("turns farm pinned only into empty favourite and other kinds, pins keeping theirs", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        {
          platform: {
            twitch: {
              farmPinnedOnly: true,
              rewardFilter: { kinds: ["badge"], subscriptions: "skip" },
            },
            kick: { farmPinnedOnly: true },
          },
        },
        11,
      ),
    );

    expect(platformOf(migrated.settings, "twitch")).toEqual({
      rewardFilter: {
        kinds: [],
        subscriptions: "skip",
        pinnedKinds: ["badge"],
        favouriteKinds: [],
      },
    });
    expect(platformOf(migrated.settings, "kick")).toEqual({
      rewardFilter: { kinds: [], pinnedKinds: ["item", "badge", "emote"], favouriteKinds: [] },
    });
    const settings = mergeSettings(migrated.settings as never);
    expect(settings.platform.kick.rewardFilter).toEqual({
      kinds: [],
      subscriptions: "include",
      pinnedKinds: ["item"],
      favouriteKinds: [],
    });
    expect(migrated.diagnostics.map((entry) => entry.path)).toEqual([
      "platform.twitch.farmPinnedOnly",
      "platform.kick.farmPinnedOnly",
    ]);
    expect(migrated.diagnostics[0]).toMatchObject({
      code: "moved_property",
      replacements: [
        "platform.twitch.rewardFilter.favouriteKinds",
        "platform.twitch.rewardFilter.kinds",
      ],
    });
  });

  it("drops farm pinned only off with a diagnostic and changes nothing else", () => {
    const migrated = migrateSettings(
      withSchemaVersion({ platform: { twitch: { farmPinnedOnly: false } } }, 11),
    );
    expect(platformOf(migrated.settings, "twitch")).toEqual({});
    expect(migrated.diagnostics.map((entry) => entry.path)).toEqual([
      "platform.twitch.farmPinnedOnly",
    ]);
  });

  it("keeps an empty kinds list saved before it meaning every kind", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        { platform: { twitch: { rewardFilter: { kinds: [], favouriteKinds: [] } } } },
        11,
      ),
    );
    expect(mergeSettings(migrated.settings as never).platform.twitch.rewardFilter).toEqual(
      defaultRewardFilter("twitch"),
    );
    // From v12 on, an empty list farms nothing from its group.
    const current = mergeSettings(withSchemaVersion(migrated.settings) as never);
    expect(current.platform.twitch.rewardFilter.kinds).toEqual(["item", "badge", "emote"]);
    expect(
      mergeSettings({ platform: { twitch: { rewardFilter: { kinds: [] } } } } as never).platform
        .twitch.rewardFilter.kinds,
    ).toEqual([]);
  });

  it("keeps a current pinned list when it turns pinned only into kinds", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        {
          platform: {
            twitch: {
              farmPinnedOnly: true,
              rewardFilter: { kinds: ["item"], pinnedKinds: ["emote"] },
            },
          },
        },
        11,
      ),
    );
    expect(platformOf(migrated.settings, "twitch").rewardFilter).toEqual({
      kinds: [],
      pinnedKinds: ["emote"],
      favouriteKinds: [],
    });
  });
});

describe("schema v11", () => {
  const platformOf = (settings: Record<string, unknown>, platform: "twitch" | "kick") =>
    (settings.platform as Record<string, Record<string, unknown>>)[platform];

  it("copies the shared pins and exclusions onto both platforms", () => {
    const migrated = migrateSettings(
      withSchemaVersion({ campaignPins: ["t1", "k1"], excludedCampaignIds: ["t2"] }, 10),
    );

    for (const platform of ["twitch", "kick"] as const) {
      expect(platformOf(migrated.settings, platform)).toEqual({
        campaignPins: ["t1", "k1"],
        excludedCampaignIds: ["t2"],
      });
    }
    expect(migrated.settings.campaignPins).toBeUndefined();
    expect(migrated.settings.excludedCampaignIds).toBeUndefined();
    expect(migrated.diagnostics).toEqual([
      {
        code: "moved_property",
        path: "campaignPins",
        replacements: ["platform.twitch.campaignPins", "platform.kick.campaignPins"],
        message:
          "campaignPins moved to platform.twitch.campaignPins and platform.kick.campaignPins",
      },
      {
        code: "moved_property",
        path: "excludedCampaignIds",
        replacements: ["platform.twitch.excludedCampaignIds", "platform.kick.excludedCampaignIds"],
        message:
          "excludedCampaignIds moved to platform.twitch.excludedCampaignIds and platform.kick.excludedCampaignIds",
      },
    ]);
  });

  it("keeps a current per-platform list over the shared one, still reporting it", () => {
    const migrated = migrateSettings(
      withSchemaVersion(
        { campaignPins: ["old"], platform: { kick: { campaignPins: ["current"] } } },
        10,
      ),
    );

    expect(platformOf(migrated.settings, "twitch").campaignPins).toEqual(["old"]);
    expect(platformOf(migrated.settings, "kick").campaignPins).toEqual(["current"]);
    expect(migrated.diagnostics.map((entry) => entry.path)).toEqual(["campaignPins"]);
  });

  it("normalizes into per-platform lists and leaves a v11 document alone", () => {
    const migrated = migrateSettings(withSchemaVersion({ campaignPins: [" a ", "a"] }, 10));
    const settings = mergeSettings(migrated.settings as never);
    expect(settings.platform.twitch.campaignPins).toEqual(["a"]);
    expect(settings.platform.kick.campaignPins).toEqual(["a"]);

    const again = migrateSettings(withSchemaVersion(migrated.settings));
    expect(again.changed).toBe(false);
    expect(again.diagnostics).toEqual([]);
    expect(again.settings).toEqual(migrated.settings);
  });

  it("names both platforms for a v6 priority map that ends up as pins", () => {
    const migrated = migrateSettings(withSchemaVersion({ campaignPriorities: { a: 2 } }, 6));
    expect(migrated.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "campaignPriorities",
        replacements: ["platform.twitch.campaignPins", "platform.kick.campaignPins"],
      }),
    );
    expect(platformOf(migrated.settings, "kick").campaignPins).toEqual(["a"]);
  });
});

describe("migration diagnostics", () => {
  // One document per legacy shape, each at the version that last wrote it.
  const legacyDocuments: Array<[string, Record<string, unknown>]> = [
    [
      "v0 aliases",
      {
        watchQueueFallbackOnly: false,
        verboseLogging: true,
        autoClaimChannelPoints: false,
        platform: { twitch: { watchQueueChannels: ["a"] } },
      },
    ],
    ["v1 campaignVisibility", withSchemaVersion({ campaignVisibility: { upcoming: false } }, 1)],
    [
      "v3 running",
      withSchemaVersion({ running: false, platform: { twitch: { enabled: true } } }, 3),
    ],
    [
      "v4 farmAllCategories",
      withSchemaVersion({ platform: { kick: { farmAllCategories: false } } }, 4),
    ],
    [
      "v6 ranking stack",
      withSchemaVersion(
        {
          campaignPriorities: { a: 2 },
          priorityMode: "priority_list_only",
          dropsListFilter: {},
          platform: { twitch: { categoryMode: "exclude", categories: [] } },
        },
        6,
      ),
    ],
    [
      "v7 eligibility",
      withSchemaVersion(
        {
          farmingEligibility: { farmUnlinkedCampaigns: false, farmSubscriptionCampaigns: false },
          farmPinnedOnly: true,
          platform: { twitch: { farmRewardTypes: ["badge"] } },
        },
        7,
      ),
    ],
    [
      "v6 exclude mode without a list",
      withSchemaVersion({ platform: { kick: { categoryMode: "exclude" } } }, 6),
    ],
    [
      "v8 unlinked switch",
      withSchemaVersion({ platform: { kick: { farmUnlinkedCampaigns: true } } }, 8),
    ],
    [
      "v10 shared campaign lists",
      withSchemaVersion({ campaignPins: ["a"], excludedCampaignIds: ["b"] }, 10),
    ],
  ];

  const hasPath = (source: unknown, path: string): boolean =>
    path.split(".").every((key) => {
      if (source === null || typeof source !== "object" || !Object.hasOwn(source, key))
        return false;
      source = (source as Record<string, unknown>)[key];
      return true;
    });

  // The CLI never rewrites its config, so these repeat on every start: each
  // has to name a line the user's file contains and, when it names a
  // replacement, a setting that still exists once every migration has run.
  it.each(legacyDocuments)("%s: names only paths the input has and the output keeps", (_, raw) => {
    const result = migrateSettings(raw);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(hasPath(raw, diagnostic.path), diagnostic.path).toBe(true);
      for (const replacement of [
        diagnostic.replacement ?? [],
        diagnostic.replacements ?? [],
      ].flat()) {
        expect(hasPath(result.settings, replacement), replacement).toBe(true);
      }
    }
  });

  it("reports a v7 unlinked switch once, under the key the file contains", () => {
    const result = migrateSettings(
      withSchemaVersion({ farmingEligibility: { farmUnlinkedCampaigns: false } }, 7),
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "farmingEligibility.farmUnlinkedCampaigns",
    ]);
  });
});
