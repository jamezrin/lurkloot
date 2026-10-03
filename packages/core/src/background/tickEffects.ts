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
import {
  currentManagedPageContextTabs,
  currentManagedPageContextTabsRevision,
  hydrateManagedPageContextTabs,
  syncManagedTabBreakers,
  type TabRegistry,
} from "../core/tabRegistry";
import type { PlatformAdapter } from "../platforms/adapter";
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

export function tickCapabilities(adapter: PlatformAdapter, watchTabs: boolean): PlatformTickCapabilities {
  return {
    supportsTabless: Boolean(adapter.supportsTabless),
    watchTabs,
    claimChallenges: typeof adapter.claimChallenges === "function",
    claimChannelPoints: typeof adapter.claimChannelPoints === "function",
  };
}

// Runs one scheduler tick: each platform decides in turn, and every effect it
// names goes through `executor`. The page-context snapshot and the managed-tab
// breaker live in the controller's tab registry, so they are mirrored here,
// never in the deciding code: hydrated and synced before the first platform,
// then synced after each one.
export async function runSchedulerTickEffects(
  input: SchedulerTickInput,
  executor: TickEffectExecutor,
  context: Omit<TickEffectContext, "emit" | "signal">,
): Promise<SchedulerTickResult> {
  const platforms = input.platforms ?? PLATFORMS;
  const tick = startSchedulerTick(input);
  const { tabRegistry } = context;
  const pageContextRevision = currentManagedPageContextTabsRevision(tabRegistry);
  hydrateManagedPageContextTabs(tabRegistry, input.state.managedPageContextTabs ?? {}, platforms, pageContextRevision);
  // When the kill switch is off the breaker registry is cleared instead of
  // mirrored. Otherwise a breaker latched before the switch was flipped would
  // keep blocking page-context creation forever: observations no longer run to
  // release it, and the popup no longer renders the panel that would dismiss it.
  syncManagedTabBreakers(tabRegistry, input.settings.criticalFailurePromptEnabled ? tick.state : {}, platforms);
  const effectContext: TickEffectContext = { ...context, emit: tick.emit, signal: input.signal };
  for (const platform of platforms) {
    try {
      await driveEffects(
        decidePlatformTick(tick, platform, input),
        (effect) => executor.run(effect, effectContext),
        input.signal,
      );
    } finally {
      // An observation can release the breaker, and a provider call can open
      // or close a page context, so both are read back after every platform.
      if (input.settings.criticalFailurePromptEnabled) syncManagedTabBreakers(tabRegistry, tick.state, [platform]);
      tick.state.managedPageContextTabs = currentManagedPageContextTabs(tabRegistry);
    }
  }
  return { state: tick.state, decisions: tick.decisions, events: tick.events };
}
