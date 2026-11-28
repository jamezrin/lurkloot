import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_BACKED_SETTINGS,
  adapterOffers,
  CLI_CAPABILITIES,
  inertAdapterSettings,
  type AdapterFeature,
} from "@lurkloot/core/controller";
import { PLATFORMS, type Platform, type SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import { parseConfig, TRANSPORTS as TRANSPORT_NAMES, type Transport } from "../src/config";
import { impersonationBackendOf } from "../src/transport";
import {
  TWITCH_ANDROID_CLIENT_ID,
  TWITCH_SMARTBOX_CLIENT_ID,
  TWITCH_WEB_CLIENT_ID,
} from "../src/twitch";
import { cliAcceptedSettingPaths, DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import { createHttpTransport } from "../src/transport/http";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { fakeCycleTls } from "./helpers/fakeCycleTls";
import { runLoop } from "../src/runtime/run";
import type { Logger } from "../src/logger";

// Guards the CLI settings schema (#1090): every key the CLI accepts either does
// something on the CLI, or is a known gap the runtime warns about and that
// names the issue fixing it. Adding an accepted key with no mapping fails here.

const TRANSPORTS = TRANSPORT_NAMES satisfies readonly Transport[];
const TWITCH_SIGN_INS = [
  { signIn: "web", clientId: TWITCH_WEB_CLIENT_ID },
  { signIn: "android", clientId: TWITCH_ANDROID_CLIENT_ID },
  { signIn: "smart-tv", clientId: TWITCH_SMARTBOX_CLIENT_ID },
] as const;
const TWITCH_CASES = TRANSPORTS.flatMap((transport) =>
  TWITCH_SIGN_INS.map(({ signIn, clientId }) => ({
    name: `twitch/${transport}/${signIn}` as const,
    platform: "twitch" as const,
    transport,
    clientId,
  })),
);
const KICK_CASES = TRANSPORTS.map((transport) => ({
  name: `kick/${transport}` as const,
  platform: "kick" as const,
  transport,
  clientId: TWITCH_SMARTBOX_CLIENT_ID,
}));
const ADAPTER_CASES = [...TWITCH_CASES, ...KICK_CASES];
type AdapterCaseName = (typeof ADAPTER_CASES)[number]["name"];

// List only the combinations missing each feature.
const KNOWN_GAPS: ReadonlyArray<{
  feature: AdapterFeature;
  cases: readonly AdapterCaseName[];
  issue: string;
}> = [{ feature: "chatPresence", cases: ["kick/http"], issue: issueUrl(1099) }];

// Values that request adapter features and differ from the defaults.
const WARNING_SAMPLES = {
  "platform.twitch.watchlistStreakChannels": ["streamer"],
  "platform.twitch.watchStreakBudgetMinutes": 20,
  "platform.twitch.watchStreakRetryCooldownMinutes": 60,
  "platform.twitch.watchStreakMaxRounds": 4,
  "platform.kick.alwaysEnterChat": true,
};

// Gapped adapter-backed keys that cannot have a warning sample, with why.
const NO_WARNING_SAMPLE: Record<string, string> = {};

function issueUrl(number: number): string {
  return `https://github.com/jamezrin/lurkloot/issues/${number}`;
}

// Keep the runtime warning test offline while exercising the real adapters.
const { openHermes } = vi.hoisted(() => ({
  openHermes: vi.fn(() => ({
    readyState: 0,
    send: () => {},
    close: () => {},
    addEventListener: (type: string, listener: () => void) => {
      if (type === "close") queueMicrotask(listener);
    },
  })),
}));
vi.mock("../src/transport/twitchHermes", () => ({
  createNodeTwitchHermesWebSocketFactory: () => openHermes,
}));

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
  watchPauseSchedule: engine("scheduler watch pause and its boundary job"),
  "twitchExtensions.nopixel.enabled": engine("supplemental source selection and driver admission"),
  "twitchExtensions.nopixel.autoOpenPacks": engine("NoPixel driver pack opening"),
  "twitchExtensions.fortnite.enabled": engine("supplemental source selection and driver admission"),
  "twitchExtensions.fortnite.allowTakeovers": engine("Fortnite driver takeover commands"),
  ...Object.fromEntries(
    PLATFORMS.flatMap((platform) =>
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
  PLATFORMS.flatMap((platform) =>
    ADAPTER_BACKED_SETTINGS.filter((entry) =>
      cliAcceptedSettingPaths().includes(`platform.${platform}.${entry.field}`),
    ).map((entry) => [`platform.${platform}.${entry.field}`, { feature: entry.feature, platform }]),
  ),
);

function fakeCycleClient() {
  return fakeCycleTls();
}

// Every impersonating transport builds the same adapters over its client; the
// impit ones get an impit-shaped fake, cycletls its own.
function fakeImpitClient() {
  return {
    backend: "impit" as const,
    request: vi.fn(async () => ({ status: 200, headers: {}, body: "{}" })),
    close: vi.fn(async () => undefined),
  };
}

function credentials(clientId: string) {
  return { twitch: { authToken: "token", clientId }, kick: { sessionToken: "session" } };
}

function gapsFor(name: AdapterCaseName) {
  return KNOWN_GAPS.filter((gap) => gap.cases.includes(name));
}

function warningPaths(name: AdapterCaseName): string[] {
  const gaps = gapsFor(name);
  return Object.keys(WARNING_SAMPLES).filter(
    (path) =>
      gaps.some((gap) => gap.feature === CORE_BACKED.get(path)?.feature)
      && path.startsWith(`platform.${name.split("/")[0]}.`),
  );
}

function settingsWithSamples(paths: readonly string[]) {
  const settings = structuredClone(DEFAULT_CLI_SETTINGS);
  for (const [path, value] of Object.entries(WARNING_SAMPLES)) {
    if (!paths.includes(path)) continue;
    const [, platform, field] = path.split(".") as [string, Platform, string];
    const values = settings.platform[platform] as unknown as Record<string, unknown>;
    values[field] = value;
  }
  settings.platform.twitch.watchlistChannels = [
    ...WARNING_SAMPLES["platform.twitch.watchlistStreakChannels"],
  ];
  return settings;
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
    expect(Object.keys(WARNING_SAMPLES).filter((path) => !CORE_BACKED.has(path))).toEqual([]);
  });

  it("samples a warning for every adapter-backed key with a known gap", () => {
    const gapped = [...CORE_BACKED].filter(([, backing]) =>
      KNOWN_GAPS.some(
        (gap) =>
          gap.feature === backing.feature
          && gap.cases.some((name) => name.startsWith(`${backing.platform}/`)),
      ),
    );
    const unsampled = gapped
      .map(([path]) => path)
      .filter((path) => !(path in WARNING_SAMPLES) && !(path in NO_WARNING_SAMPLE));
    expect(unsampled).toEqual([]);
    const gappedPaths = new Set(gapped.map(([path]) => path));
    expect(Object.keys(NO_WARNING_SAMPLE).filter((path) => !gappedPaths.has(path))).toEqual([]);
  });

  it.each(ADAPTER_CASES)("checks adapter backing and warnings for $name", async (entry) => {
    const { name, platform, transport, clientId } = entry;
    const enabled = { twitch: true, kick: true };
    const creds = credentials(clientId);
    const backend = impersonationBackendOf(transport);
    const handle =
      backend === undefined
        ? createHttpTransport(creds, enabled)
        : await createImpersonateTransport(
            creds,
            enabled,
            backend === "cycletls"
              ? { initClient: async () => fakeCycleClient() }
              : { createClient: async () => fakeImpitClient() },
          );
    try {
      const settings = toEngineSettings(settingsWithSamples(Object.keys(WARNING_SAMPLES)));
      const { adapters } = handle.createAdapters(() => {}, settings);
      const adapter = adapters[platform];
      const gaps = gapsFor(name);
      const coreFeatures = [...CORE_BACKED.values()]
        .filter((backing) => backing.platform === platform)
        .map((backing) => backing.feature);
      for (const gap of gaps) {
        expect(gap.issue).toMatch(/^https:\/\/github\.com\/jamezrin\/lurkloot\/issues\/\d+$/);
        expect(
          coreFeatures,
          `${name} ${gap.feature} must back a setting the runtime can warn about`,
        ).toContain(gap.feature);
        expect(
          adapterOffers(adapter, gap.feature),
          `${name} now offers ${gap.feature} (${gap.issue}); narrow or remove the gap in KNOWN_GAPS`,
        ).toBe(false);
      }
      for (const [path, backing] of CORE_BACKED) {
        if (backing.platform !== platform) continue;
        expect(
          adapterOffers(adapter, backing.feature)
            || gaps.some((gap) => gap.feature === backing.feature),
          `${path} needs ${backing.feature} on ${name}`,
        ).toBe(true);
      }
      for (const [path, backing] of Object.entries(BACKING)) {
        if (!("feature" in backing)) continue;
        if (backing.platforms.length === 1 && !backing.platforms.includes(platform)) continue;
        // Top-level settings need at least one platform on this transport.
        // Check them with every Twitch sign-in, alongside its Kick adapter.
        if (backing.platforms.length > 1 && platform !== "twitch") continue;
        expect(
          backing.platforms.some((target) => adapterOffers(adapters[target], backing.feature)),
          `${path} needs ${backing.feature} on ${name}`,
        ).toBe(true);
      }
      expect(
        inertAdapterSettings(platform, settings, adapter, CLI_CAPABILITIES)
          .map(({ key }) => key)
          .sort(),
      ).toEqual(warningPaths(name).sort());
    } finally {
      await handle.dispose();
    }
  });

  it("warns that enabledLogLevels is ignored", () => {
    const backing = BACKING.enabledLogLevels as { parserWarning: string };
    const config = parseConfig({ settings: { enabledLogLevels: ["error"] } }, "/tmp/config.json");
    expect(config.warnings).toContain(backing.parserWarning);
  });
});

describe("CLI run with inert settings on http (#1090)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const optedInWarnings = [...warningPaths("twitch/http/smart-tv"), ...warningPaths("kick/http")];

  it.each([
    { name: "defaults", settings: DEFAULT_CLI_SETTINGS, expected: [] },
    {
      name: "push claim disabled",
      settings: {
        ...DEFAULT_CLI_SETTINGS,
        platform: {
          ...DEFAULT_CLI_SETTINGS.platform,
          twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, channelPointsPushClaim: false },
        },
      },
      expected: [],
    },
    {
      name: "changed settings",
      settings: settingsWithSamples(Object.keys(WARNING_SAMPLES)),
      expected: optedInWarnings,
    },
  ])("logs only the requested inert settings once with $name", async ({ settings, expected }) => {
    openHermes.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new URL(url).hostname === "gql.twitch.tv"
          ? Response.json({ data: { currentUser: { id: "1", login: "viewer" } } })
          : Response.json({ message: "Request blocked" }, { status: 403 }),
      ),
    );
    const transport = createHttpTransport(credentials(TWITCH_SMARTBOX_CLIENT_ID), {
      twitch: true,
      kick: true,
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
    let state: SchedulerState = structuredClone(DEFAULT_STATE);
    // A persisted farming session wants the points topic even with untouched
    // settings and no configured Watchlist.
    state.farmingSessions = {
      twitch: { id: "twitch-session", startedAt: new Date().toISOString() },
    };
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
    expect(openHermes).toHaveBeenCalledTimes(1);
    expect(warnings.filter((message) => /channel-points push|Hermes/.test(message))).toEqual([]);
    expect(warnings.filter((message) => message.endsWith("has no effect"))).toHaveLength(
      expected.length,
    );
    for (const path of expected) {
      const lines = warnings.filter((message) => message.endsWith(`${path} has no effect`));
      expect(lines, path).toHaveLength(1);
    }
  });
});
