import { describe, expect, it, vi } from "vitest";
import {
  ADAPTER_BACKED_SETTINGS,
  adapterOffers,
  CLI_CAPABILITIES,
  inertAdapterSettings,
  type AdapterFeature,
} from "@lurkloot/core/controller";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { CycleTLSClient } from "cycletls";
import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { parseConfig, type Transport } from "../src/config";
import { cliAcceptedSettingPaths, DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { createHttpTransport } from "../src/transport/http";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { createCliAdapters } from "../src/transport/common";
import type { TransportHandle } from "../src/transport";
import { runLoop } from "../src/runtime/run";
import type { Logger } from "../src/logger";

// Guards the CLI settings schema (#1090): every key the CLI accepts either does
// something on the CLI, or is a known gap the runtime warns about and that
// names the issue fixing it. Adding an accepted key with no mapping fails here.

// Settings the CLI accepts that need a feature its adapters do not offer yet.
// Each one warns once at runtime (adapterSettings.ts). When the issue lands,
// the "is still a gap" test fails: delete that key's line.
const KNOWN_GAPS: Record<string, { issue: string; sample: unknown }> = {
  // Twitch Hermes push on the CLI.
  "platform.twitch.channelPointsPushClaim": { issue: issueUrl(1084), sample: true },
  "platform.twitch.watchlistStreakChannels": { issue: issueUrl(1084), sample: ["streamer"] },
  "platform.twitch.watchStreakBudgetMinutes": { issue: issueUrl(1084), sample: 20 },
  "platform.twitch.watchStreakRetryCooldownMinutes": { issue: issueUrl(1084), sample: 60 },
  "platform.twitch.watchStreakMaxRounds": { issue: issueUrl(1084), sample: 4 },
  // Kick chat presence on the CLI.
  "platform.kick.alwaysEnterChat": { issue: issueUrl(1085), sample: true },
};

function issueUrl(number: number): string {
  return `https://github.com/jamezrin/lurkloot/issues/${number}`;
}

// How every other accepted key takes effect. Per-platform keys whose effect
// depends on an adapter feature come from core's ADAPTER_BACKED_SETTINGS and
// are not repeated here.
type Backing =
  // Read by the shared engine (scheduler, controller), which runs the same on
  // every host and needs nothing from the adapter.
  | { engine: string }
  // Passed by the CLI to the adapter it builds, or resolved for it.
  | { adapterOption: string }
  // Needs an adapter feature, checked against the CLI's built adapters below.
  | { feature: AdapterFeature; platforms: readonly Platform[] }
  // Accepted only so the config parser can warn that it is ignored.
  | { parserWarning: string };

const engine = (reason: string): Backing => ({ engine: reason });
const PER_PLATFORM: Record<string, Backing> = {
  enabled: engine("turns the platform's ticks on"),
  watchSourcePriority: engine("orders watch sources in the scheduler"),
  watchlistChannels: engine("scheduler channel candidates"),
  excludedChannels: engine("scheduler channel filter"),
  categoryMode: engine("scheduler campaign filter"),
  rewardFilter: engine("scheduler reward filter"),
  campaignPins: engine("scheduler campaign priority"),
  excludedCampaignIds: engine("scheduler campaign filter"),
  unlinkedCampaigns: engine("scheduler campaign filter"),
  categories: engine("scheduler campaign filter and CLI live discovery games"),
  favouriteCategories: engine("scheduler campaign priority and CLI live discovery games"),
  blockedCategories: engine("scheduler campaign filter"),
  subscribedRewardMarks: engine("scheduler subscription detection"),
};
const BACKING: Record<string, Backing> = {
  autoClaim: engine("claim service"),
  priorityMode: engine("scheduler campaign order"),
  idleWatchlistFallbackOnly: engine("watch source priority migration input"),
  preferKnownChannels: engine("scheduler channel order"),
  offlineRetryLimit: engine("scheduler offline rotation"),
  pollIntervalMinutes: engine("cadence jobs"),
  postClaimHandoff: { feature: "postClaimHandoff", platforms: ["twitch", "kick"] },
  postClaimHandoffIntervalSeconds: { feature: "postClaimHandoff", platforms: ["twitch", "kick"] },
  postClaimHandoffMaxSeconds: { feature: "postClaimHandoff", platforms: ["twitch", "kick"] },
  skipUnfinishableRewards: engine("scheduler reward filter"),
  deadlineSafetyMarginMinutes: engine("scheduler deadline check"),
  criticalFailurePromptEnabled: engine("critical-failure detector"),
  enabledLogLevels: {
    parserWarning:
      "settings.enabledLogLevels is deprecated and ignored; use --log debug|info|warn|error",
  },
  notifyRewardEarned: engine("controller notifications, logged by the CLI"),
  notifyNoDropsLeft: engine("controller notifications, logged by the CLI"),
  ...Object.fromEntries(
    (["twitch", "kick"] as const).flatMap((platform) =>
      Object.entries(PER_PLATFORM).map(([key, backing]) => [
        `platform.${platform}.${key}`,
        backing,
      ]),
    ),
  ),
  "platform.twitch.autoClaimChannelPoints": {
    feature: "claimChannelPoints",
    platforms: ["twitch"],
  },
  "platform.twitch.strictCampaignAvailability": {
    adapterOption: "TwitchAdapterOptions.strictCampaignAvailability",
  },
  "platform.kick.autoClaimChallenges": { feature: "claimChallenges", platforms: ["kick"] },
  "compatibility.twitch.profile": { adapterOption: "resolveCompatibility" },
  "compatibility.twitch.heartbeatTransport": { adapterOption: "resolveCompatibility" },
  "compatibility.twitch.inventoryQueryVersion": { adapterOption: "resolveCompatibility" },
  "compatibility.kick.profile": { adapterOption: "resolveCompatibility" },
  "compatibility.kick.claimLinkHandling": { adapterOption: "resolveCompatibility" },
};

// The core-owned adapter-backed keys, one per platform settings field.
const CORE_BACKED = new Map<string, { feature: AdapterFeature; platform: Platform }>(
  (["twitch", "kick"] as const).flatMap((platform) =>
    ADAPTER_BACKED_SETTINGS.filter((entry) =>
      cliAcceptedSettingPaths().includes(`platform.${platform}.${entry.field}`),
    ).map((entry) => [`platform.${platform}.${entry.field}`, { feature: entry.feature, platform }]),
  ),
);

// The transports that farm each platform. `http` is for Twitch-only setups:
// it never opens Kick's viewer socket, so Kick features are checked on
// `impersonate` only.
const PLATFORM_TRANSPORTS: Record<Platform, readonly Transport[]> = {
  twitch: ["http", "impersonate"],
  kick: ["impersonate"],
};

function fakeCycleClient(): CycleTLSClient {
  const client = vi.fn(async () => ({ status: 200, data: {} })) as unknown as CycleTLSClient;
  Object.assign(client, { exit: vi.fn(async () => undefined) });
  return client;
}

const CREDENTIALS = {
  twitch: { authToken: "token", clientId: "ue6666qo983tsx6so1t0vnawi233wa" },
  kick: { sessionToken: "session" },
};

// The adapters each production transport builds, from the production wiring.
async function builtAdapters(): Promise<
  Record<Transport, { handle: TransportHandle; adapters: Record<Platform, PlatformAdapter> }>
> {
  const settings = toEngineSettings(DEFAULT_CLI_SETTINGS);
  const http = createHttpTransport(CREDENTIALS, { twitch: true, kick: true });
  const impersonate = await createImpersonateTransport(
    CREDENTIALS,
    { twitch: true, kick: true },
    { initClient: async () => fakeCycleClient() },
  );
  return {
    http: { handle: http, adapters: http.createAdapters(() => {}, settings).adapters },
    impersonate: {
      handle: impersonate,
      adapters: impersonate.createAdapters(() => {}, settings).adapters,
    },
  };
}

function offeredEverywhere(
  built: Awaited<ReturnType<typeof builtAdapters>>,
  feature: AdapterFeature,
  platform: Platform,
): boolean {
  return PLATFORM_TRANSPORTS[platform].every((transport) =>
    adapterOffers(built[transport].adapters[platform], feature),
  );
}

function withValue(path: string, value: unknown): EngineSettings {
  const settings = structuredClone(toEngineSettings(DEFAULT_CLI_SETTINGS)) as unknown as Record<
    string,
    unknown
  >;
  const parts = path.split(".");
  let target = settings;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
  return settings as unknown as EngineSettings;
}

function platformOf(path: string): Platform {
  return path.split(".")[1] as Platform;
}

describe("CLI settings guard (#1090)", () => {
  it("maps every accepted key to how it takes effect, or to a known gap", () => {
    const unmapped = cliAcceptedSettingPaths().filter(
      (path) => !(path in BACKING) && !CORE_BACKED.has(path),
    );
    expect(unmapped).toEqual([]);
  });

  it("maps no key the CLI does not accept", () => {
    const accepted = new Set(cliAcceptedSettingPaths());
    expect(Object.keys(BACKING).filter((path) => !accepted.has(path))).toEqual([]);
    expect(Object.keys(KNOWN_GAPS).filter((path) => !accepted.has(path))).toEqual([]);
  });

  it("backs every feature-backed key with the CLI's adapters, unless it is a known gap", async () => {
    const built = await builtAdapters();
    try {
      const missing: string[] = [];
      for (const [path, { feature, platform }] of CORE_BACKED) {
        if (!offeredEverywhere(built, feature, platform) && !(path in KNOWN_GAPS)) {
          missing.push(`${path} needs ${feature}`);
        }
      }
      for (const [path, backing] of Object.entries(BACKING)) {
        if (!("feature" in backing)) continue;
        // A top-level key needs the feature on at least one platform.
        const offered = backing.platforms.some((platform) =>
          offeredEverywhere(built, backing.feature, platform),
        );
        if (!offered && !(path in KNOWN_GAPS)) missing.push(`${path} needs ${backing.feature}`);
      }
      expect(missing).toEqual([]);
    } finally {
      await built.http.handle.dispose();
      await built.impersonate.handle.dispose();
    }
  });

  it("keeps each known gap a real gap that links its issue", async () => {
    const built = await builtAdapters();
    try {
      for (const [path, gap] of Object.entries(KNOWN_GAPS)) {
        expect(gap.issue).toMatch(/^https:\/\/github\.com\/jamezrin\/lurkloot\/issues\/\d+$/);
        const backing = CORE_BACKED.get(path);
        // A gap must be an adapter-backed key, so the runtime can warn about it.
        expect(backing, `${path} is not an adapter-backed setting`).toBeDefined();
        expect(
          offeredEverywhere(built, backing!.feature, backing!.platform),
          `${path} now works on the CLI (${gap.issue}); remove it from KNOWN_GAPS`,
        ).toBe(false);
      }
    } finally {
      await built.http.handle.dispose();
      await built.impersonate.handle.dispose();
    }
  });

  it("warns about each known gap with the CLI's own adapters", async () => {
    const built = await builtAdapters();
    try {
      for (const [path, gap] of Object.entries(KNOWN_GAPS)) {
        const platform = platformOf(path);
        const settings = withValue(path, gap.sample);
        for (const transport of PLATFORM_TRANSPORTS[platform]) {
          const inert = inertAdapterSettings(
            platform,
            settings,
            built[transport].adapters[platform],
            CLI_CAPABILITIES,
          );
          expect(
            inert.map((setting) => setting.key),
            `${path} on ${transport}`,
          ).toContain(path);
        }
      }
    } finally {
      await built.http.handle.dispose();
      await built.impersonate.handle.dispose();
    }
  });

  it("warns that enabledLogLevels is ignored", () => {
    const backing = BACKING.enabledLogLevels as { parserWarning: string };
    const config = parseConfig({ settings: { enabledLogLevels: ["error"] } }, "/tmp/config.json");
    expect(config.warnings).toContain(backing.parserWarning);
  });
});

describe("CLI run with inert settings (#1090)", () => {
  it("logs one warning per known gap", async () => {
    const settings = structuredClone(DEFAULT_CLI_SETTINGS);
    for (const [path, gap] of Object.entries(KNOWN_GAPS)) {
      const parts = path.split(".");
      const platformSettings = settings.platform[parts[1] as Platform] as unknown as Record<
        string,
        unknown
      >;
      platformSettings[parts[2]!] = gap.sample;
    }
    settings.platform.twitch.watchlistChannels = ["streamer"];
    // Offline adapters with the CLI's own wiring: Twitch has a chat socket
    // factory and no Hermes, Kick has no realtime connection.
    const built = createCliAdapters(CREDENTIALS, {
      twitchFetcher: () => ({
        fetchJson: async <T>() => ({ data: { currentUser: { id: "1", login: "viewer" } } }) as T,
      }),
      twitchHeartbeat: () => ({
        heartbeatFetchText: async () => "",
        heartbeatPost: async () => ({ status: 200 }),
        heartbeatExchange: async () => ({ status: 200, body: "" }),
      }),
      kickFetcher: () => ({ fetchJson: async <T>() => ({}) as T }),
      kickWebSocketFactory: () => () => {
        throw new Error("offline");
      },
      twitchChatWebSocketFactory: () => () => {
        throw new Error("offline");
      },
    });
    const warnings: string[] = [];
    const logger: Logger = {
      level: "debug",
      // Engine diagnostics reach the CLI logger through log(level, …).
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    };
    const transport: TransportHandle = { ...built, dispose: async () => {} };
    let state: SchedulerState = structuredClone(DEFAULT_STATE);
    const stateStore = {
      load: async () => state,
      save: async (next: SchedulerState) => {
        state = next;
      },
    };
    await runLoop({
      settings,
      statePath: "/nonexistent/state.json",
      transport,
      logger,
      once: true,
      stateStore,
      checkCredentialAvailability: async () => ({ status: "available" }),
    });
    for (const path of Object.keys(KNOWN_GAPS)) {
      const lines = warnings.filter((message) => message.includes(`${path} has no effect`));
      expect(lines, path).toHaveLength(1);
    }
  });
});
