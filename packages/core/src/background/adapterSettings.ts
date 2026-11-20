import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import { DEFAULT_ENGINE_SETTINGS } from "@lurkloot/shared/settings";
import type { PlatformAdapter } from "../platforms/adapter";
import { platformLabel } from "./helpers";
import type { HostCapabilities } from "./hostPorts";

// Optional work a built adapter can offer beyond the PlatformAdapter baseline
// (#1090). Read from the adapter itself, never from the host or the platform
// name, so a host whose adapter lacks a factory (Hermes or Kick chat on the
// CLI) is told so instead of a host-wide flag hiding the gap.
export type AdapterFeature =
  | "chatPresence"
  | "channelPointsPush"
  | "claimChannelPoints"
  | "claimChallenges"
  | "postClaimHandoff";

export const ADAPTER_FEATURES: readonly AdapterFeature[] = [
  "chatPresence",
  "channelPointsPush",
  "claimChannelPoints",
  "claimChallenges",
  "postClaimHandoff",
];

export function adapterOffers(adapter: PlatformAdapter, feature: AdapterFeature): boolean {
  switch (feature) {
    case "chatPresence":
      return typeof adapter.createChatPresenceClient === "function";
    case "channelPointsPush":
      return typeof adapter.createChannelPointsPushController === "function";
    case "claimChannelPoints":
      return typeof adapter.claimChannelPoints === "function";
    case "claimChallenges":
      return typeof adapter.claimChallenges === "function";
    case "postClaimHandoff":
      return adapter.supportsPostClaimHandoff === true;
  }
}

export function adapterFeatures(adapter: PlatformAdapter): ReadonlySet<AdapterFeature> {
  return new Set(ADAPTER_FEATURES.filter((feature) => adapterOffers(adapter, feature)));
}

type PlatformSettingsRecord = Readonly<Record<string, unknown>>;

// A per-platform setting that does something only when the platform's adapter
// offers `feature` (and the host declares `hostCapability`, where one gates it).
export interface AdapterBackedSetting {
  // The field under `settings.platform[platform]`. A platform whose settings
  // have no such field never reads it, so the entry does not apply there.
  readonly field: string;
  readonly feature: AdapterFeature;
  readonly hostCapability?: keyof HostCapabilities;
  // Whether this value asks for the feature. A value that asks for nothing (a
  // switch left off, an untouched tuning value) is never reported.
  readonly requested: (
    value: unknown,
    platformSettings: PlatformSettingsRecord,
    defaultValue: unknown,
  ) => boolean;
}

const isTrue = (value: unknown): boolean => value === true;
const isNonEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
const differsFromDefault = (value: unknown, _settings: unknown, defaultValue: unknown): boolean =>
  JSON.stringify(value) !== JSON.stringify(defaultValue);

// The per-platform settings whose effect depends on a feature some host's
// adapter lacks, so the tick warns about them. `autoClaimChannelPoints` and
// `autoClaimChallenges` also need an adapter feature (claimChannelPoints,
// claimChallenges) but are left out on purpose: every real adapter offers
// them, the CLI guard test maps them itself, and many controller-test fakes
// lack them, so listing them would only warn about fakes. The CLI's guard test
// (packages/cli/tests/inertSettings.test.ts) checks each key the CLI accepts
// against this list and the CLI's built adapters.
export const ADAPTER_BACKED_SETTINGS: readonly AdapterBackedSetting[] = [
  {
    field: "alwaysEnterChat",
    feature: "chatPresence",
    hostCapability: "chatPresence",
    requested: isTrue,
  },
  {
    field: "channelPointsPushClaim",
    feature: "channelPointsPush",
    // Push claiming only speeds up claims that autoClaimChannelPoints makes.
    requested: (value, settings) => value === true && settings.autoClaimChannelPoints === true,
  },
  { field: "watchlistStreakChannels", feature: "channelPointsPush", requested: isNonEmptyList },
  {
    field: "watchStreakBudgetMinutes",
    feature: "channelPointsPush",
    requested: differsFromDefault,
  },
  {
    field: "watchStreakRetryCooldownMinutes",
    feature: "channelPointsPush",
    requested: differsFromDefault,
  },
  { field: "watchStreakMaxRounds", feature: "channelPointsPush", requested: differsFromDefault },
];

const FEATURE_GAP: Record<AdapterFeature, string> = {
  chatPresence: "cannot join channel chat",
  channelPointsPush: "has no live push connection",
  claimChannelPoints: "cannot claim channel points",
  claimChallenges: "cannot claim challenges",
  postClaimHandoff: "has no post-claim handoff",
};

export interface InertSetting {
  // Dotted settings path, such as `platform.kick.alwaysEnterChat`.
  readonly key: string;
  readonly platform: Platform;
  readonly message: string;
}

// The requested per-platform settings `adapter` cannot honour. Settings whose
// host capability is missing are left out: the host-wide report names those.
export function inertAdapterSettings(
  platform: Platform,
  settings: EngineSettings,
  adapter: PlatformAdapter,
  capabilities: HostCapabilities,
): InertSetting[] {
  return requestedAdapterSettings(platform, settings, capabilities)
    .filter(({ entry }) => !adapterOffers(adapter, entry.feature))
    .map(({ key, entry }) => ({
      key,
      platform,
      message: `${platformLabel(platform)} on this host ${FEATURE_GAP[entry.feature]}, so ${key} has no effect`,
    }));
}

// The adapter-backed settings `platform` asks for, so a caller can skip
// building an adapter when nothing could be inert.
export function requestedAdapterSettings(
  platform: Platform,
  settings: EngineSettings,
  capabilities: HostCapabilities,
): Array<{ key: string; entry: AdapterBackedSetting }> {
  const values = settings.platform[platform] as unknown as PlatformSettingsRecord;
  const defaults = DEFAULT_ENGINE_SETTINGS.platform[platform] as unknown as PlatformSettingsRecord;
  return ADAPTER_BACKED_SETTINGS.filter(
    (entry) =>
      Object.hasOwn(values, entry.field)
      && (entry.hostCapability === undefined || capabilities[entry.hostCapability])
      && entry.requested(values[entry.field], values, defaults[entry.field]),
  ).map((entry) => ({ key: `platform.${platform}.${entry.field}`, entry }));
}
