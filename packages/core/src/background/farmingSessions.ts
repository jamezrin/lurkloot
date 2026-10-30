import type { ActivityEvent, EngineEvent } from "@lurkloot/shared/events";
import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { errorMessage } from "@lurkloot/shared/errors";
import { PLATFORMS } from "./constants";
import { lateBound } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type { ControllerCalls } from "./types";

type OpenSession = { id: string; startedAt: string };
type ClosedSession = OpenSession & { endedAt: string };

// A farming session runs from a platform's farming being enabled until it is
// disabled, across restarts. The settings-commit reconcile and the startup
// reconcile are its only writers (state.farmingSessions). Every activity event
// the controller reports passes through stamp(), which files it under the
// session open when it was emitted, so the host can group and sum by session.
export function createFarmingSessions<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  calls: Pick<
    ControllerCalls<S>,
    "commitState" | "diagnosticEvent" | "reportBestEffort" | "withStateLock"
  >,
): Pick<ControllerCalls<S>, "reconcileFarmingSessions" | "stampFarmingSessions"> {
  const { commitState, diagnosticEvent, reportBestEffort, withStateLock } = lateBound(calls);
  // What stamp() reads: the committed open sessions, and the last session each
  // platform closed during this run, so an event emitted before a disable but
  // reported after it still lands in the session it happened in.
  let open: Partial<Record<Platform, OpenSession>> = {};
  const closed: Partial<Record<Platform, ClosedSession>> = {};
  // A worker restart starts a new controller with an empty mirror while the
  // session is still open in storage. The first stamp loads it, without the
  // state lock: reportBestEffort is called from inside locked sections.
  let hydration: Promise<void> | undefined;
  let reconciled = false;
  // Reconciles run one at a time, so a disable's reconcile cannot land after
  // the re-enable's and close the session the platform still needs.
  let queue: Promise<void> = Promise.resolve();

  function hydrate(): Promise<void> {
    hydration ??= (async () => {
      try {
        const state = await ports.storage.loadState();
        if (!reconciled) open = { ...state.farmingSessions };
      } catch {
        // Stamped null until the next reconcile fills the mirror.
      }
    })();
    return hydration;
  }

  // Only the decision and its commit are serialized; reporting the session
  // events happens after, so a slow host reporter never holds up the next
  // reconcile (or the settings save waiting on it).
  async function reconcileFarmingSessions(): Promise<void> {
    const run = queue.then(reconcileNow);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    const events = await run;
    if (events.length > 0) await reportBestEffort(events);
  }

  async function reconcileNow(): Promise<ActivityEvent[]> {
    const events: ActivityEvent[] = [];
    try {
      // Committed as no platform's change: farming sessions are global state,
      // and naming platforms here would wake their per-platform commit hooks
      // (claim aborts, push and observer reconciles) for nothing.
      await withStateLock(async () => {
        // Read under the lock, so the decision follows the latest saved switch.
        const settings = await ports.storage.loadSettings();
        await commitState([], undefined, (latest: SchedulerState) => {
          const sessions = { ...latest.farmingSessions };
          const now = new Date().toISOString();
          let changed = false;
          for (const platform of PLATFORMS) {
            const current = sessions[platform];
            if (settings.platform[platform].enabled && !current) {
              const session = { id: crypto.randomUUID(), startedAt: now };
              sessions[platform] = session;
              changed = true;
              events.push({
                category: "activity",
                code: "session_started",
                level: "info",
                platform,
                sessionId: session.id,
                data: { sessionId: session.id, startedAt: session.startedAt },
              });
            } else if (!settings.platform[platform].enabled && current) {
              delete sessions[platform];
              closed[platform] = { ...current, endedAt: now };
              changed = true;
              events.push({
                category: "activity",
                code: "session_ended",
                level: "info",
                platform,
                sessionId: current.id,
                data: {
                  sessionId: current.id,
                  startedAt: current.startedAt,
                  endedAt: now,
                  reason: "disabled",
                },
              });
            }
          }
          open = sessions;
          reconciled = true;
          return changed ? { ...latest, farmingSessions: sessions } : undefined;
        });
      });
      return events;
    } catch (error) {
      // The next settings commit or startup reconciles again.
      diagnosticEvent("warn", `Farming session reconcile failed: ${errorMessage(error)}`);
      return [];
    }
  }

  function sessionAt(platform: Platform, at: string): string | null {
    const current = open[platform];
    if (current && at >= current.startedAt) return current.id;
    const last = closed[platform];
    if (last && at >= last.startedAt && at <= last.endedAt) return last.id;
    return null;
  }

  async function stampFarmingSessions(events: readonly EngineEvent[]): Promise<EngineEvent[]> {
    if (
      events.some(
        (event) => event.category === "activity" && event.platform && event.sessionId === undefined,
      )
    )
      await hydrate();
    return events.map((event) => {
      if (
        event.category !== "activity"
        || !event.platform
        || event.sessionId !== undefined
        || event.code === "session_started"
        || event.code === "session_ended"
      )
        return event;
      const at = event.emittedAt ?? new Date().toISOString();
      return { ...event, sessionId: sessionAt(event.platform, at) };
    });
  }

  return { reconcileFarmingSessions, stampFarmingSessions };
}
