import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { EngineSettings } from "@lurkloot/shared/models";
import { CURRENT_SETTINGS_SCHEMA_VERSION } from "@lurkloot/shared/settingsSchema";
import { defaultConfigJsonc, loadConfig } from "../src/config";
import {
  CliSettingsStoreError,
  cliSettingsPaths,
  createCliSettingsStore,
  engineToCliSettings,
} from "../src/settingsStore";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";

// One changed value for every key the CLI schema holds. The completeness test
// below fails when a CLI key is added without an entry here.
const MUTATIONS: Record<string, unknown> = {
  autoClaim: false,
  priorityMode: "lowest_availability",
  idleWatchlistFallbackOnly: false,
  preferKnownChannels: false,
  offlineRetryLimit: 7,
  pollIntervalMinutes: 15,
  postClaimHandoff: false,
  postClaimHandoffIntervalSeconds: 12,
  postClaimHandoffMaxSeconds: 90,
  skipUnfinishableRewards: false,
  deadlineSafetyMarginMinutes: 30,
  criticalFailurePromptEnabled: false,
  notifyRewardEarned: false,
  notifyNoDropsLeft: false,
  "platform.twitch.enabled": false,
  "platform.twitch.watchSourcePriority": [
    "watchlist",
    "drops",
    "watch_streaks",
    "nopixel",
    "fortnite",
  ],
  "platform.twitch.watchlistChannels": ["alpha", "beta", "gamma"],
  "platform.twitch.excludedChannels": ["spammer"],
  "platform.twitch.categoryMode": "include",
  "platform.twitch.rewardFilter": {
    kinds: ["item"],
    subscriptions: "skip",
    pinnedKinds: ["item", "badge"],
    favouriteKinds: [],
  },
  "platform.twitch.campaignPins": ["campaign-b", "campaign-a"],
  "platform.twitch.excludedCampaignIds": ["campaign-x"],
  "platform.twitch.unlinkedCampaigns": "last",
  "platform.twitch.categories": [{ id: "1", name: "Game One" }],
  "platform.twitch.favouriteCategories": [{ id: "2", name: "Game Two" }],
  "platform.twitch.blockedCategories": [{ id: "3", name: "Game Three" }],
  "platform.twitch.subscribedRewardMarks": ["campaign-a:reward-1"],
  "platform.twitch.autoClaimChannelPoints": false,
  "platform.twitch.strictCampaignAvailability": true,
  "platform.twitch.channelPointsPushClaim": false,
  "platform.twitch.watchlistStreakChannels": ["alpha"],
  "platform.twitch.watchStreakBudgetMinutes": 40,
  "platform.twitch.watchStreakRetryCooldownMinutes": 120,
  "platform.twitch.watchStreakMaxRounds": 5,
  "platform.twitch.alwaysEnterChat": true,
  "platform.kick.enabled": false,
  "platform.kick.watchSourcePriority": ["watchlist", "drops"],
  "platform.kick.watchlistChannels": ["kicker"],
  "platform.kick.excludedChannels": ["kickspam"],
  "platform.kick.categoryMode": "include",
  "platform.kick.rewardFilter": {
    kinds: [],
    subscriptions: "only",
    pinnedKinds: ["item"],
    favouriteKinds: ["item"],
  },
  "platform.kick.campaignPins": ["kick-campaign"],
  "platform.kick.excludedCampaignIds": ["kick-skip"],
  "platform.kick.unlinkedCampaigns": "skip",
  "platform.kick.categories": [{ id: "10", name: "Kick Game" }],
  "platform.kick.favouriteCategories": [{ id: "11", name: "Kick Favourite" }],
  "platform.kick.blockedCategories": [{ id: "12", name: "Kick Blocked" }],
  "platform.kick.subscribedRewardMarks": ["kick-campaign:reward-2"],
  "platform.kick.autoClaimChallenges": false,
  "platform.kick.alwaysEnterChat": true,
  "compatibility.twitch.profile": "twitch-2026-07",
  "compatibility.twitch.heartbeatTransport": "twitch-heartbeat-gql-v1",
  "compatibility.twitch.inventoryQueryVersion": "twitch-inventory-v1",
  "compatibility.kick.profile": "kick-2026-07",
  "compatibility.kick.claimLinkHandling": "kick-claim-v1",
};

// The base file lists the watchlist rows the streak mutation opts into, so
// that mutation also round-trips on its own.
const BASE_CONFIG = `{
  // Transport comment that must survive.
  "transport": "http",
  "authDir": "./credentials",
  "settings": {
    "schemaVersion": ${CURRENT_SETTINGS_SCHEMA_VERSION},
    // Settings comment that must survive a value edit.
    "pollIntervalMinutes": 5,
    "autoClaim": true,
    "platform": {
      "twitch": {
        "watchlistChannels": ["alpha", "beta"]
      }
    }
  }
}
`;

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const path = dotted.split(".");
  let current = target;
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string, unknown>;
  current[path[path.length - 1]] = structuredClone(value);
}

function getPath(target: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((value, segment) => (value as Record<string, unknown>)?.[segment], target);
}

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lurkloot-settings-store-"));
  configPath = join(dir, "config.json");
  writeFileSync(configPath, BASE_CONFIG, "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempFilesIn(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".tmp"));
}

describe("settings store round trip", () => {
  it("has a mutation for every CLI settings key", () => {
    expect(
      cliSettingsPaths()
        .map((path) => path.join("."))
        .sort(),
    ).toEqual(Object.keys(MUTATIONS).sort());
  });

  it("loads the engine settings run would build from the file", async () => {
    const store = createCliSettingsStore(configPath);
    expect(await store.load()).toEqual(toEngineSettings(loadConfig(configPath).settings));
  });

  it("round-trips every CLI key changed at once", async () => {
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    for (const [path, value] of Object.entries(MUTATIONS)) {
      setPath(engine as unknown as Record<string, unknown>, path, value);
    }
    await store.save(engine);
    const reloaded = await store.load();
    expect(reloaded).toEqual(engine);
    for (const [path, value] of Object.entries(MUTATIONS)) {
      expect(getPath(reloaded, path), path).toEqual(value);
    }
    // run reads the same file the same way.
    expect(toEngineSettings(loadConfig(configPath).settings)).toEqual(engine);
  });

  it.each(Object.keys(MUTATIONS))("round-trips %s on its own", async (path) => {
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    setPath(engine as unknown as Record<string, unknown>, path, MUTATIONS[path]);
    await store.save(engine);
    const reloaded = await store.load();
    expect(getPath(reloaded, path)).toEqual(MUTATIONS[path]);
    expect(reloaded).toEqual(engine);
  });

  it("accepts an unchanged save and leaves the file byte-identical", async () => {
    const store = createCliSettingsStore(configPath);
    await store.save(await store.load());
    expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
  });

  it("keeps comments, transport, authDir as written and key order on a value edit", async () => {
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    engine.pollIntervalMinutes = 20;
    engine.notifyNoDropsLeft = false;
    await store.save(engine);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("// Transport comment that must survive.");
    expect(text).toContain("// Settings comment that must survive a value edit.");
    const raw = parseJsonc(text) as Record<string, any>;
    expect(Object.keys(raw)).toEqual(["transport", "authDir", "settings"]);
    expect(raw.transport).toBe("http");
    expect(raw.authDir).toBe("./credentials");
    expect(Object.keys(raw.settings)).toEqual([
      "schemaVersion",
      "pollIntervalMinutes",
      "autoClaim",
      "platform",
      "notifyNoDropsLeft",
    ]);
    expect(raw.settings.pollIntervalMinutes).toBe(20);
  });

  it("edits the generated commented template in place", async () => {
    writeFileSync(configPath, defaultConfigJsonc(), "utf8");
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    engine.platform.kick.enabled = false;
    await store.save(engine);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("// Credentials are stored separately in this directory");
    expect(text).toContain('"authDir": "auth"');
    expect((await store.load()).platform.kick.enabled).toBe(false);
  });

  it("migrates a legacy settings block to the current form and keeps enabledLogLevels", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          authDir: "auth",
          settings: {
            enabledLogLevels: ["info"],
            pollIntervalMinutes: 4,
            tablessMode: false,
            platform: { twitch: { idleWatchlistChannels: ["legacy"] } },
          },
          transport: "impersonate",
        },
        null,
        2,
      ),
      "utf8",
    );
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    expect(engine.platform.twitch.watchlistChannels).toEqual(["legacy"]);
    engine.autoClaim = false;
    await store.save(engine);

    const raw = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(Object.keys(raw)).toEqual(["authDir", "settings", "transport"]);
    expect(raw.settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(raw.settings.enabledLogLevels).toEqual(["info"]);
    expect(Object.keys(raw.settings).slice(0, 2)).toEqual([
      "enabledLogLevels",
      "pollIntervalMinutes",
    ]);
    expect(raw.settings).not.toHaveProperty("tablessMode");
    expect(raw.settings.platform.twitch).not.toHaveProperty("idleWatchlistChannels");
    expect(raw.settings.platform.twitch.watchlistChannels).toEqual(["legacy"]);
    const reloaded = loadConfig(configPath);
    expect(toEngineSettings(reloaded.settings)).toEqual(engine);
    expect(reloaded.warnings).toEqual([
      "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error",
    ]);
  });

  it("writes a settings block into a file that has none", async () => {
    writeFileSync(configPath, '{ "transport": "http" }\n', "utf8");
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    engine.offlineRetryLimit = 9;
    await store.save(engine);
    const config = loadConfig(configPath);
    expect(config.transport).toBe("http");
    expect(config.settings.offlineRetryLimit).toBe(9);
    expect(toEngineSettings(config.settings)).toEqual(engine);
  });
});

describe("settings the CLI cannot hold", () => {
  async function expectRejected(
    change: (engine: Record<string, any>) => void,
    code: string,
    paths: string[],
  ) {
    const store = createCliSettingsStore(configPath);
    const engine = (await store.load()) as unknown as Record<string, any>;
    change(engine);
    const error = await store.save(engine as unknown as EngineSettings).catch((caught) => caught);
    expect(error).toBeInstanceOf(CliSettingsStoreError);
    expect(error.code).toBe(code);
    expect(error.paths).toEqual(paths);
    expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
    expect(tempFilesIn(dir)).toEqual([]);
  }

  it("rejects turning tabless mode off", async () => {
    await expectRejected((engine) => (engine.tablessMode = false), "unrepresentable", [
      "tablessMode",
    ]);
  });

  it("rejects the headless invariants toEngineSettings pins", async () => {
    await expectRejected(
      (engine) => {
        engine.pauseOnManualWatch = true;
        engine.autoStartDropFarming = false;
      },
      "unrepresentable",
      ["pauseOnManualWatch", "autoStartDropFarming"],
    );
  });

  it("rejects a tabless fallback limit other than the default", async () => {
    await expectRejected((engine) => (engine.tablessFallbackFailureLimit += 1), "unrepresentable", [
      "tablessFallbackFailureLimit",
    ]);
  });

  it("rejects extension-only fields", async () => {
    await expectRejected(
      (engine) => {
        engine.muteFarmingTabs = true;
        engine.twitchExtensions = { nopixel: { enabled: true } };
        engine.platform.twitch.tabOnly = true;
        engine.compatibility.extensionOnly = {};
      },
      "unrepresentable",
      [
        "platform.twitch.tabOnly",
        "compatibility.extensionOnly",
        "muteFarmingTabs",
        "twitchExtensions",
      ],
    );
  });

  it("accepts an engine-only field still at the value the CLI pins", async () => {
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    expect(engine.tablessMode).toBe(true);
    expect(engine.pauseOnManualWatch).toBe(false);
    expect(engine.autoStartDropFarming).toBe(true);
    engine.autoClaim = false;
    await store.save(engine);
    expect((await store.load()).autoClaim).toBe(false);
  });

  it("rejects values validate-config rejects", async () => {
    const store = createCliSettingsStore(configPath);
    const engine = (await store.load()) as unknown as Record<string, any>;
    engine.platform.kick.categoryMode = "exclude_all";
    const error = await store.save(engine as unknown as EngineSettings).catch((caught) => caught);
    expect(error).toBeInstanceOf(CliSettingsStoreError);
    expect(error.code).toBe("invalid");
    expect(error.message).toContain('"platform.kick.categoryMode" must be one of');
    expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
  });

  it("rejects a watchlist the CLI would cut down", () => {
    const engine = toEngineSettings(DEFAULT_CLI_SETTINGS);
    engine.platform.kick.watchlistChannels = Array.from({ length: 31 }, (_, i) => `c${i}`);
    expect(() => engineToCliSettings(engine)).toThrow(
      expect.objectContaining({ code: "invalid", paths: ["platform.kick.watchlistChannels"] }),
    );
  });
});

describe("atomic writes", () => {
  async function changedEngine() {
    const store = createCliSettingsStore(configPath);
    const engine = await store.load();
    engine.pollIntervalMinutes = 30;
    return engine;
  }

  it("leaves the old file intact when writing the temporary file fails", async () => {
    const engine = await changedEngine();
    const store = createCliSettingsStore(configPath, {
      fileSystem: {
        async writeTempFile(path, text) {
          // A partial write, then a full disk.
          await writeFile(path, text.slice(0, 10), "utf8");
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      },
    });
    await expect(store.save(engine)).rejects.toThrow("ENOSPC");
    expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
    expect(tempFilesIn(dir)).toEqual([]);
  });

  it("leaves the old file intact when the rename fails", async () => {
    const engine = await changedEngine();
    const store = createCliSettingsStore(configPath, {
      fileSystem: {
        rename: async () => {
          throw new Error("EXDEV: cross-device link not permitted");
        },
      },
    });
    await expect(store.save(engine)).rejects.toThrow("EXDEV");
    expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
    expect(tempFilesIn(dir)).toEqual([]);
    // A later save still works.
    await createCliSettingsStore(configPath).save(engine);
    expect(loadConfig(configPath).settings.pollIntervalMinutes).toBe(30);
  });

  it("writes through a temporary file in the same directory", async () => {
    const engine = await changedEngine();
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const store = createCliSettingsStore(configPath, {
      fileSystem: {
        async writeTempFile(path, text) {
          writes.push(path);
          await writeFile(path, text, "utf8");
        },
        async rename(from, to) {
          renames.push([from, to]);
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      },
    });
    await store.save(engine);
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith(join(dir, ".config.json."))).toBe(true);
    expect(renames).toEqual([[writes[0], configPath]]);
  });

  it("keeps the file mode", async () => {
    chmodSync(configPath, 0o600);
    await createCliSettingsStore(configPath).save(await changedEngine());
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(loadConfig(configPath).settings.pollIntervalMinutes).toBe(30);
  });

  it("replaces a symlinked config's target and keeps the link", async () => {
    const target = join(dir, "real-config.json");
    writeFileSync(target, BASE_CONFIG, "utf8");
    rmSync(configPath);
    symlinkSync(target, configPath);
    await createCliSettingsStore(configPath).save(await changedEngine());
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "real-config.json"]);
    expect(loadConfig(target).settings.pollIntervalMinutes).toBe(30);
  });

  it("applies concurrent saves one at a time", async () => {
    const store = createCliSettingsStore(configPath);
    const first = await store.load();
    first.pollIntervalMinutes = 10;
    const second = structuredClone(first);
    second.pollIntervalMinutes = 11;
    await Promise.all([store.save(first), store.save(second)]);
    expect((await store.load()).pollIntervalMinutes).toBe(11);
    expect(tempFilesIn(dir)).toEqual([]);
  });
});

describe("store boundaries", () => {
  it("refuses to save over a config file it cannot load", async () => {
    const broken = '{ "transport": "http", "settings": { "autoClaim": tru } }\n';
    writeFileSync(configPath, broken, "utf8");
    const engine = toEngineSettings(DEFAULT_CLI_SETTINGS);
    const error = await createCliSettingsStore(configPath)
      .save(engine)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(CliSettingsStoreError);
    expect(error.code).toBe("config_unreadable");
    expect(readFileSync(configPath, "utf8")).toBe(broken);
  });

  // `run` reads config.json and never writes it; only `serve` saves settings.
  it("is not used by the run loop", () => {
    const run = readFileSync(new URL("../src/runtime/run.ts", import.meta.url), "utf8");
    expect(run).not.toMatch(/settingsStore/);
  });
});
