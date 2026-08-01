import {
  TWITCH_DISCOVERY_SNAPSHOT_MAX_ENTRIES,
  TWITCH_DISCOVERY_SNAPSHOT_VERSION,
  type Platform,
  type PlatformAuthHealth,
  type PlatformAuthMessageKey,
  type PlatformAuthReasonCode,
  type PlatformAuthStatus,
  type SchedulerState,
  type TwitchDiscoverySnapshot,
  type TwitchDiscoverySnapshotEntry,
} from "@lurkloot/shared/models";
import { normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";

const AUTH_STATUSES = new Set<PlatformAuthStatus>([
  "checking",
  "healthy",
  "missing_credentials",
  "invalid_credentials",
  "blocked",
  "unavailable",
]);

const AUTH_REASONS: Record<PlatformAuthStatus, readonly PlatformAuthReasonCode[]> = {
  checking: [],
  healthy: [],
  missing_credentials: ["credentials_missing"],
  invalid_credentials: ["credentials_rejected"],
  blocked: ["security_policy_blocked"],
  unavailable: ["credential_lookup_failed", "platform_unavailable", "network_unavailable"],
};

const AUTH_MESSAGE_KEYS: Record<PlatformAuthStatus | PlatformAuthReasonCode, PlatformAuthMessageKey> = {
  checking: "authChecking",
  healthy: "authHealthy",
  missing_credentials: "authMissingCredentials",
  invalid_credentials: "authInvalidCredentials",
  blocked: "authSecurityPolicyBlocked",
  unavailable: "authPlatformUnavailable",
  credentials_missing: "authMissingCredentials",
  credentials_rejected: "authInvalidCredentials",
  security_policy_blocked: "authSecurityPolicyBlocked",
  credential_lookup_failed: "authCredentialLookupFailed",
  platform_unavailable: "authPlatformUnavailable",
  network_unavailable: "authNetworkUnavailable",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isTwitchCampaignDetailPayload(value: unknown, dropID: string): value is Record<string, unknown> {
  return isRecord(value)
    && value.id === dropID
    && typeof value.name === "string"
    && value.name.length > 0
    && Array.isArray(value.timeBasedDrops);
}

export function normalizeTwitchDiscoverySnapshot(value: unknown): TwitchDiscoverySnapshot | undefined {
  if (!isRecord(value) || value.version !== TWITCH_DISCOVERY_SNAPSHOT_VERSION) return undefined;
  if (typeof value.userId !== "string" || value.userId.length === 0 || value.userId.length > 128) return undefined;
  if (
    !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > TWITCH_DISCOVERY_SNAPSHOT_MAX_ENTRIES
  ) return undefined;

  const now = Date.now();
  const seen = new Set<string>();
  const entries: TwitchDiscoverySnapshotEntry[] = [];
  for (const rawEntry of value.entries) {
    if (!isRecord(rawEntry)) return undefined;
    const dropID = rawEntry.dropID;
    if (typeof dropID !== "string" || dropID.length === 0 || dropID.length > 256 || seen.has(dropID)) {
      return undefined;
    }
    if (!isTwitchCampaignDetailPayload(rawEntry.campaign, dropID)) return undefined;
    const freshUntil = normalizedIsoTimestamp(rawEntry.freshUntil);
    const retainedUntil = normalizedIsoTimestamp(rawEntry.retainedUntil);
    if (!freshUntil || !retainedUntil) return undefined;
    const freshUntilTime = Date.parse(freshUntil);
    const retainedUntilTime = Date.parse(retainedUntil);
    if (freshUntilTime <= now || retainedUntilTime < freshUntilTime) return undefined;
    seen.add(dropID);
    entries.push({
      dropID,
      campaign: rawEntry.campaign,
      freshUntil,
      retainedUntil,
    });
  }

  return {
    version: TWITCH_DISCOVERY_SNAPSHOT_VERSION,
    userId: value.userId,
    entries,
  };
}

export function normalizePlatformAuthHealth(value: unknown): PlatformAuthHealth {
  if (!isRecord(value)) return { status: "checking" };
  const status = value.status;
  if (typeof status !== "string" || !AUTH_STATUSES.has(status as PlatformAuthStatus)) return { status: "checking" };

  const normalizedStatus = status as PlatformAuthStatus;
  const health: PlatformAuthHealth = { status: normalizedStatus };
  if (normalizedStatus !== "checking") {
    const checkedAt = normalizedIsoTimestamp(value.checkedAt);
    if (checkedAt) health.checkedAt = checkedAt;
  }

  const reasonCode = typeof value.reasonCode === "string"
    && AUTH_REASONS[normalizedStatus].includes(value.reasonCode as PlatformAuthReasonCode)
    ? value.reasonCode as PlatformAuthReasonCode
    : undefined;
  if (reasonCode) health.reasonCode = reasonCode;

  if (isRecord(value.message)) {
    const expectedKey = AUTH_MESSAGE_KEYS[reasonCode ?? normalizedStatus];
    if (value.message.key === expectedKey) {
      health.message = { key: expectedKey };
      if (isRecord(value.message.values)) {
        const reference = value.message.values.reference;
        const safeReference = (typeof reference === "string" && reference.length > 0 && reference.length <= 128)
          || (typeof reference === "number" && Number.isFinite(reference));
        if (safeReference) health.message.values = { reference: reference as string | number };
      }
    }
  }

  return health;
}

// Pure default scheduler state, shared by the extension's browser.storage layer
// and any other runtime (e.g. a headless CLI's file-backed storage). Kept
// browser-free here so both can seed/merge state without pulling in extension
// APIs.
const emptySession = (platform: Platform) => ({
  platform,
  offlineChecks: 0,
  status: "idle" as const,
});

export const DEFAULT_STATE: SchedulerState = {
  sessions: {
    twitch: emptySession("twitch"),
    kick: emptySession("kick"),
  },
  authHealth: {
    twitch: { status: "checking" },
    kick: { status: "checking" },
  },
  managedWatchTabs: {},
  managedPageContextTabs: {},
  campaigns: {
    twitch: [],
    kick: [],
  },
};

// Merges a persisted (possibly partial/older) state over DEFAULT_STATE, ensuring
// every per-platform slice is present. Shared by the extension's browser.storage
// layer and any file-backed storage so a new top-level slice only has to be
// added in one place.
export function mergeSchedulerState(stored: Partial<SchedulerState> | undefined): SchedulerState {
  const {
    events: _legacyEvents,
    criticalHealth: _rawCriticalHealth,
    twitchDiscovery: rawTwitchDiscovery,
    ...operationalState
  } = stored as (Partial<SchedulerState> & { events?: unknown }) ?? {};
  const normalizedCriticalHealth = stored?.criticalHealth
    ? (Object.fromEntries(
        (Object.entries(stored.criticalHealth) as [Platform, unknown][]).map(([platform, value]) => [
          platform,
          normalizeCriticalHealth(value),
        ]),
      ) as SchedulerState["criticalHealth"])
    : undefined;
  const criticalHealth = normalizedCriticalHealth && Object.keys(normalizedCriticalHealth).length > 0
    ? normalizedCriticalHealth
    : undefined;
  const twitchDiscovery = normalizeTwitchDiscoverySnapshot(rawTwitchDiscovery);
  return {
    ...DEFAULT_STATE,
    ...operationalState,
    sessions: { ...DEFAULT_STATE.sessions, ...stored?.sessions },
    authHealth: {
      twitch: normalizePlatformAuthHealth(stored?.authHealth?.twitch),
      kick: normalizePlatformAuthHealth(stored?.authHealth?.kick),
    },
    managedWatchTabs: { ...DEFAULT_STATE.managedWatchTabs, ...stored?.managedWatchTabs },
    managedPageContextTabs: { ...DEFAULT_STATE.managedPageContextTabs, ...stored?.managedPageContextTabs },
    manualWatch: { ...stored?.manualWatch },
    campaigns: { ...DEFAULT_STATE.campaigns, ...stored?.campaigns },
    ...(criticalHealth ? { criticalHealth } : {}),
    ...(twitchDiscovery ? { twitchDiscovery } : {}),
  };
}
