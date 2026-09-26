import type { EngineSettings, Platform, PlatformAuthHealth } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { INTEGRITY_REFRESH_TIMEOUT_MS } from "../core/tabs";
import type { PlatformAdapter } from "../platforms/adapter";
import { applyPlatformAuthHealth } from "../core/authHealth";
import { type ControllerSlices, lateBound } from "./context";
import { AuthProbeSetupError } from "./errors";
import { correlateTickDiagnostics, platformLabel } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls, TickAdapterHandle, TickDiagnosticContext } from "./types";

// Must stay strictly greater than INTEGRITY_REFRESH_TIMEOUT_MS. A Twitch probe
// runs through gqlWithIntegrityRetry, so a rejection makes it wait on a page
// context minting a token; when this deadline was the shorter of the two (10s
// against a 12s wait) the probe could never observe that wait succeed. It
// aborted first, every time, and — because the wait takes no AbortSignal (#293)
// — left the wait and its tab running unowned behind it.
const DEFAULT_AUTH_PROBE_TIMEOUT_MS = INTEGRITY_REFRESH_TIMEOUT_MS + 5_000;

// Auth health probes, refreshes and invalidation.
export function createAuthHealth<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { authSlice, discoverySlice }: Pick<ControllerSlices<S>, "authSlice" | "discoverySlice">,
  calls: Pick<ControllerCalls<S>,
    | "createAdapter"
    | "diagnosticEvent"
    | "invalidateSelection"
    | "commitState"
    | "persistAndReport"
    | "reportBestEffort"
    | "reserveDiscoverySignalAuthRefresh"
    | "saveOperationalState"
    | "stopDiscoverySignalController"
    | "stopTwitchChannelPointsPush"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "flattenedRefreshFailures"
  | "refreshAuthHealth"
  | "reportAuthSetupFailures"
  | "checkAuthHealth"
  | "invalidateAuthHealth"
> {
  const {
    createAdapter,
    diagnosticEvent,
    invalidateSelection,
    commitState,
    persistAndReport,
    reportBestEffort,
    reserveDiscoverySignalAuthRefresh,
    saveOperationalState,
    stopDiscoverySignalController,
    stopTwitchChannelPointsPush,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);

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
    tickContext?: TickDiagnosticContext,
  ): Promise<boolean> {
    return withStateLock(() => withEventCollector(async (emit, events) => {
      if (authSlice.authRefreshGeneration[platform] !== generation) return false;
      events.push(...probeEvents);
      await commitState([platform], undefined, (state) => {
        const transition = applyPlatformAuthHealth(state, platform, health);
        if (transition.event) emit(transition.event);
        return transition.state;
      }, { writeEquivalent: true });
      if (health.status !== "healthy") {
        await stopDiscoverySignalController(platform, emit);
        if (platform === "twitch") await stopTwitchChannelPointsPush(emit);
      }
      await reportBestEffort(tickContext
        ? correlateTickDiagnostics(events, tickContext)
        : events);
      return true;
    }), [platform]);
  }

  async function beginAuthRefresh(platforms: readonly Platform[]): Promise<Partial<Record<Platform, number>>> {
    return withStateLock(async () => {
      const generations: Partial<Record<Platform, number>> = {};
      for (const platform of platforms) {
        authSlice.authRefreshGeneration[platform] += 1;
        generations[platform] = authSlice.authRefreshGeneration[platform];
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
    tickContext?: TickDiagnosticContext,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle<S>>>,
  ): Promise<void> {
    signal?.throwIfAborted();
    const lockStartedAt = Date.now();
    const generations = await beginAuthRefresh(platforms);
    const lockWaitMs = Date.now() - lockStartedAt;
    if (tickContext && lockWaitMs >= 50) {
      for (const platform of platforms) {
        diagnosticEvent(
          "debug",
          `Tick #${tickContext.platformTickId} waited ${lockWaitMs}ms for ${platformLabel(platform)} platform work`,
          platform,
          tickContext,
          { waitMs: lockWaitMs },
        );
      }
    }
    const settings = loadedSettings ?? await deps.loadSettings();
    const enabled = platforms.filter((platform) => settings.platform[platform].enabled);
    const results = await Promise.allSettled(enabled.map(async (platform) => {
      const result = await withEventCollector(async (emit, events) => {
        let setupFailure: AuthProbeSetupError | undefined;
        let health: PlatformAuthHealth;
        let adapter: PlatformAdapter | undefined;
        try {
          adapter = tickAdapters?.[platform]?.adapter(settings, emit, reportCompatibility)
            ?? createAdapter(platform, settings, emit, reportCompatibility);
        } catch (error) {
          setupFailure = new AuthProbeSetupError(
            platform,
            error instanceof Error ? error.message : "Adapter factory failed",
          );
        }
        try {
          health = adapter
            ? await probeAuthHealth(platform, adapter, signal)
            : unavailableAfterAdapterSetup();
        } finally {
          tickAdapters?.[platform]?.drain(emit);
          if (!tickAdapters?.[platform]) adapter?.flushRouteDiagnostics?.(emit);
        }
        return { health, events, setupFailure };
      });
      const generation = generations[platform];
      if (generation === undefined) return;
      signal?.throwIfAborted();
      let accepted: boolean;
      try {
        accepted = await persistAuthHealth(
          platform,
          result.health,
          result.events,
          generation,
          tickContext,
        );
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

  async function reportAuthSetupFailures(
    failures: readonly AuthProbeSetupError[],
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
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
        await stopDiscoverySignalController(failure.platform, emit);
        if (failure.platform === "twitch") await stopTwitchChannelPointsPush(emit);
      }
      await persistAndReport(
        state,
        tickContext ? correlateTickDiagnostics(events, tickContext) : events,
      );
    }));
  }

  async function checkAuthHealth(platform: Platform): Promise<void> {
    const releaseDiscoverySignalAuthRefresh = reserveDiscoverySignalAuthRefresh(platform);
    try {
      await refreshAuthHealth([platform]);
    } finally {
      releaseDiscoverySignalAuthRefresh();
    }
  }

  async function invalidateAuthHealth(platform: Platform): Promise<void> {
    discoverySlice.discoveryLanes[platform].invalidate();
    invalidateSelection(platform);
    const releaseDiscoverySignalAuthRefresh = reserveDiscoverySignalAuthRefresh(platform);
    try {
      const generations = await beginAuthRefresh([platform]);
      const generation = generations[platform];
      const settings = await deps.loadSettings();
      if (!settings.platform[platform].enabled) return;
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (generation === undefined || authSlice.authRefreshGeneration[platform] !== generation) return;
        const state = await deps.loadState();
        const transition = applyPlatformAuthHealth(state, platform, { status: "checking" });
        if (transition.event) emit(transition.event);
        await saveOperationalState(transition.state);
        await stopDiscoverySignalController(platform, emit);
        if (platform === "twitch") await stopTwitchChannelPointsPush(emit);
        await reportBestEffort(events);
      }));
    } finally {
      releaseDiscoverySignalAuthRefresh();
    }
  }

  return {
    flattenedRefreshFailures,
    refreshAuthHealth,
    reportAuthSetupFailures,
    checkAuthHealth,
    invalidateAuthHealth,
  };
}
