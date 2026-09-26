import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { currentManagedPageContextTabs, currentManagedPageContextTabsRevision } from "../core/tabs";
import { heartbeatContextKey, validTablessHeartbeatCadence } from "../core/heartbeatCadence";
import { mergePlatformState, schedulerStateEquivalent } from "./platformState";
import { PLATFORMS } from "./constants";

// The state transaction (#585): the locks that serialize settings and
// scheduler-state writes, the commits made under them, and the hooks that
// observe accepted commits. docs/architecture.md ("Commits and locks")
// describes the model.

// Locks in acquisition order. A lock may only be taken while every lock held by
// the same operation comes earlier in this list.
export const TRANSACTION_LOCKS = ["settings", "twitch", "kick", "heartbeat", "commit"] as const;
export type TransactionLock = (typeof TRANSACTION_LOCKS)[number];

// Test instrumentation. The host leaves it out; the test suite supplies one
// backed by node:async_hooks so each operation knows which locks it holds.
export interface LockTracker {
  // The locks held by the calling operation, in acquisition order.
  held(): readonly TransactionLock[];
  // Runs `operation` (and everything it starts) as holding `held`.
  run<T>(held: readonly TransactionLock[], operation: () => T): T;
  // A lock-order violation or nested commit. Reported as well as thrown, since
  // a best-effort caller may swallow the rejection.
  violation(error: Error): void;
}

export class LockOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockOrderError";
  }
}

// What a settings commit changes for one platform:
// - "discovery": discovery and selection are both out of date;
// - "selection": ranking only, so discovery holds and only selection is redone.
// A platform the patch does not touch has no entry.
export type SettingsEffect = "discovery" | "selection";
export type SettingsEffects = Partial<Record<Platform, SettingsEffect>>;

// Settings that only decide the order campaigns are farmed in. Discovery does
// not read them, so saving one keeps the discovered campaigns and channels.
// Pins are the exception while "farm pinned only" is on: discovery then skips
// unpinned campaigns, so a new pin needs its channels found.
const RANKING_SETTING_KEYS = new Set(["priorityMode", "campaignPins"]);
const RANKING_PLATFORM_SETTING_KEYS = new Set(["favouriteCategories"]);

export function isRankingOnlyPatch(patch: SettingsPatch, current: Pick<EngineSettings, "farmPinnedOnly">): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return false;
  if ("campaignPins" in patch && current.farmPinnedOnly) return false;
  return keys.every((key) => {
    if (key !== "platform") return RANKING_SETTING_KEYS.has(key);
    return Object.values(patch.platform ?? {}).every((platformPatch) =>
      Object.keys(platformPatch ?? {}).every((platformKey) => RANKING_PLATFORM_SETTING_KEYS.has(platformKey)));
  });
}

export function settingsPatchEffects(
  patch: SettingsPatch,
  current: Pick<EngineSettings, "farmPinnedOnly">,
): SettingsEffects {
  const keys = Object.keys(patch);
  const platforms = keys.every((key) => key === "platform") && patch.platform
    ? PLATFORMS.filter((platform) => patch.platform?.[platform] !== undefined)
    : PLATFORMS;
  // Anything the ranking-only rules do not recognize counts as "discovery": the
  // safe default, since it only costs an extra refresh.
  const effect: SettingsEffect = isRankingOnlyPatch(patch, current) ? "selection" : "discovery";
  return Object.fromEntries(platforms.map((platform) => [platform, effect]));
}

// A commit guard: the operation's expected generation, as an abort signal or a
// predicate. A commit whose guard no longer holds is "stale" and writes nothing.
// Work that already happened (a claim, a tab opened or closed) commits without
// a guard, so it merges even after its operation was superseded.
export type CommitGuard = AbortSignal | (() => boolean);

export type CommitResult =
  | { readonly status: "accepted"; readonly previous: SchedulerState; readonly state: SchedulerState }
  | { readonly status: "unchanged"; readonly state: SchedulerState }
  | { readonly status: "stale" };

export interface CommitOptions {
  // Write even when the result is equivalent to the stored state.
  writeEquivalent?: boolean;
  // Runs synchronously after the save, before the commit lock is released.
  afterSave?(state: SchedulerState): void;
}

export interface PreparedSettingsCommit<S> {
  readonly previous: S;
  readonly patch: SettingsPatch;
  readonly settings: S;
  readonly effects: SettingsEffects;
}

export type CommittedChange<S> =
  | {
      readonly kind: "state";
      readonly platforms: readonly Platform[];
      readonly previous: SchedulerState;
      readonly state: SchedulerState;
    }
  | {
      readonly kind: "settings";
      readonly previous: S;
      readonly settings: S;
      readonly effects: SettingsEffects;
    };

// Called once per accepted commit, in registration order, after the locks
// guarding the commit are released. A hook that changes state makes its own
// commit; it is queued like any other, never nested in the one it observes.
export type CommitHook<S> = (change: CommittedChange<S>) => void | Promise<void>;

export interface StateTransactionPorts<S extends EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  lockTracker?: LockTracker;
}

export function createStateTransaction<S extends EngineSettings>(ports: StateTransactionPorts<S>) {
  const tracker = ports.lockTracker;
  const chains: Record<Exclude<TransactionLock, "heartbeat">, Promise<unknown>> = {
    settings: Promise.resolve(),
    twitch: Promise.resolve(),
    kick: Promise.resolve(),
    commit: Promise.resolve(),
  };
  const hooks: CommitHook<S>[] = [];
  let hookQueue: Promise<void> = Promise.resolve();

  // Checks the lock order for the calling operation and returns `operation`
  // wrapped to run as holding `lock` as well.
  function admit<T>(lock: TransactionLock, operation: () => Promise<T>): () => Promise<T> {
    if (!tracker) return operation;
    const held = tracker.held();
    const rank = TRANSACTION_LOCKS.indexOf(lock);
    const blocking = held.find((heldLock) => TRANSACTION_LOCKS.indexOf(heldLock) >= rank);
    if (blocking) {
      const error = new LockOrderError(lock === "commit" && blocking === "commit"
        ? "Nested state commit: a commit cannot start while its operation holds the commit lock"
        : `Lock order violation: acquiring ${lock} while holding ${held.join(" → ")}`);
      tracker.violation(error);
      return () => Promise.reject(error);
    }
    return () => tracker.run([...held, lock], operation);
  }

  function withLock<T>(lock: Exclude<TransactionLock, "heartbeat">, operation: () => Promise<T>): Promise<T> {
    const admitted = admit(lock, operation);
    const run = chains[lock].then(admitted, admitted);
    chains[lock] = run.then(() => undefined, () => undefined);
    return run;
  }

  function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    return withLock("settings", operation);
  }

  function withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T> {
    return withLock(platform, operation);
  }

  // Takes each requested platform's lock in the fixed order Twitch → Kick.
  function withStateLock<T>(
    operation: () => Promise<T>,
    platforms: readonly Platform[] = PLATFORMS,
  ): Promise<T> {
    const targets = PLATFORMS.filter((platform) => platforms.includes(platform));
    const acquire = (index: number): Promise<T> => {
      const platform = targets[index];
      if (!platform) return operation();
      return withPlatformLock(platform, () => acquire(index + 1));
    };
    return acquire(0);
  }

  // A heartbeat lane is its own queue (heartbeat.ts). The transaction only
  // records it for the lock-order and locked-I/O checks.
  function trackHeartbeatLane<T>(operation: () => Promise<T>): Promise<T> {
    return admit("heartbeat", operation)();
  }

  function holds(lock: TransactionLock): boolean {
    return tracker?.held().includes(lock) ?? true;
  }

  function isStale(guard: CommitGuard | undefined): boolean {
    if (!guard) return false;
    return typeof guard === "function" ? !guard() : guard.aborted;
  }

  function notify(change: CommittedChange<S>, locks: readonly Exclude<TransactionLock, "heartbeat" | "commit">[]): void {
    if (hooks.length === 0) return;
    // The tails of the locks guarding this commit, as they are now: the hooks
    // run once the committing operation (and anything queued before it) has
    // released them, not while the commit's caller still holds them.
    const released = Promise.all(locks.map((lock) => chains[lock]));
    const run = async () => {
      await released;
      for (const hook of [...hooks]) {
        try {
          await hook(change);
        } catch {
          // A hook's failure is its own; it cannot undo an accepted commit.
        }
      }
    };
    hookQueue = hookQueue.then(() => (tracker ? tracker.run([], run) : run()));
  }

  function onCommit(hook: CommitHook<S>): () => void {
    hooks.push(hook);
    return () => {
      const index = hooks.indexOf(hook);
      if (index !== -1) hooks.splice(index, 1);
    };
  }

  async function saveStateDirect(state: SchedulerState): Promise<void> {
    const { events: _legacyEvents, ...operationalState } = state as SchedulerState & { events?: unknown };
    await ports.saveState(operationalState);
  }

  // Reads the stored scheduler state between commits.
  function readState(): Promise<SchedulerState> {
    return withLock("commit", () => ports.loadState());
  }

  // Reads settings and scheduler state as one consistent pair.
  function readSettingsAndState(): Promise<[S, SchedulerState]> {
    return withSettingsLock(() => withLock("commit", () =>
      Promise.all([ports.loadSettings(), ports.loadState()])));
  }

  // The commit primitive: load the stored state, check the guard, apply
  // `mutate` synchronously, and save when the result differs. `mutate` returns
  // undefined to write nothing. Only `platforms` may change; the caller holds
  // their locks when the change depends on in-memory lifecycle state.
  function commit(
    platforms: readonly Platform[],
    guard: CommitGuard | undefined,
    mutate: (latest: SchedulerState) => SchedulerState | undefined,
    options: CommitOptions = {},
  ): Promise<CommitResult> {
    return withLock("commit", async () => {
      if (isStale(guard)) return { status: "stale" };
      const latest = await ports.loadState();
      if (isStale(guard)) return { status: "stale" };
      const next = mutate(latest);
      if (next === undefined || (!options.writeEquivalent && schedulerStateEquivalent(latest, next))) {
        return { status: "unchanged", state: latest };
      }
      await saveStateDirect(next);
      options.afterSave?.(next);
      notify({ kind: "state", platforms, previous: latest, state: next }, ["settings", ...platforms]);
      return { status: "accepted", previous: latest, state: next };
    });
  }

  // Commits a whole state the caller built from an earlier load. Every platform
  // is written, so the caller must hold every platform's lock.
  function commitWholeState(state: SchedulerState): Promise<CommitResult> {
    return commit(PLATFORMS, undefined, () => state, { writeEquivalent: true });
  }

  // Commits one platform's part of `snapshot`, merged into the latest stored
  // state. The live page-context registry and a still-current heartbeat cadence
  // win over the snapshot, since both move outside the platform lock.
  function commitPlatformSnapshot(
    platform: Platform,
    snapshot: SchedulerState,
    guard?: CommitGuard,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<CommitResult> {
    return withLock("commit", async () => {
      // The registry can change while storage I/O is in flight (for example a
      // page-context fallback reported by the heartbeat watcher). Retry the
      // short merge when its revision moved, so the last write is a compare-
      // and-swap style recapture rather than a stale snapshot overwrite.
      let result: CommitResult | undefined;
      while (true) {
        const latest = await ports.loadState();
        const currentSession = latest.sessions[platform];
        const nextSession = snapshot.sessions[platform];
        const currentCadence = validTablessHeartbeatCadence(currentSession);
        const nextCadence = validTablessHeartbeatCadence(nextSession);
        const retainsHeartbeatAuthority = currentCadence !== undefined
          && nextCadence !== undefined
          && currentCadence.generation === nextCadence.generation
          && currentCadence.contextKey === nextCadence.contextKey
          && heartbeatContextKey(currentSession) === currentCadence.contextKey
          && heartbeatContextKey(nextSession) === nextCadence.contextKey;
        const pageContextRevision = currentManagedPageContextTabsRevision();
        const livePageContexts = currentManagedPageContextTabs();
        const mergeSourcePageContexts = { ...snapshot.managedPageContextTabs };
        const livePageContext = livePageContexts[platform];
        if (livePageContext) mergeSourcePageContexts[platform] = livePageContext;
        else delete mergeSourcePageContexts[platform];
        const stateForMerge = {
          ...snapshot,
          managedPageContextTabs: mergeSourcePageContexts,
        };
        const mergeSource = retainsHeartbeatAuthority
          ? {
              ...stateForMerge,
              sessions: {
                ...snapshot.sessions,
                [platform]: {
                  ...nextSession,
                  lastHeartbeatAt: currentSession.lastHeartbeatAt,
                  lastHeartbeatOk: currentSession.lastHeartbeatOk,
                  heartbeatChecks: currentSession.heartbeatChecks,
                  tablessHeartbeat: currentCadence,
                },
              },
            }
          : stateForMerge;
        if (isStale(guard)) {
          // An earlier pass may already have written; its hooks still run, but
          // the superseded operation publishes nothing.
          if (result?.status === "accepted") {
            notify({ kind: "state", platforms: [platform], previous: result.previous, state: result.state }, ["settings", platform]);
          }
          return { status: "stale" };
        }
        const merged = mergePlatformState(latest, mergeSource, platform);
        // A tick that decided nothing still restamps lastTickAt, so an
        // unguarded write churns storage every poll interval forever. The
        // disabled platform is the clearest case: its tick reaches the
        // scheduler's disabled branch and rebuilds the very same session on
        // every pass, and both tick alarms keep firing whether or not the
        // platform is enabled. Skip the write and leave lastTickAt where it
        // was — storage already holds this state, so callers must still treat
        // it as persisted, and `latest` (not `merged`) is what they observe.
        if (schedulerStateEquivalent(latest, merged)) {
          result = result?.status === "accepted"
            ? { ...result, state: latest }
            : { status: "unchanged", state: latest };
        } else {
          await saveStateDirect(merged);
          result = {
            status: "accepted",
            previous: result?.status === "accepted" ? result.previous : latest,
            state: merged,
          };
        }
        if (currentManagedPageContextTabsRevision() === pageContextRevision) {
          if (result.status === "accepted") {
            notify({ kind: "state", platforms: [platform], previous: result.previous, state: result.state }, ["settings", platform]);
          } else {
            result = { status: "unchanged", state: latest };
          }
          onPersisted?.(result.state);
          return result;
        }
      }
    });
  }

  // Loads the settings once and works out the commit: the patch computed from
  // the stored value, the resulting settings, and each platform's effect. The
  // caller holds the settings lock and saves with saveSettingsCommit.
  async function prepareSettingsCommit(
    update: (current: S) => SettingsPatch,
    apply: ((current: S, patch: SettingsPatch) => S) | undefined = ports.applySettingsPatch,
  ): Promise<PreparedSettingsCommit<S>> {
    if (!holds("settings")) {
      const error = new LockOrderError("A settings commit must hold the settings lock");
      tracker?.violation(error);
      throw error;
    }
    const previous = await ports.loadSettings();
    const patch = update(previous);
    const effects = settingsPatchEffects(patch, previous);
    if (!apply) {
      throw new Error("applySettingsPatch dependency is required to mutate settings");
    }
    return { previous, patch, settings: apply(previous, patch), effects };
  }

  async function saveSettingsCommit(prepared: PreparedSettingsCommit<S>): Promise<void> {
    await ports.saveSettings(prepared.settings);
    notify({
      kind: "settings",
      previous: prepared.previous,
      settings: prepared.settings,
      effects: prepared.effects,
    }, ["settings"]);
  }

  // Resolves once every hook for the commits made so far has run.
  function settleCommitHooks(): Promise<void> {
    return hookQueue;
  }

  return {
    withSettingsLock,
    withPlatformLock,
    withStateLock,
    trackHeartbeatLane,
    readState,
    readSettingsAndState,
    commit,
    commitWholeState,
    commitPlatformSnapshot,
    prepareSettingsCommit,
    saveSettingsCommit,
    onCommit,
    settleCommitHooks,
  };
}

export type StateTransaction<S extends EngineSettings> = ReturnType<typeof createStateTransaction<S>>;
