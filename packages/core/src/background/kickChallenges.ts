import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { autoClaimChallengesFor } from "@lurkloot/shared/settings";
import { challengePollDue } from "../core/scheduler";
import type { PlatformAdapter } from "../platforms/adapter";
import { type ControllerSlices, lateBound } from "./context";
import { correlateTickDiagnostics, hasRecentManualWatchForClaims } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls, TickDiagnosticContext } from "./types";

// Kick challenge claims and page-context recovery.
export function createKickChallenges<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { kickChallengeSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "kickChallengeSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "clearOperationalEvents"
    | "createAdapter"
    | "emitNotifications"
    | "persistPlatformState"
    | "reportBestEffort"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>, "reconcilePageContextRecoveryAfterPersist" | "runKickChallengeClaims"> {
  const {
    clearOperationalEvents,
    createAdapter,
    emitNotifications,
    persistPlatformState,
    reportBestEffort,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);

  async function reconcilePageContextRecoveryAfterPersist(
    platforms: readonly Platform[],
    state: SchedulerState,
    settings: S,
    backgroundSuccessPlatforms: ReadonlySet<Platform>,
    tickContext: TickDiagnosticContext,
  ): Promise<void> {
    if (!deps.reconcilePageContextRecovery) return;
    for (const recoveryPlatform of platforms) {
      await withEventCollector(async (recoveryEmit, recoveryEvents) => {
        try {
          const changed = await deps.reconcilePageContextRecovery!(
            recoveryPlatform,
            settings,
            { countBackgroundSuccess: backgroundSuccessPlatforms.has(recoveryPlatform) },
            recoveryEmit,
          );
          if (changed) await persistPlatformState(recoveryPlatform, state);
        } catch (error) {
          recoveryEmit({
            category: "diagnostic",
            level: "debug",
            platform: recoveryPlatform,
            message: `Page-context recovery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        await reportBestEffort(correlateTickDiagnostics(recoveryEvents, tickContext));
      });
    }
  }

  async function runKickChallengeClaims(): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const operation = new AbortController();
    kickChallengeSlice.kickChallengeClaimOperations.add(operation);
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (lifecycleSlice.controllerShutdown) return;
        let adapter: PlatformAdapter | undefined;
        try {
          operation.signal.throwIfAborted();
          const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
          operation.signal.throwIfAborted();
          if (!settings.platform.kick.enabled
            || !autoClaimChallengesFor(settings, "kick")
            || state.authHealth.kick.status !== "healthy"
            || !hasRecentManualWatchForClaims(settings, state, "kick")
            || !challengePollDue(state, "kick", Date.now())) return;

          const nextState: SchedulerState = {
            ...state,
            gamification: {
              ...state.gamification,
              kick: { lastCheckedAt: new Date().toISOString() },
            },
          };
          adapter = createAdapter("kick", settings, emit, true);
          operation.signal.throwIfAborted();
          try {
            const challenges = await adapter.claimChallenges?.({ signal: operation.signal }) ?? [];
            operation.signal.throwIfAborted();
            for (const challenge of challenges) {
              emit({
                category: "activity",
                code: "challenge_claimed",
                level: "info",
                platform: "kick",
                data: { challengeId: challenge.id, rarity: challenge.rarity, recurrence: challenge.recurrence },
              });
            }
          } catch (error) {
            operation.signal.throwIfAborted();
            emit({
              category: "diagnostic",
              platform: "kick",
              level: "warn",
              message: error instanceof Error ? error.message : "Challenge claim failed",
            });
          }
          operation.signal.throwIfAborted();
          adapter.flushRouteDiagnostics?.(emit);
          await persistPlatformState("kick", nextState, () => !operation.signal.aborted);
          operation.signal.throwIfAborted();
          await emitNotifications(settings, state, nextState, events);
          await reportBestEffort(events);
        } catch (error) {
          adapter?.flushRouteDiagnostics?.(emit);
          clearOperationalEvents(events);
          if (operation.signal.aborted) return;
          emit({
            category: "diagnostic",
            platform: "kick",
            level: "warn",
            message: error instanceof Error ? error.message : "Challenge claim failed",
          });
          await reportBestEffort(events);
        }
      }), ["kick"]);
    } finally {
      kickChallengeSlice.kickChallengeClaimOperations.delete(operation);
    }
  }

  return {
    reconcilePageContextRecoveryAfterPersist,
    runKickChallengeClaims,
  };
}
