import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import {
  recordManagedTabOpen,
  recordRejectedManagedPageContext,
  type CriticalHealthTransition,
} from "../core/criticalHealth";
import {
  currentManagedPageContextTabsRevision,
  hydrateManagedPageContextTabs,
  syncManagedTabBreakers,
  type TabRegistry,
} from "../core/tabRegistry";
import type { LifecycleSlice } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type { StateTransaction } from "./stateTransaction";
import type { ControllerCalls, TickDiagnosticContext } from "./types";
import { correlateTickDiagnostics } from "./helpers";

// The browser owns tab creation and cleanup. The controller persists those facts
// independently of the operation that requested the tab, including an aborted
// probe or a scheduler decision that gets superseded.
export function bindManagedPageContexts<S extends EngineSettings>(
  registry: TabRegistry,
  stateStorage: BackgroundHostPorts<S>["storage"],
  transaction: StateTransaction<S>,
  lifecycle: LifecycleSlice,
  calls: Pick<ControllerCalls<S>, "withEventCollector" | "reportBestEffort">,
): void {
  async function persist(
    platform: Platform,
    observe: (state: SchedulerState) => CriticalHealthTransition,
    captureOwnership: boolean,
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
    await calls.withEventCollector(async (emit, events) => {
      await transaction.withPlatformLock(platform, async () => {
        if (!lifecycle.observersOpen) return;
        const settings = await stateStorage.loadSettings();
        await transaction.commit(
          [platform],
          () => lifecycle.observersOpen,
          (state) => {
            const transition = settings.criticalFailurePromptEnabled ? observe(state) : { state };
            if (transition.event) emit(transition.event);
            if (!captureOwnership) return transition.state;
            const managedPageContextTabs = { ...state.managedPageContextTabs };
            const owned = registry.retainedPageContextTabs.get(platform);
            if (owned) managedPageContextTabs[platform] = owned;
            else delete managedPageContextTabs[platform];
            return { ...transition.state, managedPageContextTabs };
          },
          {
            afterSave: (state) =>
              syncManagedTabBreakers(registry, settings.criticalFailurePromptEnabled ? state : {}, [
                platform,
              ]),
          },
        );
      });
      await calls.reportBestEffort(
        tickContext ? correlateTickDiagnostics(events, tickContext) : events,
      );
    });
  }

  // Bootstrap each platform once. Subsequent fetches use the live registry;
  // tick and accounting commits already synchronize its breaker.
  const prepared = new Map<Platform, boolean>();
  const needsPreparation = (platform: Platform, enabled?: boolean): boolean =>
    !prepared.has(platform) || (enabled !== undefined && prepared.get(platform) !== enabled);
  registry.managedPageContexts = {
    prepare: async (platform, enabled) => {
      if (!needsPreparation(platform, enabled)) return;
      await transaction.withPlatformLock(platform, async () => {
        if (!needsPreparation(platform, enabled)) return;
        const promptEnabled =
          enabled ?? (await stateStorage.loadSettings()).criticalFailurePromptEnabled;
        let state: SchedulerState;
        do {
          const revision = currentManagedPageContextTabsRevision(registry);
          state = await transaction.readState();
          if (
            prepared.has(platform)
            || hydrateManagedPageContextTabs(
              registry,
              state.managedPageContextTabs ?? {},
              [platform],
              revision,
            )
          )
            break;
        } while (lifecycle.observersOpen);
        syncManagedTabBreakers(registry, promptEnabled ? state : {}, [platform]);
        prepared.set(platform, promptEnabled);
      });
    },
    opened: (platform, at, reason, tickContext) =>
      persist(
        platform,
        (state) =>
          recordManagedTabOpen(state, platform, at, {
            source: "page_context",
            reason,
          }),
        true,
        tickContext,
      ),
    rejected: (platform, at) =>
      persist(platform, (state) => recordRejectedManagedPageContext(state, platform, at), false),
  };
}
