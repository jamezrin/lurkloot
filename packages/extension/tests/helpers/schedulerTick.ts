import type { EngineSettings, Platform, SchedulerState, SupplementalWatchTarget, WatchSession, WatchSourceId } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type {
  SchedulerTickDiscovery,
  SchedulerTickResult,
  SnapshotSelectionResult,
  StopPageContextTabs,
} from "@lurkloot/core/scheduler";
import { MANUAL_WATCH_TTL_MS } from "@lurkloot/core/scheduler";
import { createTickEffectExecutor, runSchedulerTickEffects, tickCapabilities } from "@lurkloot/core/background/tickEffects";
import { authHealthFromError } from "@lurkloot/core/fetchError";
import { isTimestampStale } from "@lurkloot/core/timestamps";

// The scheduler tick never discovers campaigns and never calls an adapter
// (#599): the controller hands it a committed discovery snapshot and runs its
// effects through the effect executor. Most scheduler tests predate that and
// drive a tick straight from mock adapters, so this harness keeps their call
// shape. It discovers the way the controller's discovery lane does, lets the
// mock adapter answer channel checks, and runs the effects through the same
// interim handlers the controller registers.
export interface SchedulerTickTestOptions {
  selectSupplementalWatchTarget?(platform: Platform, state: SchedulerState, signal?: AbortSignal, source?: WatchSourceId): Promise<SupplementalWatchTarget | undefined>;
  platforms?: Platform[];
  stopPageContextTabs?: StopPageContextTabs;
  waitingClaimRewardIds?: Partial<Record<Platform, Set<string>>>;
  emit?: EventEmitter;
  signal?: AbortSignal;
  campaignEvaluationFingerprints?: Partial<Record<Platform, string>>;
  discovery?: Partial<Record<Platform, SchedulerTickDiscovery>>;
  selections?: Partial<Record<Platform, SnapshotSelectionResult>>;
  selectionIsCurrent?: Partial<Record<Platform, () => boolean>>;
}

// Platforms the tick will farm, so discovery is only asked where the tick would
// have used it: a paused, disabled, signed-out or backing-off platform never is.
function farms(state: SchedulerState, settings: EngineSettings, platform: Platform): boolean {
  const manualWatch = state.manualWatch?.[platform];
  const recentManualWatch = manualWatch?.active === true
    && !isTimestampStale(manualWatch.checkedAt, MANUAL_WATCH_TTL_MS, Date.now());
  return !state.manualClosePause?.[platform]
    && !(settings.pauseOnManualWatch && recentManualWatch)
    && settings.platform[platform].enabled
    && state.authHealth[platform].status === "healthy"
    && !inBackoff(state.sessions[platform]);
}

function inBackoff(session: WatchSession): boolean {
  if (session.status !== "error" || !session.retryAfter) return false;
  const retryAt = Date.parse(session.retryAfter);
  return !Number.isNaN(retryAt) && Date.now() < retryAt;
}

export async function runSchedulerTick(
  state: SchedulerState,
  settings: EngineSettings,
  adapters: Record<Platform, PlatformAdapter>,
  options: SchedulerTickTestOptions = {},
): Promise<SchedulerTickResult> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  const discovery: Partial<Record<Platform, SchedulerTickDiscovery>> = { ...options.discovery };
  for (const platform of platforms) {
    if (discovery[platform]) continue;
    if (!farms(state, settings, platform)) {
      discovery[platform] = { campaigns: state.campaigns[platform], complete: false };
      continue;
    }
    try {
      discovery[platform] = { campaigns: await adapters[platform].refreshCampaigns(state.sessions[platform], { signal: options.signal }), complete: true };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (authHealthFromError(error)) throw error;
      discovery[platform] = { campaigns: state.campaigns[platform], complete: false };
    }
  }
  return await runSchedulerTickEffects({
    state,
    settings,
    platforms,
    discovery,
    selectionViews: adapters,
    capabilities: Object.fromEntries(platforms.map((platform) => [platform, tickCapabilities(adapters[platform])])),
    supplementalSources: options.selectSupplementalWatchTarget !== undefined,
    waitingClaimRewardIds: options.waitingClaimRewardIds,
    emit: options.emit,
    signal: options.signal,
    campaignEvaluationFingerprints: options.campaignEvaluationFingerprints,
    selections: options.selections,
    selectionIsCurrent: options.selectionIsCurrent,
  }, createTickEffectExecutor(), {
    adapters,
    stopPageContextTabs: options.stopPageContextTabs,
    selectSupplementalTarget: options.selectSupplementalWatchTarget,
  });
}
