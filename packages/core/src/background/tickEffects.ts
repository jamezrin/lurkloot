import type { Platform, SchedulerState, SupplementalWatchTarget, WatchSourceId } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { EffectExecutor, driveEffects } from "../core/effectExecutor";
import { claimReadyRewards, type RewardClaimGuard } from "../core/rewardClaims";
import {
  decidePlatformTick,
  startSchedulerTick,
  type PlatformTickCapabilities,
  type SchedulerEffects,
  type SchedulerTickInput,
  type SchedulerTickResult,
  type StopPageContextTabs,
} from "../core/scheduler";
import {
  currentManagedPageContextTabs,
  currentManagedPageContextTabsRevision,
  forgetManagedPageContextTabs,
  hydrateManagedPageContextTabs,
  syncManagedTabBreakers,
  type TabRegistry,
} from "../core/tabRegistry";
import type { PlatformAdapter } from "../platforms/adapter";
import type { WatchTabPort } from "./hostPorts";
import { PLATFORMS } from "./constants";
import { claimExclusively } from "./context";

// What an effect handler may use to perform a scheduler effect. It is built per
// tick: the adapters are the tick's own.
export interface TickEffectContext {
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  // The controller's tab registry (#598).
  tabRegistry: TabRegistry;
  // Absent when the host has no browser tabs: every watch is then tabless.
  watchTabs?: WatchTabPort;
  stopPageContextTabs?: StopPageContextTabs;
  selectSupplementalTarget?(platform: Platform, state: SchedulerState, signal: AbortSignal | undefined, source: WatchSourceId): Promise<SupplementalWatchTarget | undefined>;
  emit: EventEmitter;
  signal?: AbortSignal;
  // Shared with the jobs that make the same claims, which no longer queue
  // behind the tick now that it holds no lock while claiming.
  claimGuards?: {
    rewards: Partial<Record<Platform, RewardClaimGuard>>;
    challenges: { kickChallengeClaimRunning: boolean };
  };
}

export type TickEffectExecutor = EffectExecutor<SchedulerEffects, TickEffectContext>;

function adapterFor(context: TickEffectContext, platform: Platform): PlatformAdapter {
  const adapter = context.adapters[platform];
  if (!adapter) throw new Error(`No ${platform} adapter for the scheduler effect`);
  return adapter;
}

// The interim handlers (#599): each is the call the scheduler tick used to make
// itself, except that watch tabs now go to the host's WatchTabPort (#598). The owning services take these over one effect type at a
// time: reward claims (#597), Kick challenges and page contexts (#588), watch
// tabs (#598/#587) and supplemental selection (#587). Each owner registers its
// own handler in place of the interim one. Channel points already has (#590):
// see registerChannelPointsClaimEffect in channelPoints.ts.
export function registerInterimTickEffectHandlers(executor: TickEffectExecutor): TickEffectExecutor {
  return executor
    // Without a watch-tab port there is no tab to stop, but the scheduler still
    // asks, to clean up idle and disabled platforms.
    .register("stopWatchTab", async ({ session }, context) => {
      await context.watchTabs?.stop(session, { signal: context.signal }, context.emit);
    })
    .register("releasePageContexts", async ({ platform, contexts, reason, forgetOnFailure }, context) => {
      const forget: StopPageContextTabs = (forgotten, forgetOptions) =>
        forgetManagedPageContextTabs(context.tabRegistry, forgotten, forgetOptions);
      const stopPageContextTabs = context.stopPageContextTabs ?? forget;
      const options = { platforms: [platform], reason, emit: context.emit };
      if (!forgetOnFailure) return await stopPageContextTabs(contexts, options);
      try {
        return await stopPageContextTabs(contexts, options);
      } catch (error) {
        context.emit({
          category: "diagnostic",
          platform,
          level: "warn",
          message: error instanceof Error ? error.message : "Could not stop page context",
        });
        return forget(contexts, options);
      }
    })
    .register("claimChallenges", async ({ platform }, context) => {
      const adapter = adapterFor(context, platform);
      const claim = async () => await adapter.claimChallenges?.({ signal: context.signal }) ?? [];
      const guards = context.claimGuards;
      return guards ? await claimExclusively(guards.challenges, "kickChallengeClaimRunning", [], claim) : await claim();
    })
    .register("claimRewards", async ({ platform, campaigns, waitingRewardIds }, context) => {
      const adapter = adapterFor(context, platform);
      return await claimReadyRewards(adapter, campaigns, waitingRewardIds, context.signal, context.claimGuards?.rewards[platform]);
    })
    .register("selectSupplementalTarget", async ({ platform, state, source }, context) =>
      await context.selectSupplementalTarget?.(platform, state, context.signal, source))
    .register("openWatchTab", async ({ channel, session, managedTab }, context) => {
      if (!context.watchTabs) {
        throw new Error("Watch tabs need the browserTabs capability, which this host does not declare");
      }
      return await context.watchTabs.open(channel, session, {
        ...(managedTab ? { managedTab } : {}),
        signal: context.signal,
      }, context.emit);
    });
}

export function createTickEffectExecutor(): TickEffectExecutor {
  return registerInterimTickEffectHandlers(new EffectExecutor<SchedulerEffects, TickEffectContext>());
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
