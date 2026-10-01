import type { ChannelCandidate, EngineSettings, Platform, PreparedWatchTab, SchedulerState, SupplementalWatchTarget, WatchSession, WatchSourceId, WatchTabOptions } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { WatchTabPort } from "@lurkloot/core/controller";
import type {
  SchedulerTickDiscovery,
  SchedulerTickResult,
  SnapshotSelectionResult,
  StopPageContextTabs,
} from "@lurkloot/core/scheduler";
import { MANUAL_WATCH_TTL_MS } from "@lurkloot/core/scheduler";
import { ChannelPointsClaimGate, registerChannelPointsClaimEffect } from "@lurkloot/core/background/channelPoints";
import { registerRewardClaimEffect } from "@lurkloot/core/background/claimService";
import { KickChallengeClaimGate, registerKickRuntimeEffects } from "@lurkloot/core/background/kickRuntime";
import { createTickEffectExecutor, runSchedulerTickEffects, tickCapabilities } from "@lurkloot/core/background/tickEffects";
import { registerWatchTabEffects } from "@lurkloot/core/background/manualWatch";
import { registerSupplementalTargetEffect } from "@lurkloot/core/background/supplementalSources";
import { authHealthFromError } from "@lurkloot/core/fetchError";
import { isTimestampStale } from "@lurkloot/core/timestamps";
import { createTabRegistry, type TabRegistry } from "@lurkloot/core/tabRegistry";

// The scheduler tick never discovers campaigns and never calls an adapter
// (#599): the controller hands it a committed discovery snapshot and runs its
// effects through the effect executor. Most scheduler tests predate that and
// drive a tick straight from mock adapters, so this harness keeps their call
// shape. It discovers the way the controller's discovery lane does, lets the
// mock adapter answer channel checks, and runs the effects through the same
// interim handlers the controller registers.
// Watch tabs are the host's (#598), not the adapter's, but these tests predate
// that and keep a fake adapter's watch-tab mocks next to its provider mocks. The
// harness turns them into the WatchTabPort the tick calls.
export interface WatchTabMocks {
  prepareWatchTab?(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab>;
  stopWatchTab?(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void>;
}

export type SchedulerTestAdapter = PlatformAdapter & WatchTabMocks;
export type SchedulerMockAdapter = PlatformAdapter & Required<WatchTabMocks>;

function watchTabsFromMocks(adapters: Record<Platform, SchedulerTestAdapter>): WatchTabPort {
  return {
    open: async (channel, session, options) => {
      const prepareWatchTab = adapters[channel.platform].prepareWatchTab;
      if (!prepareWatchTab) throw new Error(`No ${channel.platform} watch-tab mock`);
      return await prepareWatchTab(channel, session, options);
    },
    stop: async (session, options) => {
      await adapters[session.platform].stopWatchTab?.(session, options);
    },
    closeManaged: async () => undefined,
    applyAdFocus: async () => undefined,
    loadPlaybackPolicy: async () => ({ keepVideosUnmuted: true }),
  };
}

export interface SchedulerTickTestOptions {
  selectSupplementalWatchTarget?(platform: Platform, state: SchedulerState, signal?: AbortSignal, source?: WatchSourceId): Promise<SupplementalWatchTarget | undefined>;
  platforms?: Platform[];
  stopPageContextTabs?: StopPageContextTabs;
  // The tab registry the tick mirrors page contexts and breakers into; a fresh
  // one per tick unless the test inspects it.
  tabRegistry?: TabRegistry;
  waitingClaimRewardIds?: Partial<Record<Platform, Set<string>>>;
  emit?: EventEmitter;
  signal?: AbortSignal;
  campaignEvaluationFingerprints?: Partial<Record<Platform, string>>;
  discovery?: Partial<Record<Platform, SchedulerTickDiscovery>>;
  selections?: Partial<Record<Platform, SnapshotSelectionResult>>;
  selectionIsCurrent?: Partial<Record<Platform, () => boolean>>;
  // The host's browserTabs capability. On by default, like the extension; false
  // runs the tick as the CLI does, with no watch-tab port at all.
  browserTabs?: boolean;
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
  adapters: Record<Platform, SchedulerTestAdapter>,
  options: SchedulerTickTestOptions = {},
): Promise<SchedulerTickResult> {
  const platforms = options.platforms ?? ["twitch", "kick"];
  const browserTabs = options.browserTabs ?? true;
  const selectSupplementalWatchTarget = options.selectSupplementalWatchTarget;
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
      discovery[platform] = { campaigns: state.campaigns[platform], complete: false, failure: error };
    }
  }
  return await runSchedulerTickEffects({
    state,
    settings,
    platforms,
    discovery,
    selectionViews: adapters,
    capabilities: Object.fromEntries(platforms.map((platform) => [platform, tickCapabilities(adapters[platform], browserTabs)])),
    supplementalSources: options.selectSupplementalWatchTarget !== undefined,
    waitingClaimRewardIds: options.waitingClaimRewardIds,
    emit: options.emit,
    signal: options.signal,
    campaignEvaluationFingerprints: options.campaignEvaluationFingerprints,
    selections: options.selections,
    selectionIsCurrent: options.selectionIsCurrent,
  }, registerRewardClaimEffect(
    registerKickRuntimeEffects(
      registerChannelPointsClaimEffect(
        registerSupplementalTargetEffect(
          registerWatchTabEffects(createTickEffectExecutor(), browserTabs ? watchTabsFromMocks(adapters) : undefined),
          selectSupplementalWatchTarget
            ? { select: (selectState, _settings, signal, source) => selectSupplementalWatchTarget("twitch", selectState, signal, source) }
            : undefined,
        ),
        new ChannelPointsClaimGate(),
      ),
      new KickChallengeClaimGate(),
      options.stopPageContextTabs,
    ),
    {},
  ), {
    adapters,
    settings,
    tabRegistry: options.tabRegistry ?? createTabRegistry(),
  });
}
