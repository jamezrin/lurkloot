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
} from "../core/tabs";
import type { PlatformAdapter } from "../platforms/adapter";
import { PLATFORMS } from "./constants";
import { claimExclusively } from "./context";

// What an effect handler may use to perform a scheduler effect. It is built per
// tick: the adapters are the tick's own.
export interface TickEffectContext {
  adapters: Partial<Record<Platform, PlatformAdapter>>;
  stopPageContextTabs?: StopPageContextTabs;
  selectSupplementalTarget?(platform: Platform, state: SchedulerState, signal: AbortSignal | undefined, source: WatchSourceId): Promise<SupplementalWatchTarget | undefined>;
  emit: EventEmitter;
  signal?: AbortSignal;
  // Shared with the jobs that make the same claims, which no longer queue
  // behind the tick now that it holds no lock while claiming.
  claimGuards?: {
    rewards: Partial<Record<Platform, RewardClaimGuard>>;
    challenges: { kickChallengeClaimRunning: boolean };
    channelPoints: { twitchChannelPointsClaimRunning: boolean };
  };
}

export type TickEffectExecutor = EffectExecutor<SchedulerEffects, TickEffectContext>;

function adapterFor(context: TickEffectContext, platform: Platform): PlatformAdapter {
  const adapter = context.adapters[platform];
  if (!adapter) throw new Error(`No ${platform} adapter for the scheduler effect`);
  return adapter;
}

// The interim handlers (#599): each is the call the scheduler tick used to make
// itself, unchanged. The owning services take these over one effect type at a
// time: reward claims (#597), channel points (#590), Kick challenges and page
// contexts (#588), watch tabs (#598/#587) and supplemental selection (#587).
// Each owner registers its own handler in place of the interim one.
export function registerInterimTickEffectHandlers(executor: TickEffectExecutor): TickEffectExecutor {
  return executor
    .register("stopWatchTab", async ({ platform, session }, context) => {
      const adapter = adapterFor(context, platform);
      await adapter.stopWatchTab?.(session, { signal: context.signal });
    })
    .register("releasePageContexts", async ({ platform, contexts, reason, forgetOnFailure }, context) => {
      const stopPageContextTabs = context.stopPageContextTabs ?? forgetManagedPageContextTabs;
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
        return forgetManagedPageContextTabs(contexts, options);
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
    .register("openWatchTab", async ({ platform, channel, session, managedTab }, context) => {
      const adapter = adapterFor(context, platform);
      return await adapter.prepareWatchTab(channel, session, {
        ...(managedTab ? { managedTab } : {}),
        signal: context.signal,
      });
    })
    .register("claimChannelPoints", async ({ platform, channel }, context) => {
      const adapter = adapterFor(context, platform);
      const claim = async () => await adapter.claimChannelPoints?.(channel, { signal: context.signal }) ?? false;
      const guards = context.claimGuards;
      return guards ? await claimExclusively(guards.channelPoints, "twitchChannelPointsClaimRunning", false, claim) : await claim();
    });
}

export function createTickEffectExecutor(): TickEffectExecutor {
  return registerInterimTickEffectHandlers(new EffectExecutor<SchedulerEffects, TickEffectContext>());
}

export function tickCapabilities(adapter: PlatformAdapter): PlatformTickCapabilities {
  return {
    supportsTabless: Boolean(adapter.supportsTabless),
    claimChallenges: typeof adapter.claimChallenges === "function",
    claimChannelPoints: typeof adapter.claimChannelPoints === "function",
  };
}

// Runs one scheduler tick: each platform decides in turn, and every effect it
// names goes through `executor`. The page-context registry and the managed-tab
// breaker live in core/tabs.ts until #598 replaces them with ports, so they are
// mirrored here, never in the deciding code: hydrated and synced before the
// first platform, then synced after each one.
export async function runSchedulerTickEffects(
  input: SchedulerTickInput,
  executor: TickEffectExecutor,
  context: Omit<TickEffectContext, "emit" | "signal">,
): Promise<SchedulerTickResult> {
  const platforms = input.platforms ?? PLATFORMS;
  const tick = startSchedulerTick(input);
  const pageContextRevision = currentManagedPageContextTabsRevision();
  hydrateManagedPageContextTabs(input.state.managedPageContextTabs ?? {}, platforms, pageContextRevision);
  // When the kill switch is off the breaker registry is cleared instead of
  // mirrored. Otherwise a breaker latched before the switch was flipped would
  // keep blocking page-context creation forever: observations no longer run to
  // release it, and the popup no longer renders the panel that would dismiss it.
  syncManagedTabBreakers(input.settings.criticalFailurePromptEnabled ? tick.state : {}, platforms);
  const effectContext: TickEffectContext = { ...context, emit: tick.emit, signal: input.signal };
  for (const platform of platforms) {
    try {
      await driveEffects(decidePlatformTick(tick, platform, input), (effect) => executor.run(effect, effectContext));
    } finally {
      // An observation can release the breaker, and a provider call can open
      // or close a page context, so both are read back after every platform.
      if (input.settings.criticalFailurePromptEnabled) syncManagedTabBreakers(tick.state, [platform]);
      tick.state.managedPageContextTabs = currentManagedPageContextTabs();
    }
  }
  return { state: tick.state, decisions: tick.decisions, events: tick.events };
}
