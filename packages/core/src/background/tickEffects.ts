import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { EffectExecutor, driveEffects } from "../core/effectExecutor";
import {
  decidePlatformTick,
  startSchedulerTick,
  type PlatformTickCapabilities,
  type SchedulerEffects,
  type SchedulerTickInput,
  type SchedulerTickResult,
} from "../core/scheduler";
import { currentManagedPageContextTabs, type TabRegistry } from "../core/tabRegistry";
import type { PlatformAdapter } from "../platforms/adapter";
import { adapterOffers } from "./adapterSettings";
import { PLATFORMS } from "./constants";

// What an effect handler may use to perform a scheduler effect. It is built per
// tick: the adapters and settings are the tick's own. Host ports are not here:
// each owning service binds the ports its handlers use when it registers them.
export interface TickEffectContext {
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  settings: EngineSettings;
  // The controller's tab registry (#598).
  tabRegistry: TabRegistry;
  emit: EventEmitter;
  signal?: AbortSignal;
  // The rewards this tick claimed, still reserved until its commit (#597).
  heldRewardClaims?: Partial<Record<Platform, Set<string>>>;
}

export type TickEffectExecutor = EffectExecutor<SchedulerEffects, TickEffectContext>;

// An empty executor. Every scheduler effect type's handler is registered by the
// service that owns it (#591): watch tabs by manual watch (manualWatch.ts),
// supplemental selection by supplementalSources.ts, channel points by
// channelPoints.ts (#590), challenges and page contexts by the Kick runtime
// (#588) and reward claims by the claim service (#597).
export function createTickEffectExecutor(): TickEffectExecutor {
  return new EffectExecutor<SchedulerEffects, TickEffectContext>();
}

export function tickCapabilities(
  adapter: PlatformAdapter,
  watchTabs: boolean,
  pointsPushAvailable = true,
): PlatformTickCapabilities {
  return {
    supportsTabless: Boolean(adapter.supportsTabless),
    watchTabs,
    claimChallenges: adapterOffers(adapter, "claimChallenges"),
    claimChannelPoints: adapterOffers(adapter, "claimChannelPoints"),
    // A streak payout arrives only over the platform's push connection.
    observeWatchStreaks: pointsPushAvailable && adapterOffers(adapter, "channelPointsPush"),
  };
}

// Runs one scheduler tick: each platform decides in turn, and every effect it
// names goes through `executor`. Read back the page-context ownership after
// each platform's effects. The controller prepares the registry before probing
// and syncs the breaker after a successful commit.
export async function runSchedulerTickEffects(
  input: SchedulerTickInput,
  executor: TickEffectExecutor,
  context: Omit<TickEffectContext, "emit" | "signal">,
): Promise<SchedulerTickResult> {
  const platforms = input.platforms ?? PLATFORMS;
  const tick = startSchedulerTick(input);
  const { tabRegistry } = context;
  const effectContext: TickEffectContext = { ...context, emit: tick.emit, signal: input.signal };
  for (const platform of platforms) {
    try {
      await driveEffects(
        decidePlatformTick(tick, platform, input),
        (effect) => executor.run(effect, effectContext),
        input.signal,
      );
    } finally {
      tick.state.managedPageContextTabs = currentManagedPageContextTabs(tabRegistry);
    }
  }
  return { state: tick.state, decisions: tick.decisions, events: tick.events };
}
