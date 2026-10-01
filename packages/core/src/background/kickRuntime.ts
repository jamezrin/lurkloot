import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { autoClaimChallengesFor } from "@lurkloot/shared/settings";
import { CHALLENGE_POLL_INTERVAL_MS, challengePollDue, type StopPageContextTabs } from "../core/scheduler";
import { forgetManagedPageContextTabs } from "../core/tabRegistry";
import type { ClaimedChallenge, PlatformAdapter } from "../platforms/adapter";
import { KICK_CHALLENGES_ALARM_NAME } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { correlateTickDiagnostics } from "./helpers";
import { pausedForManualWatch } from "../core/manualWatch";
import type { BackgroundHostPorts } from "./hostPorts";
import type { BackgroundJob } from "./jobs";
import type { StateTransaction } from "./stateTransaction";
import type { TickEffectExecutor } from "./tickEffects";
import type { ControllerCalls, TickCycleOutcome, TickDiagnosticContext } from "./types";

// One Kick challenge claim request at a time, whether the tick or the job asks
// for it. The tick no longer holds a lock while it claims (#599), so the two
// can overlap; the one that finds a request running skips its own.
export class KickChallengeClaimGate {
  private running = false;

  // Resolves undefined, without calling `claim`, while another claim runs.
  async unlessRunning(claim: () => Promise<ClaimedChallenge[]>): Promise<ClaimedChallenge[] | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      return await claim();
    } finally {
      this.running = false;
    }
  }
}

// The two scheduler effects the Kick runtime owns (#588): the challenge claim,
// which shares `gate` with the job, and page-context release. Release is asked
// for any platform the tick stops farming. Without a page-context port (the
// CLI) there is no tab to close, so the contexts are only forgotten.
export function registerKickRuntimeEffects(
  executor: TickEffectExecutor,
  gate: KickChallengeClaimGate,
  releasePageContexts?: StopPageContextTabs,
): TickEffectExecutor {
  return executor
    .register("releasePageContexts", async ({ platform, contexts, reason, forgetOnFailure }, context) => {
      const forget: StopPageContextTabs = (forgotten, forgetOptions) =>
        forgetManagedPageContextTabs(context.tabRegistry, forgotten, forgetOptions);
      const release = releasePageContexts ?? forget;
      const options = { platforms: [platform], reason, emit: context.emit };
      if (!forgetOnFailure) return await release(contexts, options);
      try {
        return await release(contexts, options);
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
      const adapter = context.adapters[platform];
      if (!adapter) throw new Error(`No ${platform} adapter for the scheduler effect`);
      return await gate.unlessRunning(async () =>
        await adapter.claimChallenges?.({ signal: context.signal }) ?? []) ?? [];
    });
}

// The ten-minute challenge job. It claims for a manually watched tab, which
// needs browser tabs; elsewhere the tick claims at its own cadence.
export const KICK_RUNTIME_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [KICK_CHALLENGES_ALARM_NAME]: { run: (runner) => runner.runKickChallengeClaims(), requires: "browserTabs" },
};

// The later of two poll stamps, so a job never replaces the tick's newer one.
function newerCheck(
  left: { lastCheckedAt: string },
  right: { lastCheckedAt: string } | undefined,
): { lastCheckedAt: string } {
  if (!right) return left;
  return Date.parse(right.lastCheckedAt) > Date.parse(left.lastCheckedAt) ? right : left;
}

// The Kick runtime (#588): challenge-claim cadence and cancellation, the claim
// and page-context release effects, and page-context recovery after each tick
// cycle. Browser tab mechanics stay in the host's PageContextPort; the recovery
// rule stays in the tab registry.
export function createKickRuntime<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit">,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "clearOperationalEvents"
    | "createAdapter"
    | "emitNotifications"
    | "persistPlatformState"
    | "reportBestEffort"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "abortKickChallengeClaims"
  | "clearKickChallengeJobBestEffort"
  | "endTickCycle"
  | "observeTickCycle"
  | "reconcileKickChallengeJob"
  | "registerKickRuntimeEffects"
  | "rescheduleKickChallengeJob"
  | "runKickChallengeClaims"
> {
  const {
    clearOperationalEvents,
    createAdapter,
    emitNotifications,
    persistPlatformState,
    reportBestEffort,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);
  const claims = new KickChallengeClaimGate();
  // The job's claim requests in flight. Disabling challenge claims, reset and
  // shutdown abort them; the tick's claim follows the tick's own signal.
  const claimOperations = new Set<AbortController>();
  let jobReschedule: Promise<void> = Promise.resolve();

  function challengeClaimsEnabled(settings: EngineSettings): boolean {
    return settings.platform.kick.enabled && autoClaimChallengesFor(settings, "kick");
  }

  function abortKickChallengeClaims(reason: string): void {
    for (const operation of claimOperations) operation.abort(new Error(reason));
  }

  function abortIneligibleKickChallengeClaims(settings: EngineSettings, reason: string): void {
    if (!challengeClaimsEnabled(settings)) abortKickChallengeClaims(reason);
  }

  // A settings save that disables Kick or challenge claiming cancels a claim
  // still in flight, once it is saved.
  transaction.onCommit((change) => {
    if (change.kind !== "settings" || change.startup) return;
    abortIneligibleKickChallengeClaims(change.settings, "Claim automation disabled");
  });

  async function reconcileKickChallengeJob(settings: EngineSettings): Promise<void> {
    if (challengeClaimsEnabled(settings)) {
      await ports.jobs.ensure(KICK_CHALLENGES_ALARM_NAME, { periodInMinutes: CHALLENGE_POLL_INTERVAL_MS / 60_000 });
    } else {
      await ports.jobs.cancel(KICK_CHALLENGES_ALARM_NAME);
    }
  }

  // After a settings commit, with the settings lock released. Runs are
  // serialized and each reads the latest stored settings, so commits that
  // finish out of order still leave the job matching the last one.
  function rescheduleKickChallengeJob(): Promise<void> {
    const run = jobReschedule.then(async () => {
      if (lifecycleSlice.controllerShutdown) return;
      await reconcileKickChallengeJob(await ports.storage.loadSettings());
    });
    jobReschedule = run.catch(() => undefined);
    return run;
  }

  async function clearKickChallengeJobBestEffort(): Promise<void> {
    try {
      await ports.jobs.cancel(KICK_CHALLENGES_ALARM_NAME);
    } catch {
      await reportBestEffort([{
        category: "diagnostic",
        level: "warn",
        message: `Could not clear the ${KICK_CHALLENGES_ALARM_NAME} alarm`,
      }]);
    }
  }

  function registerEffects(executor: TickEffectExecutor): TickEffectExecutor {
    return registerKickRuntimeEffects(executor, claims, ports.tabs?.pageContexts.release);
  }

  // The job claims while the user watches Kick by hand, which pauses the tick.
  // The claim runs with no lock held; only the poll stamp is committed, onto
  // the latest state, so a tick that committed meanwhile keeps its changes.
  async function runKickChallengeClaims(): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const operation = new AbortController();
    claimOperations.add(operation);
    try {
      await withEventCollector(async (emit, events) => {
        let adapter: PlatformAdapter | undefined;
        try {
          const [settings, state] = await Promise.all([ports.storage.loadSettings(), ports.storage.loadState()]);
          operation.signal.throwIfAborted();
          if (lifecycleSlice.controllerShutdown
            || !challengeClaimsEnabled(settings)
            || state.authHealth.kick.status !== "healthy"
            || !pausedForManualWatch(settings, state, "kick")
            || !challengePollDue(state, "kick", Date.now())) return;

          // Stamped on attempt, not on success, like the tick's own poll.
          const checked = { lastCheckedAt: new Date().toISOString() };
          const kickAdapter = adapter = createAdapter("kick", settings, emit, true);
          operation.signal.throwIfAborted();
          try {
            const challenges = await claims.unlessRunning(async () =>
              await kickAdapter.claimChallenges?.({ signal: operation.signal }) ?? []);
            // The tick is claiming: it stamps the poll itself.
            if (challenges === undefined) return;
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
          const committed = await withStateLock(async () => {
            const latest = await ports.storage.loadState();
            const next: SchedulerState = {
              ...latest,
              gamification: {
                ...latest.gamification,
                kick: newerCheck(checked, latest.gamification?.kick),
              },
            };
            const persisted = await persistPlatformState("kick", next, () => !operation.signal.aborted);
            return persisted ? { latest, next } : undefined;
          }, ["kick"]);
          operation.signal.throwIfAborted();
          if (!committed) return;
          await emitNotifications(settings, committed.latest, committed.next, events);
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
      });
    } finally {
      claimOperations.delete(operation);
    }
  }

  // After a tick cycle's commit, with no lock held: the route evidence the
  // cycle gathered advances or resets recovery of the retained page context.
  // Direct successes count only for a committed cycle whose discovery completed
  // without errors; a failed cycle can still reset recovery with a fallback.
  async function observeTickCycle(
    platforms: readonly Platform[],
    outcome: TickCycleOutcome,
    tickContext: TickDiagnosticContext,
  ): Promise<void> {
    const pageContexts = ports.tabs?.pageContexts;
    // Only Kick opens page contexts to recover from.
    if (!pageContexts || !platforms.includes("kick")) return;
    const countBackgroundSuccess = outcome.status === "committed"
      && outcome.discoveryComplete.has("kick")
      && (outcome.state.sessions.kick.errorChecks ?? 0) === 0;
    await withEventCollector(async (recoveryEmit, recoveryEvents) => {
      try {
        const changed = await pageContexts.recover("kick", { countBackgroundSuccess }, recoveryEmit);
        // Runs after the tick's commit with no lock held (#598), so the page
        // contexts it changed are committed onto the latest state.
        if (changed) {
          await withStateLock(async () => {
            await persistPlatformState("kick", await ports.storage.loadState());
          }, ["kick"]);
        }
      } catch (error) {
        recoveryEmit({
          category: "diagnostic",
          level: "debug",
          platform: "kick",
          message: `Page-context recovery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      await reportBestEffort(correlateTickDiagnostics(recoveryEvents, tickContext));
    });
  }

  // Every tick cycle ends here, committed or not. Evidence a cycle gathered but
  // did not hand to observeTickCycle is dropped, so it cannot count later.
  function endTickCycle(platform: Platform): void {
    if (platform === "kick") ports.tabs?.pageContexts.discardRecoveryEvidence(platform);
  }

  return {
    abortKickChallengeClaims,
    clearKickChallengeJobBestEffort,
    endTickCycle,
    observeTickCycle,
    reconcileKickChallengeJob,
    registerKickRuntimeEffects: registerEffects,
    rescheduleKickChallengeJob,
    runKickChallengeClaims,
  };
}
