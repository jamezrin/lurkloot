import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { DropCampaign, DropReward, EngineSettings, ManagedWatchTab, Platform, PlatformAuthHealth, PlaybackTelemetry, SchedulerState, WatchReasonCode, WatchSession } from "@lurkloot/shared/models";
import type { ActivityEvent, DiagnosticEvent, EngineEvent, EventEmitter, EventReporter, FarmingStopReason, PageContextOpenReason } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { isFarmingActive } from "@lurkloot/shared/settings";
import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import { isWatchReward, reconcileCampaignAfterClaims } from "@lurkloot/shared/rewards";
import { isPlaybackTelemetryHealthy, MANUAL_WATCH_TTL_MS, runSchedulerTick, type StopPageContextTabs } from "../core/scheduler";
import {
  currentManagedPageContextTabs,
  INTEGRITY_REFRESH_TIMEOUT_MS,
  isValidTwitchIntegrity,
  noteTwitchGqlRequest,
  registerManagedPageContextTabs,
  setTwitchIntegrity,
  syncManagedTabBreakers,
  type TwitchIntegrityRequest,
} from "../core/tabs";
import { dismissCriticalFailure, recordManagedTabOpen } from "../core/criticalHealth";
import { integrityFromHeaders } from "../core/twitchIntegrity";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController, WatchContext } from "../core/tablessWatch";
import { applyPlatformAuthHealth } from "../core/authHealth";
import { withActivityDiagnostics } from "../core/activityDiagnostics";
import { mergePlatformState } from "./platformState";

export const ALARM_NAME = "lurkloot.tick";
export const TWITCH_ALARM_NAME = "lurkloot.tick.twitch";
export const KICK_ALARM_NAME = "lurkloot.tick.kick";
// A separate, fixed 1-minute alarm drives tabless watch heartbeats independently
// of the (heavier, configurable) discovery tick. chrome.alarms clamps to a
// 1-minute minimum, close enough to TwitchDropsMiner's 59s send cadence.
export const WATCH_ALARM_NAME = "lurkloot.watch";
export const TWITCH_INTEGRITY_ALARM_NAME = "lurkloot.twitch-integrity";
export const TWITCH_INTEGRITY_REFRESH_LEAD_MS = 120_000;
export const TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS = 30_000;

interface BackgroundAlarmController {
  tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger): Promise<void>;
  runWatchHeartbeat(): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
}

export function createBackgroundAlarmListener(controller: BackgroundAlarmController) {
  return (alarm: { name: string }): void => {
    if (alarm.name === TWITCH_ALARM_NAME) {
      void controller.tickAndHandOff(["twitch"], "alarm");
    } else if (alarm.name === KICK_ALARM_NAME) {
      void controller.tickAndHandOff(["kick"], "alarm");
    } else if (alarm.name === WATCH_ALARM_NAME) {
      void controller.runWatchHeartbeat();
    } else if (alarm.name === TWITCH_INTEGRITY_ALARM_NAME) {
      void controller.runTwitchIntegrityRefresh();
    }
  };
}
// Reward ids claimed during one tick, per platform. The post-claim handoff needs
// the ids (not just the platforms) so it can tell a genuine successor from the
// reward that was just claimed.
export type ClaimedRewards = Partial<Record<Platform, string[]>>;
// What caused a tick to run. Recorded in the tick's lifecycle diagnostics so an
// exported log distinguishes a user action from a timer or a post-claim handoff.
export type TickTrigger =
  | "alarm"
  | "watch_alarm"
  | "startup"
  | "install"
  | "automation_toggle"
  | "platform_toggle"
  | "settings_saved"
  | "manual_resume"
  | "manual_tick"
  | "critical_failure_dismissed"
  | "tabless_fallback"
  | "claim_handoff"
  | "unknown";
export type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };
// Reasons a refreshed platform has nothing left to farm. Reaching one of these
// means further refreshes would return the same answer, so the post-claim
// handoff stops instead of spending the rest of its budget.
const NOTHING_LEFT_REASON_CODES: WatchReasonCode[] = ["campaign_ineligible", "no_eligible_channel"];
function isNothingLeftToFarm(reasonCode: WatchReasonCode | undefined): boolean {
  return reasonCode != null && NOTHING_LEFT_REASON_CODES.includes(reasonCode);
}
// How recently a heartbeat must have landed for the post-claim handoff to treat
// the channel as already covered. Half the fixed one-minute alarm period: long
// enough to suppress a genuine double-send, short enough that a real handoff
// still transmits.
const RECENT_HEARTBEAT_MS = 30_000;
const PLATFORMS: Platform[] = ["twitch", "kick"];
// Must stay strictly greater than INTEGRITY_REFRESH_TIMEOUT_MS. A Twitch probe
// runs through gqlWithIntegrityRetry, so a rejection makes it wait on a page
// context minting a token; when this deadline was the shorter of the two (10s
// against a 12s wait) the probe could never observe that wait succeed. It
// aborted first, every time, and — because the wait takes no AbortSignal (#293)
// — left the wait and its tab running unowned behind it.
const DEFAULT_AUTH_PROBE_TIMEOUT_MS = INTEGRITY_REFRESH_TIMEOUT_MS + 5_000;
class AuthProbeSetupError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "AuthProbeSetupError";
  }
}
const FARMING_STOP_REASON_CODES: Record<FarmingStopReason, true> = {
  automation_disabled: true,
  platform_disabled: true,
  authentication_unhealthy: true,
  platform_backoff: true,
  platform_error: true,
  campaign_ineligible: true,
  channel_excluded: true,
  channel_offline: true,
  channel_mismatch: true,
  watch_unhealthy: true,
  higher_priority_reward: true,
  higher_priority_idle_watchlist: true,
  watch_requirement_completed: true,
  runtime_restart: true,
  target_changed: true,
  manual_watch: true,
  manual_tab_close: true,
  critical_failure: true,
};
const EN_RUNTIME_MESSAGES: Record<string, string> = {
  notificationRewardClaimed: "Reward claimed",
  notificationRewardEarned: "Reward earned",
  notificationNoDropsLeft: "No drops left",
  notificationRewardFromCampaign: "$1 from $2",
  notificationNoDropsLeftMessage: "$1 has no eligible drops to farm.",
  notificationChallengeClaimed: "Challenge reward claimed",
  notificationChallengeReward: "You won a $1 card from your $2 challenge.",
};

function emitHostCallbackError(
  emit: EventEmitter,
  platform: Platform,
  error: unknown,
  fallbackMessage: string,
): void {
  emit({
    category: "diagnostic",
    platform,
    level: "warn",
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

// Generic over the host's settings type `S`, which must satisfy the engine
// contract (EngineSettings). The extension parametrizes it with its fuller
// ExtensionSettings (load/save round-trip the host-only fields); the CLI uses the
// bare EngineSettings. The engine itself only ever reads EngineSettings fields.
export interface BackgroundControllerDeps<S extends EngineSettings = EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  authProbeTimeoutMs?: number;
  reportEvents?: EventReporter;
  createAlarm(
    name: string,
    options: { periodInMinutes: number } | { when: number },
  ): Promise<void>;
  clearAlarm?(name: string): Promise<boolean>;
  ensureTwitchIntegrity?(
    emit: EventEmitter,
    request?: TwitchIntegrityRequest,
  ): Promise<boolean>;
  cancelTwitchIntegrityAcquisition?(reason?: unknown): void;
  createAdapters(emit: EventEmitter, settings: S): {
    adapters: Record<Platform, PlatformAdapter>;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  createAdapter(platform: Platform, emit: EventEmitter, settings: S): {
    adapter: PlatformAdapter;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
  closeManagedTabs?(tabs: ManagedWatchTab[]): Promise<void>;
  // Tab-mode ad focus. The host (extension) owns the focus policy (adFocusMode),
  // so the engine only reports whether an ad is active for a given watch tab.
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  // Tab-mode playback policy the host supplies to managed watch tabs. Defaults to
  // keeping videos unmuted when the host does not provide it.
  loadTabPlaybackPolicy?(): Promise<{ keepVideosUnmuted: boolean }>;
  // Applies a popup settings patch to the host's full settings. Host-only; the
  // CLI never sends settings-mutating messages, so it can omit this.
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
  // Browser-bound page-context tab teardown, injected into the scheduler tick.
  // Omitted in headless/test runs, where the scheduler forgets contexts from
  // state only (see runSchedulerTick / StopPageContextTabs).
  stopPageContextTabs?: StopPageContextTabs;
  // Delay used by the bounded post-claim handoff. Injected so tests can drive
  // the loop deterministically instead of racing real timers. Resolves early
  // (without throwing) when the signal aborts, so callers check `signal.aborted`
  // after awaiting rather than catching.
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}

export function createBackgroundController<S extends EngineSettings = EngineSettings>(deps: BackgroundControllerDeps<S>) {
  const platformMutations: Record<Platform, Promise<unknown>> = {
    twitch: Promise.resolve(),
    kick: Promise.resolve(),
  };
  let stateCommit: Promise<unknown> = Promise.resolve();

  function withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T> {
    const run = platformMutations[platform].then(operation, operation);
    platformMutations[platform] = run.then(() => undefined, () => undefined);
    return run;
  }

  function withStateLock<T>(
    operation: () => Promise<T>,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<T> {
    const targets = PLATFORMS.filter((platform) => platforms.includes(platform));
    const acquire = (index: number): Promise<T> => {
      const platform = targets[index];
      if (!platform) return operation();
      return withPlatformLock(platform, () => acquire(index + 1));
    };
    return acquire(0);
  }

  function withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
    const run = stateCommit.then(operation, operation);
    stateCommit = run.then(() => undefined, () => undefined);
    return run;
  }

  const reportedCompatibility = new Map<Platform, string>();
  const reportedCompatibilityWarnings = new Set<string>();
  const authRefreshGeneration: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };
  // In-flight post-claim handoffs, one per platform. A claim arriving while a
  // handoff is already running for that platform is absorbed by the running
  // loop rather than starting a second one, which is what keeps the work
  // bounded. Per-controller, unlike the storage lock: these loops coordinate
  // only with each other.
  const claimHandoffs = new Map<Platform, AbortController>();

  const wait: NonNullable<BackgroundControllerDeps<S>["wait"]> = deps.wait ?? ((ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }));

  const selectionFingerprint = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const warningFieldLabel = (platform: Platform, field: string): string => {
    if (platform === "twitch") {
      if (field === "profile") return "Twitch profile";
      if (field === "heartbeatTransport") return "Twitch heartbeat";
      return "Twitch inventory";
    }
    return field === "profile" ? "Kick profile" : "Kick claim";
  };

  function reportAdapterCompatibility(
    construction: {
      compatibility: ResolvedCompatibility;
      warnings: CompatibilityResolution["warnings"];
    },
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): void {
    for (const warning of construction.warnings) {
      if (!platforms.includes(warning.platform) || !settings.platform[warning.platform].enabled) continue;
      const key = `${warning.code}:${warning.platform}:${warning.field}:${warning.resolved}:${selectionFingerprint(warning.requested)}`;
      if (reportedCompatibilityWarnings.has(key)) continue;
      const reason = warning.code === "unknown_selection" ? "Unknown" : "Host-incompatible";
      emit({
        category: "diagnostic",
        platform: warning.platform,
        level: "warn",
        message: `${reason} ${warningFieldLabel(warning.platform, warning.field)} compatibility selection; using ${warning.resolved}`,
        ...(warning.field === "profile"
          ? { compatibilityProfile: warning.resolved }
          : { compatibilityCapability: warning.resolved, compatibilityVersion: warning.resolved }),
      });
      reportedCompatibilityWarnings.add(key);
    }
    for (const platform of platforms) {
      if (!settings.platform[platform].enabled) continue;
      const profile = construction.compatibility[platform].profile;
      const capabilities = platform === "twitch"
        ? [construction.compatibility.twitch.heartbeat, construction.compatibility.twitch.inventory]
        : [construction.compatibility.kick.claim];
      const capability = capabilities[0];
      const key = [profile, ...capabilities].join(":");
      if (reportedCompatibility.get(platform) === key) continue;
      emit({
        category: "diagnostic",
        platform,
        level: "info",
        message: `Using compatibility profile ${profile} (${capabilities.join(", ")})`,
        compatibilityProfile: profile,
        compatibilityCapability: capability,
        compatibilityCapabilities: capabilities,
        compatibilityVersion: capability,
      });
      reportedCompatibility.set(platform, key);
    }
  }

  function createAdapters(settings: S, emit: EventEmitter): Record<Platform, PlatformAdapter> {
    const construction = deps.createAdapters(emit, settings);
    reportAdapterCompatibility(construction, settings, emit, PLATFORMS);
    return construction.adapters;
  }

  function createAdapter(
    platform: Platform,
    settings: S,
    emit: EventEmitter,
    reportCompatibility = false,
  ): PlatformAdapter {
    const construction = deps.createAdapter(platform, emit, settings);
    if (reportCompatibility) {
      reportAdapterCompatibility(construction, settings, emit, [platform]);
    }
    return construction.adapter;
  }

  function createSelectedAdapters(
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Record<Platform, PlatformAdapter> {
    if (platforms.length === PLATFORMS.length) return createAdapters(settings, emit);
    const adapters: Partial<Record<Platform, PlatformAdapter>> = {};
    for (const platform of platforms) {
      adapters[platform] = createAdapter(platform, settings, emit, true);
    }
    return adapters as Record<Platform, PlatformAdapter>;
  }

  async function withEventCollector<T>(operation: (emit: EventEmitter, events: EngineEvent[]) => Promise<T>): Promise<T> {
    const events: EngineEvent[] = [];
    const emit = withActivityDiagnostics((event) => events.push(event));
    return operation(emit, events);
  }

  function clearOperationalEvents(events: EngineEvent[]): void {
    const compatibilityEvents = events.filter((event) =>
      event.category === "diagnostic"
      && (event.compatibilityProfile !== undefined || event.compatibilityCapability !== undefined));
    events.splice(0, events.length, ...compatibilityEvents);
  }

  // Persistent tabless watchers, one per platform, kept alive across discovery
  // ticks (the WebSocket-based Kick watcher in particular must not be recreated
  // each tick). Reconciled against the scheduler's per-platform session state.
  const tablessWatchers = new Map<Platform, TablessWatchController>();
  const waitingClaimRewardIds: Record<Platform, Set<string>> = {
    twitch: new Set<string>(),
    kick: new Set<string>(),
  };
  let settingsMutation: Promise<unknown> = Promise.resolve();
  let twitchIntegrityAlarmMutation: Promise<unknown> = Promise.resolve();
  let twitchSettingsTransitionGeneration = 0;
  let lastPersistedTwitchEnabled: boolean | undefined;
  let integrityRefreshAbort: AbortController | undefined;
  let integrityLifecycleGeneration = 0;
  let integrityLifecycleOpen = true;
  let controllerShutdown = false;
  let installedTwitchIntegrity: TwitchIntegrity | undefined;
  let persistedIntegrityToken: string | undefined;
  // A missing rejectedToken means there was no usable bundle when the refresh
  // became due. Keeping the wrapper object distinguishes that from "not due."
  let twitchIntegrityRefreshDue: { rejectedToken?: string } | undefined;

  // Prime the in-memory integrity token from storage whenever the background
  // script (re)evaluates, so a claim right after a service-worker wake can use
  // the last captured token before any fresh page traffic is observed.
  const initialTwitchIntegrityLoad = loadStoredTwitchIntegrity(
    integrityLifecycleGeneration,
    twitchSettingsTransitionGeneration,
  );

  function integrityRefreshJitter(token: string): number {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % (TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS + 1);
  }

  function twitchIntegrityRefreshTarget(integrity: TwitchIntegrity): number {
    return integrity.expiresAt
      - TWITCH_INTEGRITY_REFRESH_LEAD_MS
      - integrityRefreshJitter(integrity.integrity);
  }

  function installTwitchIntegrity(integrity: TwitchIntegrity, isNew = false, emit?: EventEmitter): void {
    installedTwitchIntegrity = integrity;
    setTwitchIntegrity(integrity, { isNew }, emit);
  }

  function currentInstalledTwitchIntegrity(): TwitchIntegrity | undefined {
    return isValidTwitchIntegrity(installedTwitchIntegrity)
      ? installedTwitchIntegrity
      : undefined;
  }

  function reconcileStoredTwitchIntegrity(stored: TwitchIntegrity | undefined): TwitchIntegrity | undefined {
    const current = currentInstalledTwitchIntegrity();
    if (!isValidTwitchIntegrity(stored)) return current;
    const storedSupersedesCurrent = !current
      || (
        stored.integrity !== current.integrity
        && persistedIntegrityToken === current.integrity
      );
    persistedIntegrityToken = stored.integrity;
    if (storedSupersedesCurrent) {
      installTwitchIntegrity(stored);
      return stored;
    }
    return current;
  }

  function markTwitchIntegrityRefreshDue(integrity?: TwitchIntegrity): void {
    twitchIntegrityRefreshDue = {
      ...(integrity ? { rejectedToken: integrity.integrity } : {}),
    };
  }

  function withTwitchIntegrityAlarmLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = twitchIntegrityAlarmMutation.then(operation, operation);
    twitchIntegrityAlarmMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async function clearTwitchIntegrityAlarm(): Promise<void> {
    await withTwitchIntegrityAlarmLock(async () => {
      await deps.clearAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
    });
  }

  async function clearTwitchIntegrityAlarmBestEffort(emit?: EventEmitter): Promise<void> {
    try {
      await clearTwitchIntegrityAlarm();
    } catch {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch integrity refresh alarm",
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function scheduleTwitchIntegrityRefresh(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    const when = twitchIntegrityRefreshTarget(integrity);
    if (when <= Date.now()) {
      markTwitchIntegrityRefreshDue(integrity);
      await clearTwitchIntegrityAlarm();
      return;
    }
    await withTwitchIntegrityAlarmLock(async () => {
      await deps.createAlarm(TWITCH_INTEGRITY_ALARM_NAME, { when });
    });
    twitchIntegrityRefreshDue = undefined;
    emit?.({
      category: "diagnostic",
      platform: "twitch",
      level: "debug",
      message: `Scheduled proactive Twitch integrity refresh for ${new Date(when).toISOString()}`,
    });
  }

  async function scheduleTwitchIntegrityRefreshBestEffort(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    try {
      await scheduleTwitchIntegrityRefresh(integrity, emit);
    } catch (error) {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: `Could not schedule Twitch integrity refresh (${error instanceof Error ? error.message : String(error)})`,
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function loadStoredTwitchIntegrity(
    lifecycleGeneration: number,
    settingsTransitionGeneration: number,
  ): Promise<void> {
    let twitchEnabled: boolean | undefined;
    let settingsReadError: unknown;
    await withSettingsLock(async () => {
      try {
        twitchEnabled = (await deps.loadSettings()).platform.twitch.enabled;
      } catch (error) {
        settingsReadError = error;
      }
    });
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const ownsStartupLoad = (): boolean =>
        !controllerShutdown
        && integrityLifecycleGeneration === lifecycleGeneration
        && twitchSettingsTransitionGeneration === settingsTransitionGeneration;
      let integrity: TwitchIntegrity | undefined;
      if (settingsReadError) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `Could not read Twitch settings while priming integrity (${settingsReadError instanceof Error ? settingsReadError.message : String(settingsReadError)})`,
        });
      }
      try {
        integrity = await deps.loadTwitchIntegrity?.();
      } catch (error) {
        // A missing/corrupt stored token is non-fatal: fresh page traffic will
        // re-capture one, and claims simply stay best-effort until then.
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `No stored Twitch integrity token to prime (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      if (!ownsStartupLoad()) return;
      if (isValidTwitchIntegrity(integrity)) {
        const current = reconcileStoredTwitchIntegrity(integrity);
        if (twitchEnabled === true && integrityLifecycleOpen) {
          await scheduleTwitchIntegrityRefreshBestEffort(current!, emit);
        }
      } else if (integrity) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: "Stored Twitch integrity token is expired or too close to expiry; ignoring it",
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function runTwitchIntegrityRefresh(): Promise<void> {
    if (!integrityLifecycleOpen || integrityRefreshAbort) return;
    const abort = new AbortController();
    integrityRefreshAbort = abort;
    const lifecycleGeneration = integrityLifecycleGeneration;
    const ownsRefresh = (): boolean =>
      integrityRefreshAbort === abort
      && !abort.signal.aborted
      && integrityLifecycleGeneration === lifecycleGeneration
      && integrityLifecycleOpen;

    try {
      await initialTwitchIntegrityLoad;
      if (!ownsRefresh()) return;
      await withEventCollector(async (emit, events) => {
        let integrity: TwitchIntegrity | undefined;
        let shouldAcquire = false;
        try {
          await withSettingsLock(async () => {
            if (!ownsRefresh()) return;
            const settings = await deps.loadSettings();
            if (!ownsRefresh()) return;
            if (!settings.platform.twitch.enabled) {
              closeTwitchIntegrityLifecycle("Twitch disabled");
              await clearTwitchIntegrityAlarmBestEffort(emit);
              return;
            }

            await withStateLock(async () => {
              if (!ownsRefresh()) return;
              let stored: TwitchIntegrity | undefined;
              try {
                stored = await deps.loadTwitchIntegrity?.();
              } catch {
                emit({
                  category: "diagnostic",
                  platform: "twitch",
                  level: "debug",
                  message: "Could not reload stored Twitch integrity before proactive refresh",
                });
              }
              if (!ownsRefresh()) return;

              integrity = reconcileStoredTwitchIntegrity(stored);
              if (integrity && twitchIntegrityRefreshTarget(integrity) > Date.now()) {
                await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
                return;
              }
              markTwitchIntegrityRefreshDue(integrity);
              shouldAcquire = true;
            });
          });

          if (!shouldAcquire || !deps.ensureTwitchIntegrity || !ownsRefresh()) return;
          const remainingMs = integrity
            ? Math.max(0, integrity.expiresAt - Date.now())
            : 0;
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: integrity
              ? `Starting proactive Twitch integrity refresh with ${remainingMs}ms remaining`
              : "Starting proactive Twitch integrity refresh with no valid token available",
          });
          const ready = await deps.ensureTwitchIntegrity(emit, {
            forceRefresh: true,
            reason: "proactive_refresh",
            ...(integrity ? { rejectedToken: integrity.integrity } : {}),
            onManagedPageContextOpen: () =>
              recordTwitchIntegrityManagedTabOpen("proactive_integrity_refresh"),
            signal: abort.signal,
          });
          if (!ready && !abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } catch {
          if (abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was cancelled because Twitch stopped",
            });
          } else {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } finally {
          await reportBestEffort(events);
        }
      });
    } finally {
      if (integrityRefreshAbort === abort) {
        integrityRefreshAbort = undefined;
      }
    }
  }

  // Fed by the background's webRequest listener with the outgoing headers of
  // gql.twitch.tv requests. Only genuine page-minted requests carry a
  // Client-Integrity header, so integrityFromHeaders returns undefined (and we
  // ignore) our own background fetch and anonymous queries.
  // `tabId` is optional so hosts that cannot attribute a request to a tab still
  // capture tokens; it only feeds page-context boot instrumentation.
  async function captureTwitchIntegrity(headers: IntegrityHeader[] | undefined, tabId?: number): Promise<void> {
    // Noted before the integrity filter: an anonymous GQL request carries no
    // Client-Integrity header but still proves the SPA has booted.
    noteTwitchGqlRequest(tabId);
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    let isNew = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      isNew = integrity.integrity !== installedTwitchIntegrity?.integrity;
      installTwitchIntegrity(integrity, isNew, emit);
      if (integrity.integrity !== persistedIntegrityToken && deps.saveTwitchIntegrity) {
        try {
          await deps.saveTwitchIntegrity(integrity);
          persistedIntegrityToken = integrity.integrity;
        } catch {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "warn",
            message: "Could not persist the captured Twitch integrity token",
          });
        }
      }
      await reportBestEffort(events);
    }));
    if (!isNew) return;
    const lifecycleGeneration = integrityLifecycleGeneration;
    const settingsTransitionGeneration = twitchSettingsTransitionGeneration;
    const ownsScheduling = (): boolean =>
      !controllerShutdown
      && integrityLifecycleOpen
      && integrityLifecycleGeneration === lifecycleGeneration
      && twitchSettingsTransitionGeneration === settingsTransitionGeneration;
    await withSettingsLock(() => withEventCollector(async (emit, events) => {
      try {
        if (!ownsScheduling()) return;
        const settings = await deps.loadSettings();
        if (!ownsScheduling() || !settings.platform.twitch.enabled) return;
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: `Could not check Twitch settings before scheduling integrity refresh (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function recordTwitchIntegrityManagedTabOpen(
    reason: "integrity_readiness" | "proactive_integrity_refresh",
  ): Promise<void> {
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (!integrityLifecycleOpen) return;
        const settings = await deps.loadSettings();
        if (!integrityLifecycleOpen || !settings.criticalFailurePromptEnabled) return;
        const state = await deps.loadState();
        const transition = recordManagedTabOpen(state, "twitch", Date.now(), {
          source: "page_context",
          reason,
        });
        if (transition.event) emit(transition.event);
        syncManagedTabBreakers(transition.state, ["twitch"]);
        await persistAndReport(transition.state, events);
      }));
    } catch {
      await reportBestEffort([{
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not account for a managed Twitch integrity page context",
      }]);
    }
  }

  async function persistAndReport(state: SchedulerState, events: readonly EngineEvent[] = []): Promise<void> {
    await saveOperationalState(state);
    await reportBestEffort(events);
  }

  async function persistPlatformAndReport(
    platform: Platform,
    state: SchedulerState,
    events: readonly EngineEvent[] = [],
  ): Promise<void> {
    await withStateCommit(async () => {
      const latest = await deps.loadState();
      await saveOperationalStateDirect(mergePlatformState(latest, state, platform));
    });
    await reportBestEffort(events);
  }

  async function saveOperationalState(state: SchedulerState): Promise<void> {
    await withStateCommit(() => saveOperationalStateDirect(state));
  }

  async function saveOperationalStateDirect(state: SchedulerState): Promise<void> {
    const { events: _legacyEvents, ...operationalState } = state as SchedulerState & { events?: unknown };
    await deps.saveState(operationalState);
  }

  // Reports a single diagnostic immediately rather than collecting it into a
  // tick's event batch. Tick lifecycle lines must land as they happen: batching
  // them would defeat the point of timing a tick that is still running.
  function diagnosticEvent(level: "debug" | "info" | "warn", message: string, platform?: Platform): void {
    void reportBestEffort([{ category: "diagnostic", level, message, platform }]);
  }

  async function reportBestEffort(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0 || !deps.reportEvents) return;
    try {
      await deps.reportEvents(events);
    } catch {
      // Host event persistence/output is best-effort.
    }
  }

  function playbackEvents(
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
  ): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const log = (level: DiagnosticEvent["level"], message: string) => {
      events.push({ category: "diagnostic", platform, level, message });
    };

    if (telemetry.adActive && !previous?.adActive) {
      log("info", "Ad started; keeping the watch tab counting down");
    } else if (!telemetry.adActive && previous?.adActive) {
      log("debug", "Ad finished");
    }
    if (telemetry.blockedPlaybackCount > 0 && (previous?.blockedPlaybackCount ?? 0) === 0) {
      log("warn", `Playback was blocked for ${telemetry.blockedPlaybackCount} video(s); re-muted to keep farming`);
    }
    if (telemetry.videoCount === 0 && (previous?.videoCount ?? -1) !== 0) {
      log("warn", "No video element found in the watch tab");
    }
    if (telemetry.playingVideoCount !== (previous?.playingVideoCount ?? -1) || telemetry.videoCount !== (previous?.videoCount ?? -1)) {
      log("debug", `Playback telemetry: ${telemetry.playingVideoCount}/${telemetry.videoCount} videos playing${telemetry.documentHidden ? " (tab hidden)" : ""}`);
    }
    return events;
  }

  async function ensureAlarm(): Promise<void> {
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    if (settings.autoStartDropFarming && isFarmingActive(settings)) {
      await tick(undefined, "install");
    } else {
      await refreshAuthHealth(PLATFORMS, settings);
    }
  }

  async function ensureSchedulerAlarms(periodInMinutes: number): Promise<void> {
    await deps.clearAlarm?.(ALARM_NAME);
    await Promise.all([
      deps.createAlarm(TWITCH_ALARM_NAME, { periodInMinutes }),
      deps.createAlarm(KICK_ALARM_NAME, { periodInMinutes }),
    ]);
  }

  async function ensureInstalledAt(installedAt = new Date().toISOString()): Promise<void> {
    await withStateLock(async () => {
      const state = await deps.loadState();
      if (state.installedAt) return;
      await saveOperationalState({ ...state, installedAt });
    });
  }

  // On restart, autoStartDropFarming decides what happens to the platforms that
  // were farming: enabled means keep going, disabled means switch them off. It
  // used to clear a global `running` flag instead, which left the per-platform
  // flags set — so the popup showed everything off while a stale enabled flag
  // waited to resurrect a platform the moment the master switch came back.
  async function normalizeStartupSettings(): Promise<S> {
    return withSettingsLock(async () => {
      const settings = await deps.loadSettings();
      if (settings.autoStartDropFarming || !isFarmingActive(settings)) return settings;
      const nextSettings = {
        ...settings,
        platform: {
          ...settings.platform,
          twitch: { ...settings.platform.twitch, enabled: false },
          kick: { ...settings.platform.kick, enabled: false },
        },
      };
      await deps.saveSettings(nextSettings);
      return nextSettings;
    });
  }

  async function handleStartup(): Promise<void> {
    // A restart kills the watchers a handoff would transmit through, so leave
    // no loop running against them.
    abortClaimHandoffs();
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    // A restart kills any in-memory watchers; start clean and let tick() rebuild.
    tablessWatchers.clear();

    const preservePageContexts = isFarmingActive(settings) && settings.autoStartDropFarming;
    const { state, cleanup } = await withStateLock(async () => {
      const state = await deps.loadState();
      registerManagedPageContextTabs(preservePageContexts ? state.managedPageContextTabs ?? {} : {});
      const cleanup = staleStartupCleanup(state, preservePageContexts);
      if (cleanup.hasStaleSession) {
        const restartEvents = farmingLifecycleEvents(state, cleanup.state);
        await persistAndReport(cleanup.state, restartEvents);
      }
      return { state, cleanup };
    });
    if (!cleanup.hasStaleSession) {
      const nextSettings = await normalizeStartupSettings();
      if (nextSettings.autoStartDropFarming && isFarmingActive(nextSettings)) {
        await tick(undefined, "startup");
      } else {
        await refreshAuthHealth(PLATFORMS, nextSettings, true);
      }
      return;
    }

    if (deps.closeManagedTabs && cleanup.managedTabs.length > 0) {
      await deps.closeManagedTabs(cleanup.managedTabs);
    }
    if (!preservePageContexts && deps.stopPageContextTabs && Object.keys(state.managedPageContextTabs ?? {}).length > 0) {
      await withEventCollector(async (emit, events) => {
        await deps.stopPageContextTabs!(state.managedPageContextTabs ?? {}, {
          platforms: ["twitch", "kick"],
          reason: "runtime_restart",
          emit,
        });
        await reportBestEffort(events);
      });
    }

    const nextSettings = await normalizeStartupSettings();

    if (isFarmingActive(nextSettings) && nextSettings.autoStartDropFarming) {
      await tick(undefined, "startup");
    } else {
      await refreshAuthHealth(PLATFORMS, nextSettings, true);
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = settingsMutation.then(operation, operation);
    settingsMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async function updateStoredSettings(
    patch: SettingsPatch,
    afterPersist?: (settings: S) => void,
    afterLoad?: (settings: S) => void,
  ): Promise<S> {
    return withSettingsLock(async () => {
      if (!deps.applySettingsPatch) {
        throw new Error("applySettingsPatch dependency is required to mutate settings");
      }
      const current = await deps.loadSettings();
      afterLoad?.(current);
      const settings = deps.applySettingsPatch(current, patch);
      await deps.saveSettings(settings);
      afterPersist?.(settings);
      await ensureSchedulerAlarms(settings.pollIntervalMinutes);
      return settings;
    });
  }

  async function restoreTwitchIntegritySchedule(
    transitionIsCurrent: () => boolean,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (!integrityLifecycleOpen || !transitionIsCurrent()) return;
      let stored: TwitchIntegrity | undefined;
      try {
        stored = await deps.loadTwitchIntegrity?.();
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: "Could not reload stored Twitch integrity after Twitch was enabled",
        });
      }
      if (!integrityLifecycleOpen || !transitionIsCurrent()) return;
      const integrity = reconcileStoredTwitchIntegrity(stored);
      if (integrity && transitionIsCurrent()) {
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      }
      await reportBestEffort(events);
    }));
  }

  async function probeAuthHealth(
    platform: Platform,
    adapter: PlatformAdapter,
    signal?: AbortSignal,
  ): Promise<PlatformAuthHealth> {
    // A probe must always resolve to a terminal status. If reading the session
    // cookies (or the adapter probe) throws, mapping it to "unavailable" here
    // keeps the failure from propagating into the tick, where a rollback would
    // strand the popup on "Checking your signed-in session…" indefinitely.
    const abort = new AbortController();
    let rejectCancelled: (reason?: unknown) => void = () => {};
    const cancelled = new Promise<PlatformAuthHealth>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const abortFromTick = () => {
      abort.abort(signal?.reason);
      rejectCancelled(signal?.reason);
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abortFromTick, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const terminalProbe = (async (): Promise<PlatformAuthHealth> => {
      try {
        const availability = await deps.checkCredentialAvailability?.(platform);
        if (availability?.status === "missing") {
          return {
            status: "missing_credentials",
            checkedAt: new Date().toISOString(),
            reasonCode: "credentials_missing",
            message: { key: "authMissingCredentials" },
          };
        }
        if (availability?.status === "unavailable") {
          return {
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            reasonCode: "credential_lookup_failed",
            message: { key: "authCredentialLookupFailed" },
          };
        }
        return await adapter.checkAuthHealth(abort.signal);
      } catch {
        signal?.throwIfAborted();
        return {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasonCode: "credential_lookup_failed",
          message: { key: "authCredentialLookupFailed" },
        };
      }
    })();
    const timedOut = new Promise<PlatformAuthHealth>((resolve) => {
      timeout = setTimeout(() => {
        abort.abort();
        resolve({
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          reasonCode: "network_unavailable",
          message: { key: "authNetworkUnavailable" },
        });
      }, deps.authProbeTimeoutMs ?? DEFAULT_AUTH_PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([terminalProbe, timedOut, cancelled]);
    } finally {
      signal?.removeEventListener("abort", abortFromTick);
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function persistAuthHealth(
    platform: Platform,
    health: PlatformAuthHealth,
    probeEvents: readonly EngineEvent[] = [],
    generation: number,
  ): Promise<boolean> {
    return withStateLock(() => withEventCollector(async (emit, events) => {
      if (authRefreshGeneration[platform] !== generation) return false;
      events.push(...probeEvents);
      await withStateCommit(async () => {
        const state = await deps.loadState();
        const transition = applyPlatformAuthHealth(state, platform, health);
        if (transition.event) emit(transition.event);
        await saveOperationalStateDirect(transition.state);
      });
      await reportBestEffort(events);
      return true;
    }), [platform]);
  }

  async function beginAuthRefresh(platforms: readonly Platform[]): Promise<Partial<Record<Platform, number>>> {
    return withStateLock(async () => {
      const generations: Partial<Record<Platform, number>> = {};
      for (const platform of platforms) {
        authRefreshGeneration[platform] += 1;
        generations[platform] = authRefreshGeneration[platform];
      }
      return generations;
    }, platforms);
  }

  function unavailableAfterAdapterSetup(): PlatformAuthHealth {
    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      reasonCode: "platform_unavailable",
      message: { key: "authPlatformUnavailable" },
    };
  }

  function flattenedRefreshFailures(error: unknown): unknown[] {
    if (error instanceof AggregateError) {
      return error.errors.flatMap((failure) => flattenedRefreshFailures(failure));
    }
    return [error];
  }

  function throwRefreshFailures(results: PromiseSettledResult<void>[]): void {
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? flattenedRefreshFailures(result.reason) : []);
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Authentication refresh failed");
  }

  async function refreshAuthHealth(
    platforms: Platform[],
    loadedSettings?: S,
    reportCompatibility = false,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const generations = await beginAuthRefresh(platforms);
    const settings = loadedSettings ?? await deps.loadSettings();
    const enabled = platforms.filter((platform) => settings.platform[platform].enabled);
    const results = await Promise.allSettled(enabled.map(async (platform) => {
      const result = await withEventCollector(async (emit, events) => {
        let setupFailure: AuthProbeSetupError | undefined;
        let health: PlatformAuthHealth;
        let adapter: PlatformAdapter | undefined;
        try {
          adapter = createAdapter(platform, settings, emit, reportCompatibility);
        } catch (error) {
          setupFailure = new AuthProbeSetupError(
            platform,
            error instanceof Error ? error.message : "Adapter factory failed",
          );
        }
        health = adapter
          ? await probeAuthHealth(platform, adapter, signal)
          : unavailableAfterAdapterSetup();
        return { health, events, setupFailure };
      });
      const generation = generations[platform];
      if (generation === undefined) return;
      signal?.throwIfAborted();
      let accepted: boolean;
      try {
        accepted = await persistAuthHealth(platform, result.health, result.events, generation);
      } catch (error) {
        if (result.setupFailure) {
          throw new AggregateError(
            [result.setupFailure, error],
            `${platform} authentication setup and persistence failed`,
          );
        }
        throw error;
      }
      if (accepted && result.setupFailure) throw result.setupFailure;
    }));
    throwRefreshFailures(results);
  }

  async function reportAuthSetupFailures(failures: readonly AuthProbeSetupError[]): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      for (const failure of failures) {
        emit({
          category: "activity",
          code: "interruption",
          level: "error",
          platform: failure.platform,
          data: { reason: "platform_error", detail: failure.message },
        });
      }
      await persistAndReport(state, events);
    }));
  }

  async function prepareTwitchIntegrity(
    settings: S,
    signal: AbortSignal,
  ): Promise<boolean> {
    const ensureTwitchIntegrity = deps.ensureTwitchIntegrity;
    if (!settings.platform.twitch.enabled || !ensureTwitchIntegrity) return true;
    return withEventCollector(async (emit, events) => {
      const lifecycleGeneration = integrityLifecycleGeneration;
      const due = twitchIntegrityRefreshDue;
      try {
        const ready = await ensureTwitchIntegrity(emit, {
          signal,
          reason: due ? "proactive_refresh" : "readiness",
          onManagedPageContextOpen: () => recordTwitchIntegrityManagedTabOpen(
            due ? "proactive_integrity_refresh" : "integrity_readiness",
          ),
          ...(due
            ? {
                forceRefresh: true,
                ...(due.rejectedToken ? { rejectedToken: due.rejectedToken } : {}),
              }
            : {}),
        });
        if (!ready) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "warn",
            message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
          });
        }
        return ready;
      } catch {
        signal.throwIfAborted();
        const currentSettings = await deps.loadSettings();
        if (
          lifecycleGeneration !== integrityLifecycleGeneration
          || !integrityLifecycleOpen
          || !currentSettings.platform.twitch.enabled
        ) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: "Twitch integrity acquisition was cancelled because Twitch stopped; continuing other platform work",
          });
          return false;
        }
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
        });
        return false;
      } finally {
        await reportBestEffort(events);
      }
    });
  }

  // Every tick is bracketed by a start/finish diagnostic carrying its trigger and
  // elapsed time. A tick that succeeds otherwise emits nothing about itself, which
  // makes a slow one indistinguishable from an idle gap in an exported log.
  let tickSequence = 0;
  // Chain of detached ticks, drained by settleBackgroundWork().
  let backgroundWork: Promise<unknown> = Promise.resolve();
  const activeTicks = new Set<AbortController>();
  const activePlatformTicks: Record<Platform, number> = {
    twitch: 0,
    kick: 0,
  };

  async function tick(platforms?: Platform[], trigger: TickTrigger = "unknown"): Promise<ClaimedRewards> {
    const requestedPlatforms = platforms ?? PLATFORMS;
    const settled = await Promise.allSettled(requestedPlatforms.map((platform) =>
      tickPlatform(platform, trigger)));
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Platform scheduler ticks failed");
    }
    return settled.reduce<ClaimedRewards>((claimed, result) => {
      if (result.status !== "fulfilled") return claimed;
      const [platform, rewards] = result.value;
      if (rewards.length > 0) claimed[platform] = rewards;
      return claimed;
    }, {});
  }

  async function tickPlatform(
    platform: Platform,
    trigger: TickTrigger,
  ): Promise<readonly [Platform, string[]]> {
    const abort = new AbortController();
    activeTicks.add(abort);
    activePlatformTicks[platform] += 1;
    const tickId = ++tickSequence;
    const tickStartedAt = Date.now();
    diagnosticEvent("debug", `Tick #${tickId} started (trigger=${trigger}, platforms=${platform})`, platform);
    try {
      const claimed = await runTick(tickId, tickStartedAt, [platform], abort.signal);
      return [platform, claimed[platform] ?? []];
    } catch (error) {
      if (abort.signal.aborted) return [platform, []];
      throw error;
    } finally {
      activeTicks.delete(abort);
      activePlatformTicks[platform] -= 1;
      diagnosticEvent("debug", `Tick #${tickId} finished after ${Date.now() - tickStartedAt}ms (trigger=${trigger}, platforms=${platform})`, platform);
    }
  }

  async function runTick(
    tickId: number,
    tickStartedAt: number,
    platforms: Platform[] | undefined,
    signal: AbortSignal,
  ): Promise<ClaimedRewards> {
    const claimedRewards: ClaimedRewards = {};
    const settings = await deps.loadSettings();
    const requestedPlatforms = platforms ?? PLATFORMS;
    const excludedPlatforms = new Set<Platform>();
    if (isFarmingActive(settings)) {
      if (requestedPlatforms.includes("twitch")) {
        const twitchReady = await prepareTwitchIntegrity(settings, signal);
        if (!twitchReady) excludedPlatforms.add("twitch");
      }
      const authPlatforms = requestedPlatforms.filter((platform) => !excludedPlatforms.has(platform));
      if (authPlatforms.length > 0) {
        const authStartedAt = Date.now();
        try {
          await refreshAuthHealth(authPlatforms, settings, false, signal);
          for (const platform of authPlatforms) {
            diagnosticEvent("debug", `Tick #${tickId} refreshed auth health in ${Date.now() - authStartedAt}ms`, platform);
          }
        } catch (error) {
          const failures = flattenedRefreshFailures(error);
          const setupFailures = failures.filter((failure): failure is AuthProbeSetupError =>
            failure instanceof AuthProbeSetupError);
          if (setupFailures.length === 0) throw error;
          for (const failure of setupFailures) excludedPlatforms.add(failure.platform);
          let reportingFailure: unknown;
          try {
            await reportAuthSetupFailures(setupFailures);
          } catch (failure) {
            reportingFailure = failure;
          }
          const nonSetupFailures = failures.filter((failure) => !(failure instanceof AuthProbeSetupError));
          if (nonSetupFailures.length > 0) {
            if (reportingFailure !== undefined) {
              throw new AggregateError(
                [...failures, reportingFailure],
                "Authentication refresh and interruption persistence failed",
              );
            }
            throw error;
          }
          if (reportingFailure !== undefined) throw reportingFailure;
        }
      }
    }
    const schedulerPlatforms = requestedPlatforms.filter((platform) =>
      !excludedPlatforms.has(platform));
    if (schedulerPlatforms.length === 0) return claimedRewards;
    const platform = schedulerPlatforms[0];
    await withStateLock(() => withEventCollector(async (emit, events) => {
      signal.throwIfAborted();
      const settings = await deps.loadSettings();
      const state = await deps.loadState();
      const nextWaitingClaimRewardIds: Record<Platform, Set<string>> = {
        twitch: new Set(waitingClaimRewardIds.twitch),
        kick: new Set(waitingClaimRewardIds.kick),
      };
      let nextState: SchedulerState;
      try {
        const adapters = createSelectedAdapters(settings, emit, schedulerPlatforms);
        // Observed here rather than returned by the scheduler: the controller
        // already sees every emitted event, and the post-claim handoff only
        // needs to know which platforms claimed.
        const claimObservingEmit: EventEmitter = (event) => {
          if (event.category === "activity" && event.code === "reward_claimed" && event.platform) {
            (claimedRewards[event.platform] ??= []).push(event.data.rewardId);
          }
          emit(event);
        };
        const eventsBeforeTick = events.length;
        const result = await runSchedulerTick(state, settings, adapters, {
          platforms: schedulerPlatforms,
          stopPageContextTabs: deps.stopPageContextTabs,
          waitingClaimRewardIds: nextWaitingClaimRewardIds,
          emit: claimObservingEmit,
          signal,
        });
        signal.throwIfAborted();
        const lifecycleEvents = farmingLifecycleEvents(state, result.state);
        for (const event of lifecycleEvents) emit(event);
        await emitNotifications(settings, state, result.state, result.events);
        signal.throwIfAborted();
        await applyAdFocusForState(result.state, emit);
        signal.throwIfAborted();
        await reconcileTablessWatchers(result.state, settings, adapters, emit, schedulerPlatforms);
        signal.throwIfAborted();
        nextState = result.state;
        if (settings.criticalFailurePromptEnabled) {
          // Page-context tabs are created deep inside tabs.ts, which has no access
          // to scheduler state, and their events come from the adapters' own
          // emitter rather than the tick's. Reading them back off this tick's
          // collected events catches every emitter, not just the wrapped one.
          for (const event of events.slice(eventsBeforeTick)) {
            if (event.category !== "activity" || event.code !== "page_context_opened") continue;
            const transition = recordManagedTabOpen(nextState, event.platform, Date.now(), {
              source: "page_context",
              reason: event.data.reason,
            });
            nextState = transition.state;
            if (transition.event) emit(transition.event);
          }
          // Keep the registry that gates page-context creation in step with the
          // state we are about to persist, so the very next fetch is suppressed.
          syncManagedTabBreakers(nextState, schedulerPlatforms);
        }
      } catch (error) {
        // The tick was rolled back, so any partial claim set is not actionable.
        for (const key of Object.keys(claimedRewards) as Platform[]) delete claimedRewards[key];
        clearOperationalEvents(events);
        if (signal.aborted) return;
        const detail = error instanceof Error ? error.message : "Scheduler tick failed";
        emit({ category: "activity", code: "interruption", level: "error", platform, data: { reason: "platform_error", detail } });
        emit({ category: "diagnostic", level: "error", platform, message: detail });
        await persistPlatformAndReport(platform, state, events);
        return;
      }
      await persistPlatformAndReport(platform, nextState, events);
      waitingClaimRewardIds[platform].clear();
      for (const rewardId of nextWaitingClaimRewardIds[platform]) {
        waitingClaimRewardIds[platform].add(rewardId);
      }
    }), schedulerPlatforms);
    return claimedRewards;
  }

  async function checkAuthHealth(platform: Platform): Promise<void> {
    await refreshAuthHealth([platform]);
  }

  async function invalidateAuthHealth(platform: Platform): Promise<void> {
    const generations = await beginAuthRefresh([platform]);
    const generation = generations[platform];
    const settings = await deps.loadSettings();
    if (!settings.platform[platform].enabled) return;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (generation === undefined || authRefreshGeneration[platform] !== generation) return;
      const state = await deps.loadState();
      const transition = applyPlatformAuthHealth(state, platform, { status: "checking" });
      if (transition.event) emit(transition.event);
      await persistAndReport(transition.state, events);
    }));
  }

  async function handleTabRemoved(tabId: number): Promise<void> {
    // Serialize the load-modify-persist under the state lock so it cannot race a
    // concurrent tick()/heartbeat (both fire on a ~1-minute cadence while the
    // user can close a tab at any moment). A removal never runs the scheduler
    // directly (#193): it only records state, and the next ordinary alarm reads
    // it. Closing a tab LurkLoot owns now records a per-platform pause, so the
    // alarm keeps the platform paused instead of reopening the tab a minute
    // later. The user's enabled/running settings are deliberately untouched;
    // the popup shows the pause with a one-click resume.
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      const manualPlatforms = (["twitch", "kick"] as Platform[]).filter((platform) => state.manualWatch?.[platform]?.tabId === tabId);
      let nextState = state;
      if (manualPlatforms.length > 0) {
        const manualWatch = { ...state.manualWatch };
        for (const platform of manualPlatforms) delete manualWatch[platform];
        nextState = {
          ...state,
          manualWatch,
        };
      }

      const closedManagedPlatforms: Platform[] = [];
      for (const platform of PLATFORMS) {
        const session = state.sessions[platform];
        if (
          session.status === "watching"
          && session.tabManagedByExtension
          && session.tabId === tabId
        ) {
          closedManagedPlatforms.push(platform);
          emit({ category: "diagnostic", platform, level: "info", message: "Managed watch tab was closed manually; pausing farming for this platform until the user resumes" });
        }
      }

      if (closedManagedPlatforms.length > 0) {
        const closedAt = new Date().toISOString();
        const sessions = { ...nextState.sessions };
        const managedWatchTabs = { ...nextState.managedWatchTabs };
        const manualClosePause = { ...nextState.manualClosePause };
        for (const platform of closedManagedPlatforms) {
          sessions[platform] = {
            platform,
            status: "paused",
            offlineChecks: 0,
            message: "Farming tab closed",
            reasonCode: "manual_tab_close",
          };
          delete managedWatchTabs[platform];
          const channelUrl = state.managedWatchTabs?.[platform]?.channelUrl ?? state.sessions[platform].channel?.url;
          manualClosePause[platform] = {
            platform,
            closedAt,
            ...(channelUrl ? { channelUrl } : {}),
          };
        }
        nextState = { ...nextState, sessions, managedWatchTabs, manualClosePause };
      }

      if (nextState !== state || events.length > 0) await persistAndReport(nextState, events);
    }));
  }

  // Explicit user action: clears the manual-close pause so the next tick may
  // farm this platform again. Only the user can undo the gesture they made.
  async function resumeAfterManualClose(platform: Platform): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const state = await deps.loadState();
      if (!state.manualClosePause?.[platform]) {
        await reportBestEffort(events);
        return;
      }
      const manualClosePause = { ...state.manualClosePause };
      delete manualClosePause[platform];
      emit({ category: "diagnostic", platform, level: "info", message: "Resuming farming after a manual watch tab close" });
      await persistAndReport({ ...state, manualClosePause }, events);
    }));
  }

  function tablessWatchContext(): WatchContext {
    // The Twitch watcher resolves the viewer id itself; nothing extra needed yet.
    return {};
  }

  // Aligns the live tabless watchers with the scheduler's session state: starts
  // or switches a watcher for each platform farming tablessly, and stops the
  // rest (idle, paused, fell back to a tab, or watching with a real tab).
  async function reconcileTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<void> {
    const targets = platforms ?? PLATFORMS;
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const wantsTabless = settings.platform[platform].enabled
        && state.authHealth[platform].status === "healthy"
        && session.status === "watching"
        && session.watchMode === "tabless"
        && Boolean(session.channel);
      const existing = tablessWatchers.get(platform);

      if (wantsTabless && session.channel && adapter.createTablessWatcher) {
        const watcher = existing ?? adapter.createTablessWatcher();
        if (!existing) tablessWatchers.set(platform, watcher);
        drainWatcherEvents(watcher, emit);
        if (watcher.channelUrl !== session.channel.url) {
          let startFailed = false;
          let startError: unknown;
          try {
            await watcher.start(session.channel, tablessWatchContext());
          } catch (error) {
            startFailed = true;
            startError = error;
          } finally {
            drainWatcherEvents(watcher, emit);
          }
          if (startFailed) {
            emit({
              category: "diagnostic",
              platform,
              level: "warn",
              message: startError instanceof Error ? startError.message : "Could not start the tabless watcher",
            });
          }
        }
      } else if (existing) {
        drainWatcherEvents(existing, emit);
        try {
          await existing.stop();
        } catch (error) {
          emitHostCallbackError(emit, platform, error, "Could not stop the tabless watcher");
        } finally {
          drainWatcherEvents(existing, emit);
          tablessWatchers.delete(platform);
        }
      }
    }
  }

  function drainWatcherEvents(watcher: TablessWatchController, emit: EventEmitter): void {
    for (const event of watcher.drainEvents()) emit(event);
  }

  // Fired by the 1-minute watch alarm. Runs one heartbeat per active tabless
  // watcher and records its health on the session, falling back to a real tab
  // (by re-running the scheduler) when a heartbeat keeps failing.
  async function runWatchHeartbeat(): Promise<void> {
    const settings = await deps.loadSettings();
    if (!isFarmingActive(settings)) return;
    const fallbackPlatforms = await withStateLock<Platform[]>(() => withEventCollector(async (emit, events) => {
      let nextState = await deps.loadState();
      registerManagedPageContextTabs(nextState.managedPageContextTabs ?? {});
      // After a service-worker restart the in-memory watcher map is empty, so
      // rebuild it from persisted tabless sessions before the size check below.
      // Otherwise the 1-minute watch alarm would do nothing until the next
      // (possibly distant) discovery tick re-armed the watchers, stalling Twitch
      // tabless farming. Done inside the state lock so it cannot race tick()'s
      // own reconcile over the shared watcher map (the discovery and watch alarms
      // both fire on a ~1-minute cadence). reconcileTablessWatchers only calls
      // watcher.start() on a fresh start/channel switch and never re-acquires the
      // lock, so holding it here is safe (no reentrancy).
      await reconcileTablessWatchers(nextState, settings, createAdapters(settings, emit), emit);
      if (tablessWatchers.size === 0) {
        await reportBestEffort(events);
        return [];
      }

      let changed = false;
      const fallbacks: Platform[] = [];

      for (const [platform, watcher] of [...tablessWatchers]) {
        const session = nextState.sessions[platform];
        if (
          nextState.authHealth[platform].status !== "healthy"
          || session.status !== "watching"
          || session.watchMode !== "tabless"
        ) {
          try {
            await watcher.stop();
          } catch (error) {
            emitHostCallbackError(emit, platform, error, "Could not stop the tabless watcher");
          } finally {
            drainWatcherEvents(watcher, emit);
            tablessWatchers.delete(platform);
          }
          continue;
        }

        let ok = false;
        let message: string | undefined;
        drainWatcherEvents(watcher, emit);
        try {
          const result = await watcher.tick(tablessWatchContext());
          ok = result.ok;
          message = result.message;
        } catch (error) {
          message = error instanceof Error ? error.message : "Tabless heartbeat failed";
        } finally {
          drainWatcherEvents(watcher, emit);
        }

        const previousChecks = session.heartbeatChecks ?? 0;
        const heartbeatChecks = ok ? 0 : previousChecks + 1;
        nextState = {
          ...nextState,
          sessions: {
            ...nextState.sessions,
            [platform]: {
              ...session,
              lastHeartbeatAt: new Date().toISOString(),
              lastHeartbeatOk: ok,
              heartbeatChecks,
            },
          },
        };
        changed = true;

        if (ok && previousChecks > 0) {
          emit({ category: "diagnostic", platform, level: "info", message: "Tabless watch heartbeat recovered" });
        } else if (!ok && previousChecks === 0) {
          emit({ category: "diagnostic", platform, level: "warn", message: message ?? "Tabless watch heartbeat failed" });
        }
        if (!ok && heartbeatChecks >= settings.tablessFallbackFailureLimit && !fallbacks.includes(platform)) {
          fallbacks.push(platform);
          emit({ category: "diagnostic", platform, level: "warn", message: "Tabless watch heartbeat keeps failing; falling back to a watch tab" });
        }
      }

      nextState = {
        ...nextState,
        managedPageContextTabs: currentManagedPageContextTabs(),
      };

      if (changed) await persistAndReport(nextState, events);
      else await reportBestEffort(events);
      return fallbacks;
    }));

    // chooseTablessWatch now sees heartbeatChecks past the tabless fallback limit and opens a tab.
    // Run outside the lock: tick() acquires the lock itself.
    for (const platform of fallbackPlatforms) {
      await tick([platform], "tabless_fallback");
    }
  }

  // Aborts every in-flight handoff. Called when farming stops, when a settings
  // session begins, and on runtime restart.
  // Scoped when a single platform is switched off: with per-platform toggles,
  // cancelling every handoff would abort work the other platform still needs.
  function abortClaimHandoffs(platform?: Platform): void {
    for (const [handoffPlatform, controller] of claimHandoffs) {
      if (platform && handoffPlatform !== platform) continue;
      controller.abort();
      claimHandoffs.delete(handoffPlatform);
    }
  }

  function abortActiveTicks(reason: string): void {
    for (const controller of activeTicks) {
      controller.abort(new Error(reason));
    }
  }

  function closeTwitchIntegrityLifecycle(reason: string): void {
    const error = new Error(reason);
    if (integrityLifecycleOpen) {
      integrityLifecycleOpen = false;
      integrityLifecycleGeneration += 1;
    }
    integrityRefreshAbort?.abort(error);
    deps.cancelTwitchIntegrityAcquisition?.(error);
  }

  function reopenTwitchIntegrityLifecycle(): void {
    if (controllerShutdown || integrityLifecycleOpen) return;
    integrityLifecycleOpen = true;
    integrityLifecycleGeneration += 1;
  }

  function reconcileTwitchIntegrityLifecycle(enabled: boolean | undefined): void {
    if (enabled === true) reopenTwitchIntegrityLifecycle();
    else if (enabled === false) closeTwitchIntegrityLifecycle("Twitch disabled");
  }

  function shutdown(): void {
    controllerShutdown = true;
    twitchSettingsTransitionGeneration += 1;
    abortActiveTicks("Controller shutdown");
    closeTwitchIntegrityLifecycle("Controller shutdown");
    void clearTwitchIntegrityAlarmBestEffort();
    abortClaimHandoffs();
  }

  async function prepareForHostReset(resetHostStorage?: () => Promise<void>): Promise<void> {
    twitchSettingsTransitionGeneration += 1;
    abortActiveTicks("Host reset");
    closeTwitchIntegrityLifecycle("Host reset");
    await clearTwitchIntegrityAlarmBestEffort();
    abortClaimHandoffs();
    await withSettingsLock(() => withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const adapters = createAdapters(settings, emit);
      const managedTabs = Object.values(state.managedWatchTabs ?? {}).filter((tab): tab is ManagedWatchTab => tab?.ownedByExtension === true);
      if (deps.closeManagedTabs && managedTabs.length > 0) await deps.closeManagedTabs(managedTabs);
      for (const platform of PLATFORMS) {
        const watcher = tablessWatchers.get(platform);
        if (watcher) await watcher.stop();
        await deps.applyAdFocus?.(platform, state.sessions[platform].tabId, false, emit);
        await adapters[platform].stopWatchTab?.(state.sessions[platform], { closeManagedTabs: true });
      }
      if (deps.stopPageContextTabs) {
        await deps.stopPageContextTabs(state.managedPageContextTabs ?? {}, {
          platforms: PLATFORMS,
          reason: "automation_disabled",
          emit,
        });
      }
      tablessWatchers.clear();
      registerManagedPageContextTabs({});
      installedTwitchIntegrity = undefined;
      persistedIntegrityToken = undefined;
      twitchIntegrityRefreshDue = undefined;
      setTwitchIntegrity(undefined);
      await resetHostStorage?.();
      lastPersistedTwitchEnabled = undefined;
      await reportBestEffort(events);
    })));
  }

  // Bounded post-claim handoff (see docs/superpowers/specs/2026-07-19-twitch-claim-handoff-design.md).
  // Re-runs a scoped tick on the configured cadence until the platform lands on
  // a reward other than the ones just claimed, then hands off to the immediate
  // heartbeat. Runs OUTSIDE the state lock: each inner tick() acquires the lock
  // on its own, so a long handoff never blocks telemetry or user actions.
  async function runClaimHandoff(platform: Platform, justClaimedRewardIds: readonly string[] = []): Promise<void> {
    if (claimHandoffs.has(platform)) return;
    // Reserved synchronously, before the first await. Registering after the
    // async setup would let two triggers past the guard into concurrent loops,
    // and would let an abortClaimHandoffs() landing mid-setup miss this handoff
    // entirely.
    const abort = new AbortController();
    claimHandoffs.set(platform, abort);

    try {
      const settings = await deps.loadSettings();
      if (abort.signal.aborted) return;
      if (!settings.postClaimHandoff) return;
      if (!settings.platform[platform].enabled) return;

      // Deliberately bypasses the createAdapters() wrapper: that records every
      // compatibility diagnostic it emits into the dedup caches, so probing
      // through it with a no-op emit would mark a diagnostic as "already
      // reported" without it ever reaching a sink, permanently suppressing it on
      // the next genuine tick. This is a capability lookup, not a reporting
      // context; the handoff's own tick() reports normally.
      const { adapters } = deps.createAdapters(() => undefined, settings);
      if (!adapters[platform].supportsPostClaimHandoff) return;

      const claimed = new Set(justClaimedRewardIds);
      // A session is a successful handoff target when it is watching a reward
      // other than the ones just claimed.
      const isSuccessor = (session: WatchSession): boolean =>
        session.status === "watching" && session.rewardId != null && !claimed.has(session.rewardId);

      // The triggering tick may already have found the successor, in which case
      // there is nothing to poll for — only a heartbeat to bring forward.
      const before = await deps.loadState();
      if (abort.signal.aborted) return;
      if (isSuccessor(before.sessions[platform])) {
        await sendImmediateHeartbeat(platform, before.sessions[platform]);
        return;
      }

      // The deadline is computed once. A claim occurring inside the loop never
      // extends it, so the worst case stays fixed at maxSeconds.
      const deadline = Date.now() + settings.postClaimHandoffMaxSeconds * 1000;
      const intervalMs = settings.postClaimHandoffIntervalSeconds * 1000;

      while (!abort.signal.aborted && Date.now() < deadline) {
        // Capped at the remaining budget, so an interval longer than what is
        // left cannot push a refresh past the deadline.
        await wait(Math.min(intervalMs, deadline - Date.now()), abort.signal);
        if (abort.signal.aborted || Date.now() >= deadline) break;

        await tick([platform], "claim_handoff");
        if (abort.signal.aborted) break;

        const session = (await deps.loadState()).sessions[platform];
        // Re-checked after the load: a cancellation during it must not still
        // transmit.
        if (abort.signal.aborted) break;
        if (isSuccessor(session)) {
          await sendImmediateHeartbeat(platform, session);
          return;
        }
        // Nothing eligible left on this platform: the chain is finished, so stop
        // rather than burning the rest of the budget on identical refreshes.
        if (session.status !== "watching" && isNothingLeftToFarm(session.reasonCode)) return;
      }
    } finally {
      if (claimHandoffs.get(platform) === abort) claimHandoffs.delete(platform);
    }
  }

  // Runs a tick without holding the caller open for it. A user action gets its
  // snapshot back immediately; the popup re-polls getSnapshot on its own cadence
  // and picks the result up when the tick lands.
  function tickInBackground(
    platforms: Platform[] | undefined,
    trigger: TickTrigger,
    onCompleted?: () => void,
  ): void {
    if (controllerShutdown) return;
    const run = tickAndHandOff(platforms, trigger)
      .then(() => onCompleted?.())
      .catch((error) => {
        const platform = platforms?.length === 1 ? platforms[0] : undefined;
        diagnosticEvent("warn", `Background tick (trigger=${trigger}) failed: ${error instanceof Error ? error.message : String(error)}`, platform);
      });
    backgroundWork = backgroundWork.then(() => run, () => run);
  }

  // Detached ticks have no caller to await them, which leaves observers (tests,
  // and the CLI's one-shot mode) with no way to know when the work they just
  // triggered has actually landed. Settling drains the chain until it stops
  // growing, so a tick that queues a post-claim handoff is covered too.
  async function settleBackgroundWork(): Promise<void> {
    await initialTwitchIntegrityLoad;
    let pending = backgroundWork;
    for (;;) {
      await pending;
      if (backgroundWork === pending) return;
      pending = backgroundWork;
    }
  }

  // The persisted session still describes the platform as it was *before* the
  // toggle, and nothing rewrites it until the tick finishes. Detaching the tick
  // alone would not fix that: the popup polls stored state, so a slow tick can
  // leave it rendering a lifecycle that contradicts the switch the user just
  // flipped. Persist the typed transition up front instead.
  async function markPlatformsStarting(
    platforms: readonly Platform[],
    transitionIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    await withStateLock(async () => {
      const state = await deps.loadState();
      if (!transitionIsCurrent()) return;
      let changed = false;
      const sessions = { ...state.sessions };
      for (const platform of platforms) {
        const session = state.sessions[platform];
        // An already-watching platform is not "starting" — leave its live status
        // (and its channel) alone so a toggle elsewhere never blanks it.
        if (session.status === "watching") continue;
        sessions[platform] = {
          ...session,
          status: "starting",
          message: "Starting automation",
          reasonCode: "no_existing_session",
        };
        changed = true;
      }
      if (!changed) return;
      if (!transitionIsCurrent()) return;
      await saveOperationalState({ ...state, sessions });
      if (!transitionIsCurrent()) {
        await saveOperationalState(state);
      }
    });
  }

  // The normal entry point for alarm- and message-driven ticks: run the tick,
  // then hand off for every platform that claimed. Kept separate from tick() so
  // the handoff's own inner ticks cannot recurse into another handoff.
  async function tickAndHandOff(platforms?: Platform[], trigger: TickTrigger = "unknown"): Promise<void> {
    const claimed = await tick(platforms, trigger);
    const handoffPlatforms = Object.keys(claimed) as Platform[];
    const results = await Promise.allSettled(handoffPlatforms.map((platform) =>
      runClaimHandoff(platform, claimed[platform] ?? [])));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "rejected") continue;
      diagnosticEvent(
        "warn",
        `Post-claim handoff failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        handoffPlatforms[index],
      );
    }
  }

  // Transmits one heartbeat for a freshly-selected tabless target instead of
  // waiting for the next watch alarm. A visible tab needs nothing: it earns
  // progress continuously and the detecting tick already re-pointed it.
  async function sendImmediateHeartbeat(platform: Platform, session: WatchSession): Promise<void> {
    if (session.watchMode !== "tabless") return;
    const watcher = tablessWatchers.get(platform);
    if (!watcher) return;

    // A channel switch always transmits: lastHeartbeatAt then refers to the
    // previous target, so its recency says nothing about the new one.
    const sameChannel = watcher.channelUrl != null && watcher.channelUrl === session.channel?.url;
    const lastHeartbeatAt = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Number.NaN;
    const recent = !Number.isNaN(lastHeartbeatAt) && Date.now() - lastHeartbeatAt < RECENT_HEARTBEAT_MS;
    if (sameChannel && recent) return;

    await withStateLock(() => withEventCollector(async (emit, events) => {
      let ok = false;
      let message: string | undefined;
      drainWatcherEvents(watcher, emit);
      try {
        const result = await watcher.tick(tablessWatchContext());
        ok = result.ok;
        message = result.message;
      } catch (error) {
        message = error instanceof Error ? error.message : "Post-claim heartbeat failed";
      } finally {
        drainWatcherEvents(watcher, emit);
      }

      const state = await deps.loadState();
      const current = state.sessions[platform];
      const nextState: SchedulerState = {
        ...state,
        sessions: {
          ...state.sessions,
          [platform]: {
            ...current,
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeatOk: ok,
            heartbeatChecks: ok ? 0 : (current.heartbeatChecks ?? 0) + 1,
          },
        },
      };
      emit({
        category: "diagnostic",
        platform,
        level: ok ? "debug" : "warn",
        message: ok
          ? "Post-claim handoff started the next reward without waiting for the watch alarm"
          : message ?? "Post-claim heartbeat failed",
      });
      await persistAndReport(nextState, events);
    }));
  }

  async function recordPlaybackTelemetry(
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const session = state.sessions[message.platform];
      const isManagedWatchTab = senderTabId != null
        && session.status === "watching"
        && session.watchMode !== "tabless"
        && session.tabId === senderTabId;

      if (!isManagedWatchTab) {
        if (senderTabId != null) {
          await persistAndReport(recordManualWatchTelemetry(state, settings, message, senderTabId), events);
        }
        return;
      }

      const previous = session.playback;
      const telemetry = message.telemetry;
      let nextState: SchedulerState = {
        ...state,
        sessions: {
          ...state.sessions,
          [message.platform]: {
            ...session,
            playback: {
              ...telemetry,
              platform: message.platform,
              checkedAt: new Date().toISOString(),
            },
            // Telemetry arrives between scheduler ticks. Clearing the counter the
            // moment playback is confirmed means a tab that dipped unhealthy and
            // recovered is never condemned by a stale count (#250).
            playbackChecks: isPlaybackTelemetryHealthy(telemetry) ? 0 : session.playbackChecks,
          },
        },
      };

      // Only log transitions — telemetry arrives every few seconds, so logging the
      // raw stream would bury everything else.
      const playbackDiagnostics = session.status === "watching"
        ? playbackEvents(message.platform, previous, telemetry)
        : [];
      for (const event of playbackDiagnostics) emit(event);

      await saveOperationalState(nextState);
      try {
        if (deps.applyAdFocus && session.status === "watching" && session.tabId === senderTabId) {
          await deps.applyAdFocus(message.platform, session.tabId, Boolean(message.telemetry.adActive), emit);
        }
      } catch (error) {
        emitHostCallbackError(emit, message.platform, error, "Could not apply ad focus");
      } finally {
        await reportBestEffort(events);
      }
    }));
  }

  function recordManualWatchTelemetry(
    state: SchedulerState,
    settings: EngineSettings,
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId: number,
  ): SchedulerState {
    const manualWatch = { ...state.manualWatch };
    if (!settings.pauseOnManualWatch) {
      delete manualWatch[message.platform];
      return { ...state, manualWatch };
    }

    const active = message.telemetry.playingVideoCount > 0 && !message.telemetry.documentHidden;
    const previous = manualWatch[message.platform];
    const recentPrevious = previous?.active && Date.now() - Date.parse(previous.checkedAt) <= MANUAL_WATCH_TTL_MS;
    if (!active && previous?.tabId !== senderTabId && recentPrevious) return state;

    manualWatch[message.platform] = {
      platform: message.platform,
      tabId: senderTabId,
      checkedAt: new Date().toISOString(),
      active,
    };
    return { ...state, manualWatch };
  }

  async function applyAdFocusForState(state: SchedulerState, emit: EventEmitter): Promise<void> {
    if (!deps.applyAdFocus) return;
    for (const platform of ["twitch", "kick"] as Platform[]) {
      const session = state.sessions[platform];
      const watching = session.status === "watching" && session.tabId != null;
      try {
        await deps.applyAdFocus(platform, session.tabId, watching && Boolean(session.playback?.adActive), emit);
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not apply ad focus");
      }
    }
  }

  async function getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl> {
    const [policy, state] = await Promise.all([deps.loadTabPlaybackPolicy?.(), deps.loadState()]);
    const session = state.sessions[message.platform];
    return {
      managed: senderTabId != null
        && session.status === "watching"
        && session.tabId === senderTabId,
      keepVideosUnmuted: policy?.keepVideosUnmuted ?? true,
    };
  }

  async function claimRewardNow(
    message: Extract<CoreRuntimeMessage, { type: "claimReward" }>,
  ): Promise<RuntimeSnapshot<S>> {
    // Hold the state lock across the whole load→persist so a concurrent tick or
    // telemetry write can't clobber the claimed-reward update. snapshot() runs
    // after the lock so it reflects the committed state.
    let claimedManually = false;
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
      const campaigns = state.campaigns[message.platform];
      const campaign = campaigns.find((item) => item.id === message.campaignId);
      const reward = campaign?.rewards.find((item) => item.id === message.rewardId);

      if (!campaign || !reward) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: "Reward claim skipped because the campaign or reward is no longer available",
        });
        await persistAndReport(state, events);
        return;
      }

      if (!canClaimReward(reward)) {
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "warn",
          message: `${reward.name} is not ready to claim`,
        });
        await persistAndReport(state, events);
        return;
      }

      let stateWithCampaigns: SchedulerState;
      try {
        const claimed = await createAdapters(settings, emit)[message.platform].claimReward(campaign, reward);
        claimedManually = claimed;
        const nextCampaigns = campaigns.map((item) => {
          if (item.id !== campaign.id) return item;
          const rewards = item.rewards.map((candidate) => candidate.id === reward.id && claimed
            ? { ...candidate, status: "claimed" as const, watchedMinutes: candidate.requiredMinutes }
            : candidate);
          return reconcileCampaignAfterClaims(item, rewards);
        });
        stateWithCampaigns = {
          ...state,
          campaigns: {
            ...state.campaigns,
            [message.platform]: nextCampaigns,
          },
        };
        const claimEvent: EngineEvent = claimed
          ? {
            category: "activity",
            platform: message.platform,
            level: "info",
            code: "reward_claimed",
            data: {
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
              method: "manual",
            },
          }
          : {
            category: "diagnostic",
            platform: message.platform,
            level: "warn",
            message: `Could not claim ${reward.name} from ${campaign.name}`,
          };
        emit(claimEvent);
        if (claimed && settings.notifyRewardEarned) {
          await safeNotify(
            await tr("notificationRewardClaimed"),
            await tr("notificationRewardFromCampaign", [reward.name, campaign.name]),
          );
        }
      } catch (error) {
        clearOperationalEvents(events);
        emit({
          category: "diagnostic",
          platform: message.platform,
          level: "error",
          message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
        });
        await persistAndReport(state, events);
        return;
      }
      await persistAndReport(stateWithCampaigns, events);
    }));
    // Outside the lock: runClaimHandoff ticks, which takes the lock itself.
    if (claimedManually) await runClaimHandoff(message.platform, [message.rewardId]);
    return snapshot();
  }

  async function handleMessage(
    message: CoreRuntimeMessage,
    sender?: { tab?: { id?: number } },
  ): Promise<RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void> {
    if (message.type === "getPlaybackControl") {
      return getPlaybackControl(message, sender?.tab?.id);
    }

    if (message.type === "playbackTelemetry") {
      await recordPlaybackTelemetry(message, sender?.tab?.id);
      return undefined;
    }

    if (message.type === "getSnapshot") {
      return snapshot();
    }

    // setPlatformEnabled and setAutomation are the same operation now that there
    // is no master switch to flip alongside the platform flag. Both are kept:
    // they are separate wire messages with existing callers.
    if (message.type === "setPlatformEnabled" || message.type === "setAutomation") {
      const platformLabel = message.platform === "twitch" ? "Twitch" : "Kick";
      const action = message.enabled ? "enable" : "disable";
      diagnosticEvent("info", `User requested ${platformLabel} automation ${action}`, message.platform);
      if (activePlatformTicks[message.platform] > 0) {
        diagnosticEvent(
          "info",
          `${platformLabel} automation ${action} queued behind an active tick`,
          message.platform,
        );
      }
      // Stopping must cancel any loop still refreshing in the background.
      if (!message.enabled) abortClaimHandoffs(message.platform);
      const twitchTransitionGeneration = message.platform === "twitch"
        ? ++twitchSettingsTransitionGeneration
        : undefined;
      const twitchTransitionIsCurrent = (): boolean =>
        !controllerShutdown
        && twitchTransitionGeneration === twitchSettingsTransitionGeneration;
      const twitchLifecycleOpenBeforeTransition = message.platform === "twitch"
        ? integrityLifecycleOpen
        : undefined;
      let twitchSettingsLoaded = false;
      const stoppingTwitch = message.platform === "twitch" && !message.enabled;
      if (stoppingTwitch) closeTwitchIntegrityLifecycle("Twitch disabled");
      try {
        await updateStoredSettings({
          platform: {
            [message.platform]: {
              enabled: message.enabled,
            },
          },
        }, message.platform === "twitch"
          ? (settings) => {
              lastPersistedTwitchEnabled = settings.platform.twitch.enabled;
              if (twitchTransitionIsCurrent()) {
                reconcileTwitchIntegrityLifecycle(settings.platform.twitch.enabled);
              }
            }
          : undefined,
        message.platform === "twitch"
          ? (settings) => {
              twitchSettingsLoaded = true;
              lastPersistedTwitchEnabled = settings.platform.twitch.enabled;
            }
          : undefined);
      } catch (error) {
        if (message.platform === "twitch" && twitchTransitionIsCurrent()) {
          const rollbackEnabled = twitchSettingsLoaded
            ? lastPersistedTwitchEnabled
            : twitchLifecycleOpenBeforeTransition;
          reconcileTwitchIntegrityLifecycle(rollbackEnabled);
          if (stoppingTwitch && rollbackEnabled === true) {
            await restoreTwitchIntegritySchedule(twitchTransitionIsCurrent);
          }
        }
        throw error;
      }
      if (message.platform === "twitch") {
        if (!twitchTransitionIsCurrent()) return snapshot();
        if (message.enabled) {
          await restoreTwitchIntegritySchedule(twitchTransitionIsCurrent);
        } else {
          await clearTwitchIntegrityAlarmBestEffort();
        }
        if (!twitchTransitionIsCurrent()) return snapshot();
      }
      if (message.enabled) {
        await markPlatformsStarting(
          [message.platform],
          message.platform === "twitch"
            ? twitchTransitionIsCurrent
            : undefined,
        );
        if (message.platform === "twitch" && !twitchTransitionIsCurrent()) {
          return snapshot();
        }
      }
      // Always scoped to the toggled platform. Nothing about this change can
      // affect the other one any more, so it is never dragged through this
      // platform's discovery.
      tickInBackground(
        [message.platform],
        message.type === "setAutomation" ? "automation_toggle" : "platform_toggle",
        () => diagnosticEvent("info", `${platformLabel} automation ${action} completed`, message.platform),
      );
      return snapshot();
    }

    if (message.type === "saveSettings") {
      const settings = await updateStoredSettings(message.settingsPatch);
      if (message.tickAfterSave && isFarmingActive(settings)) {
        tickInBackground(message.tickAfterSavePlatforms, "settings_saved");
      }
      return snapshot();
    }

    if (message.type === "resumeAfterManualClose") {
      await resumeAfterManualClose(message.platform);
      const settings = await deps.loadSettings();
      if (settings.platform[message.platform].enabled) {
        await markPlatformsStarting([message.platform]);
        tickInBackground([message.platform], "manual_resume");
      }
      return snapshot();
    }

    if (message.type === "claimReward") {
      return claimRewardNow(message);
    }

    if (message.type === "searchCategories") {
      return withEventCollector(async (emit, events) => {
        const settings = await deps.loadSettings();
        let categories: CategorySearchResult["categories"] = [];
        try {
          categories = await createAdapters(settings, emit)[message.platform].searchCategories?.(message.query) ?? [];
        } catch (error) {
          emit({
            category: "diagnostic",
            level: "warn",
            message: `Category search failed: ${error instanceof Error ? error.message : String(error)}`,
            platform: message.platform,
          });
        }
        await reportBestEffort(events);
        return { categories };
      });
    }

    if (message.type === "tickNow") {
      await tickAndHandOff(undefined, "manual_tick");
      return snapshot();
    }
    if (message.type === "dismissCriticalFailure") {
      // Serialized like every other load→mutate→persist handler here: a dismiss
      // racing an alarm-driven tick would otherwise interleave loads and drop
      // one side's write to the persisted state.
      await withStateLock(() => withEventCollector(async (emit, events) => {
        const state = await deps.loadState();
        const transition = dismissCriticalFailure(state, message.platform, Date.now());
        if (transition.event) emit(transition.event);
        // Closing the breaker here is what lets farming resume immediately
        // instead of waiting for the next tick to sync the registry.
        syncManagedTabBreakers(transition.state, [message.platform]);
        await persistAndReport(transition.state, events);
      }));
      await tickAndHandOff(undefined, "critical_failure_dismissed");
      return snapshot();
    }
  }

  async function safeNotify(title: string, message: string): Promise<void> {
    if (!deps.createNotification) return;
    try {
      await deps.createNotification({ title, message });
    } catch {
      // Notification delivery is best-effort and must not fail scheduler ticks.
    }
  }

  async function tr(key: string, substitutions?: string | string[]): Promise<string> {
    const translated = await deps.translate?.(key, substitutions);
    if (translated) return translated;
    const template = EN_RUNTIME_MESSAGES[key] ?? key;
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null
        ? []
        : [substitutions];
    return values.reduce((text, value, index) => text.replaceAll(`$${index + 1}`, value), template);
  }

  async function emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
    tickEvents: readonly EngineEvent[] = [],
  ): Promise<void> {
    if (settings.notifyRewardEarned) {
      for (const reward of newlyEarnedRewards(previous, next)) {
        await safeNotify(
          await tr("notificationRewardEarned"),
          await tr("notificationRewardFromCampaign", [reward.reward.name, reward.campaign.name]),
        );
      }
      // Challenge claims never enter SchedulerState, so they come from the tick's
      // events instead of a state diff. They ride notifyRewardEarned deliberately:
      // one more toggle for a single event type is not worth the settings surface.
      for (const event of tickEvents) {
        if (event.category !== "activity" || event.code !== "challenge_claimed") continue;
        await safeNotify(
          await tr("notificationChallengeClaimed"),
          await tr("notificationChallengeReward", [event.data.rarity, event.data.recurrence]),
        );
      }
    }

    if (settings.notifyNoDropsLeft) {
      const isDropsExhausted = (state: SchedulerState, platform: Platform): boolean =>
        state.sessions[platform].status === "idle"
        && state.campaigns[platform].length > 0
        && state.campaigns[platform].every((campaign) => !hasEarnableReward(campaign));

      for (const platform of ["twitch", "kick"] as Platform[]) {
        if (
          settings.platform[platform].enabled
          // Only on the transition into the exhausted state, so the
          // notification fires once instead of re-firing every tick (~1/min)
          // for as long as the platform stays out of earnable drops.
          && isDropsExhausted(next, platform)
          && !isDropsExhausted(previous, platform)
        ) {
          await safeNotify(
            await tr("notificationNoDropsLeft"),
            await tr("notificationNoDropsLeftMessage", platformLabel(platform)),
          );
        }
      }
    }
  }

  return {
    ensureAlarm,
    ensureInstalledAt,
    handleStartup,
    handleTabRemoved,
    handleMessage,
    resumeAfterManualClose,
    captureTwitchIntegrity,
    runTwitchIntegrityRefresh,
    checkAuthHealth,
    invalidateAuthHealth,
    tick,
    tickAndHandOff,
    runWatchHeartbeat,
    runClaimHandoff,
    abortClaimHandoffs,
    shutdown,
    prepareForHostReset,
    settleBackgroundWork,
  };
}

function farmingLifecycleEvents(previous: SchedulerState, next: SchedulerState): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    const before = farmingTarget(previous, platform);
    const after = farmingTarget(next, platform);
    const sameTarget = Boolean(
      before
      && after
      && before.campaign.id === after.campaign.id
      && before.reward.id === after.reward.id,
    );
    if (sameTarget) continue;

    if (before) {
      const updatedReward = next.campaigns[platform]
        .find((campaign) => campaign.id === before.campaign.id)
        ?.rewards.find((reward) => reward.id === before.reward.id);
      const reason = updatedReward?.status === "claimed" || updatedReward?.status === "claimable"
        ? "watch_requirement_completed"
        : farmingStopReason(next.sessions[platform]);
      events.push({
        category: "activity",
        platform,
        level: next.sessions[platform].status === "error" ? "error" : "info",
        code: "farming_stopped",
        data: {
          campaignId: before.campaign.id,
          campaignName: before.campaign.name,
          rewardId: before.reward.id,
          rewardName: before.reward.name,
          reason,
        },
      });
    }
    if (after) {
      events.push({
        category: "activity",
        platform,
        level: "info",
        code: "farming_started",
        data: {
          campaignId: after.campaign.id,
          campaignName: after.campaign.name,
          rewardId: after.reward.id,
          rewardName: after.reward.name,
          ...(after.session.channel ? { channel: after.session.channel.displayName ?? after.session.channel.username } : {}),
        },
      });
    } else if (!before) {
      const session = next.sessions[platform];
      const prior = previous.sessions[platform];
      const changed = session.status !== prior.status || session.message !== prior.message;
      const actionable = session.status === "error" || session.reasonCode === "manual_watch";
      if (changed && actionable) {
        const reason = farmingStopReason(session);
        events.push({
          category: "activity",
          platform,
          level: session.status === "error" ? "error" : "warn",
          code: "interruption",
          data: { reason, ...(session.message ? { detail: session.message } : {}) },
        });
      }
    }
  }
  return events;
}

function farmingTarget(state: SchedulerState, platform: Platform): {
  session: WatchSession;
  campaign: DropCampaign;
  reward: DropReward;
} | undefined {
  const session = state.sessions[platform];
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = state.campaigns[platform].find((candidate) => candidate.id === session.campaignId);
  const reward = campaign?.rewards.find((candidate) => candidate.id === session.rewardId);
  return campaign && reward ? { session, campaign, reward } : undefined;
}

function farmingStopReason(session: WatchSession): FarmingStopReason {
  const code = session.reasonCode;
  return code && isFarmingStopReason(code)
    ? code
    : session.status === "error" ? "platform_error" : "target_changed";
}

function isFarmingStopReason(code: WatchReasonCode): code is FarmingStopReason {
  return Object.prototype.hasOwnProperty.call(FARMING_STOP_REASON_CODES, code);
}

function staleStartupCleanup(state: SchedulerState, preservePageContexts = false): {
  hasStaleSession: boolean;
  managedTabs: ManagedWatchTab[];
  state: SchedulerState;
} {
  let hasStaleSession = false;
  const managedTabs = new Map<number, ManagedWatchTab>();
  const sessions = { ...state.sessions };

  for (const platform of ["twitch", "kick"] as Platform[]) {
    const session = state.sessions[platform];
    const managedTab = state.managedWatchTabs?.[platform];
    const managedPageContextTab = state.managedPageContextTabs?.[platform];
    if (managedTab?.ownedByExtension) managedTabs.set(managedTab.tabId, managedTab);

    if (session.status === "watching" || session.tabId != null || managedTab || (!preservePageContexts && managedPageContextTab)) {
      hasStaleSession = true;
      sessions[platform] = pausedStartupSession(session);
    }
  }

  return {
    hasStaleSession,
    managedTabs: [...managedTabs.values()],
    state: {
      ...state,
      sessions,
      managedWatchTabs: {},
      managedPageContextTabs: preservePageContexts ? state.managedPageContextTabs : {},
    },
  };
}

function pausedStartupSession(session: WatchSession): WatchSession {
  return {
    ...session,
    status: "paused",
    channel: undefined,
    campaignId: undefined,
    rewardId: undefined,
    tabId: undefined,
    tabManagedByExtension: undefined,
    playback: undefined,
    playbackChecks: 0,
    errorChecks: 0,
    retryAfter: undefined,
    message: "Browser restarted; farming paused",
    reasonCode: "runtime_restart",
  };
}

function hasEnabledPlatform(settings: EngineSettings): boolean {
  return (["twitch", "kick"] as Platform[]).some((platform) => settings.platform[platform].enabled);
}

function newlyEarnedRewards(
  previous: SchedulerState,
  next: SchedulerState,
): Array<{ campaign: DropCampaign; reward: DropReward }> {
  const previousStatuses = new Map<string, DropReward["status"]>();
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of previous.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        previousStatuses.set(`${platform}:${campaign.id}:${reward.id}`, reward.status);
      }
    }
  }

  const earned: Array<{ campaign: DropCampaign; reward: DropReward }> = [];
  for (const platform of ["twitch", "kick"] as Platform[]) {
    for (const campaign of next.campaigns[platform]) {
      for (const reward of campaign.rewards) {
        const before = previousStatuses.get(`${platform}:${campaign.id}:${reward.id}`);
        if ((reward.status === "claimable" || reward.status === "claimed") && before !== reward.status) {
          earned.push({ campaign, reward });
        }
      }
    }
  }
  return earned;
}

function hasEarnableReward(campaign: DropCampaign): boolean {
  return campaign.status === "active"
    && !hasCampaignEnded(campaign)
    && campaign.accountLinked !== false
    && (!campaign.eligibility || campaign.eligibility === "eligible")
    && campaign.rewards.some((reward) => isWatchReward(reward) && reward.status !== "claimed" && reward.status !== "claimable" && reward.preconditionsMet !== false);
}

function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

function platformLabel(platform: Platform): string {
  return platform === "twitch" ? "Twitch" : "Kick";
}
