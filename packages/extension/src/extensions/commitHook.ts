import type { CommittedChange } from "@lurkloot/core/controller";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";

// What a committed change means for the Twitch Extensions lane (#594). It
// replaces the storage.onChanged diff and the reconcile on every alarm: the lane
// reacts to the controller's accepted commits only.
export interface TwitchExtensionCommitEffect {
  // Authority changed: stop the providers before anything asynchronous runs.
  readonly invalidate?: { readonly preserveCompleted: boolean };
  // Re-read settings and state and bring the providers in line with them.
  readonly reconcile: boolean;
  // A tabless-only session's failed heartbeat result just committed.
  readonly heartbeatFailure?: { readonly provider: string; readonly username: string; readonly heartbeatChecks: number };
}

const NONE: TwitchExtensionCommitEffect = { reconcile: false };

function settingsChangeInvalidates(previous: ExtensionSettings, next: ExtensionSettings): boolean {
  return previous.pauseOnManualWatch !== next.pauseOnManualWatch
    || previous.platform.twitch.enabled !== next.platform.twitch.enabled
    || previous.twitchExtensions.nopixel.enabled !== next.twitchExtensions.nopixel.enabled
    || previous.twitchExtensions.fortnite.enabled !== next.twitchExtensions.fortnite.enabled
    || previous.twitchExtensions.nopixel.autoOpenPacks !== next.twitchExtensions.nopixel.autoOpenPacks
    || previous.twitchExtensions.fortnite.allowTakeovers !== next.twitchExtensions.fortnite.allowTakeovers;
}

function stateChangeInvalidates(previous: SchedulerState, next: SchedulerState): boolean {
  return Boolean(previous.manualClosePause?.twitch) !== Boolean(next.manualClosePause?.twitch)
    || previous.manualWatch?.twitch?.active !== next.manualWatch?.twitch?.active
    || previous.sessions.twitch.status !== next.sessions.twitch.status
    || previous.sessions.twitch.channel?.channelId !== next.sessions.twitch.channel?.channelId
    || previous.authHealth.twitch.status !== next.authHealth.twitch.status;
}

function failedSupplementalHeartbeat(previous: SchedulerState, next: SchedulerState): TwitchExtensionCommitEffect["heartbeatFailure"] {
  const session = next.sessions.twitch;
  if (!session.supplementalWatch?.tablessOnly || !session.channel) return undefined;
  if (session.lastHeartbeatOk !== false || session.lastHeartbeatAt === previous.sessions.twitch.lastHeartbeatAt) return undefined;
  if (!/^[a-zA-Z0-9_]{1,25}$/.test(session.channel.username)) return undefined;
  return { provider: session.supplementalWatch.id, username: session.channel.username, heartbeatChecks: session.heartbeatChecks ?? 0 };
}

export function twitchExtensionCommitEffect(change: CommittedChange<ExtensionSettings>): TwitchExtensionCommitEffect {
  if (change.kind === "settings") {
    // A ranking-only save (#571) changes nothing the providers depend on.
    if (change.effects.twitch === "selection") return NONE;
    return settingsChangeInvalidates(change.previous, change.settings)
      ? { invalidate: { preserveCompleted: false }, reconcile: true }
      : { reconcile: true };
  }
  if (!change.platforms.includes("twitch")) return NONE;
  const heartbeatFailure = failedSupplementalHeartbeat(change.previous, change.state);
  if (!stateChangeInvalidates(change.previous, change.state)) {
    return heartbeatFailure ? { reconcile: true, heartbeatFailure } : { reconcile: true };
  }
  // Completion belongs to the account: it survives only while auth stays healthy.
  const preserveCompleted = change.previous.authHealth.twitch.status === "healthy"
    && change.state.authHealth.twitch.status === "healthy";
  return { invalidate: { preserveCompleted }, reconcile: true };
}

export interface TwitchExtensionReconciler {
  invalidate(options?: { preserveCompleted?: boolean }): void;
  reconcile(): Promise<void>;
  recordHeartbeatFailure?(failure: NonNullable<TwitchExtensionCommitEffect["heartbeatFailure"]>): Promise<void>;
}

// The lane's commit hook, and a reconcile that other host events (startup, a
// worker wake, an auth check) share with it. The hook invalidates synchronously
// and never waits on the reconcile: ticks and auth refreshes settle Twitch's
// commit hooks, so they must not wait on provider session reads. Reconciles run
// one at a time; a request while one runs queues a single re-run.
export function createTwitchExtensionCommitHook(host: TwitchExtensionReconciler, onReconcileError: () => void) {
  let running: Promise<void> | undefined;
  let again = false;

  function reconcile(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await host.reconcile();
        } catch {
          onReconcileError();
        }
      } while (again);
      // Cleared in the same turn as the last check of `again`, so a request
      // made after the loop ends starts a new run instead of being dropped.
      running = undefined;
    })();
    return running;
  }

  function onCommit(change: CommittedChange<ExtensionSettings>): void {
    const effect = twitchExtensionCommitEffect(change);
    if (effect.invalidate) host.invalidate(effect.invalidate);
    if (effect.heartbeatFailure) void host.recordHeartbeatFailure?.(effect.heartbeatFailure).catch(() => undefined);
    if (effect.reconcile) void reconcile();
  }

  return { onCommit, reconcile };
}
