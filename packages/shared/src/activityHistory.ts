import type {
  ActivityHistoryRecord,
  EngineEvent,
  EventCategory,
  StoredEngineEvent,
} from "./events";
import {
  type FarmingSessionSummary,
  foldSessionEvent,
  isActivityTimelineEvent,
  tallyKey,
} from "./farmingSessions";
import type {
  ActivityPage,
  ActivityQuery,
  ActivitySessionsPage,
  DiagnosticsExport,
  RuntimeMessage,
} from "./messages";
import type { Platform } from "./models";

// The activity history every host keeps behind the popup's activity messages:
// its retention, its record format, how a batch folds into farming sessions,
// how a page is selected, and the message handler and reporter. Hosts differ
// only in where the records live (IndexedDB in the extension, a file in the
// CLI), so each storage backend calls these instead of restating them.

export const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
// Each category has its own budget, so diagnostic mirrors never evict activity.
export const MAX_ACTIVITY_RECORDS_PER_CATEGORY = 2_000;
// The most sessions getActivitySessions returns for one platform.
export const MAX_ACTIVITY_SESSIONS = 200;
export const DEFAULT_ACTIVITY_PAGE_LIMIT = 80;
export const MAX_ACTIVITY_PAGE_LIMIT = 100;

export function activityRetentionMs(category: EventCategory): number {
  return category === "activity" ? ACTIVITY_RETENTION_MS : DIAGNOSTIC_RETENTION_MS;
}

// The oldest `at` a category still keeps, as an ISO timestamp.
export function activityRetentionCutoff(category: EventCategory, now: number): string {
  return new Date(now - activityRetentionMs(category)).toISOString();
}

// A whole number of records from 1 to the maximum: a page ends when it holds
// one more than the limit, which a fractional limit would never reach.
export function activityPageLimit(limit: number | undefined): number {
  const requested = Math.floor(limit ?? DEFAULT_ACTIVITY_PAGE_LIMIT);
  return Math.min(MAX_ACTIVITY_PAGE_LIMIT, Math.max(1, requested));
}

// A page ends at the last record it returned; the next one starts below it.
export type ActivityCursor = [at: string, id: string];

// A cursor the caller sent that this history did not issue.
export class InvalidActivityCursorError extends Error {
  constructor() {
    super("Invalid activity cursor");
    this.name = "InvalidActivityCursorError";
  }
}

export function encodeActivityCursor([at, id]: ActivityCursor): string {
  return encodeURIComponent(JSON.stringify([at, id]));
}

export function decodeActivityCursor(value: string): ActivityCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(value)) as unknown;
  } catch {
    throw new InvalidActivityCursorError();
  }
  if (
    !Array.isArray(decoded)
    || decoded.length !== 2
    || typeof decoded[0] !== "string"
    || typeof decoded[1] !== "string"
  ) {
    throw new InvalidActivityCursorError();
  }
  return [decoded[0], decoded[1]];
}

// Records sort by `at`, then by `id`: the order a page is read in, newest first
// from the end.
export function compareActivityRecords(
  left: Pick<ActivityHistoryRecord, "at" | "id">,
  right: Pick<ActivityHistoryRecord, "at" | "id">,
): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

// Whether a record of the query's category belongs on its page. A record with
// no platform is shown under both; the text search reads diagnostic messages.
export function activityQueryMatcher(
  query: Pick<ActivityQuery, "platform" | "query">,
): (event: ActivityHistoryRecord) => boolean {
  const normalizedQuery = query.query?.trim().toLowerCase();
  return (event) =>
    (!query.platform || !event.platform || event.platform === query.platform)
    && (!normalizedQuery || event.message?.toLowerCase().includes(normalizedQuery) === true);
}

// The stored form of a reported batch. `at` is when the event was emitted, or
// the batch's write time for an event that reached storage without one. The
// id keeps events that share a timestamp in emission order.
export function toStoredActivityEvents(
  events: readonly EngineEvent[],
  writtenAt: string,
  randomId: () => string,
): StoredEngineEvent[] {
  return events.map((event, index) => {
    const { emittedAt, ...rest } = event;
    const at = emittedAt ?? writtenAt;
    return {
      ...rest,
      id: `${at}-${String(index).padStart(6, "0")}-${randomId()}`,
      at,
      ...(event.data ? { data: { ...event.data } } : {}),
    };
  }) as StoredEngineEvent[];
}

// What a batch fold reads of the stored sessions, synchronously: the host
// loads it first (inside the transaction that writes, where there is one).
export interface ActivitySessionLookup {
  get(id: string): FarmingSessionSummary | undefined;
  // The platform's stored sessions that started before `startedAt`.
  startedBefore(platform: Platform, startedAt: string): readonly FarmingSessionSummary[];
}

// Session ids a batch folds into, which the lookup must be able to answer.
export function activityBatchSessionIds(events: readonly StoredEngineEvent[]): string[] {
  return [
    ...new Set(
      events.flatMap((event) =>
        event.category === "activity" && typeof event.sessionId === "string"
          ? [event.sessionId]
          : [],
      ),
    ),
  ];
}

// The session starts in a batch, each needing the lookup's startedBefore.
export function activityBatchSessionStarts(
  events: readonly StoredEngineEvent[],
): Array<{ platform: Platform; startedAt: string }> {
  return events.flatMap((event) =>
    event.category === "activity" && event.code === "session_started" && event.platform
      ? [{ platform: event.platform, startedAt: event.data.startedAt }]
      : [],
  );
}

// Folds a stored batch into its farming sessions. Returns the records to store
// (tallied events, such as points, are only folded) and every session summary
// the batch changed.
export function foldActivityBatch(
  events: readonly StoredEngineEvent[],
  lookup: ActivitySessionLookup,
): { records: StoredEngineEvent[]; sessions: FarmingSessionSummary[] } {
  const summaries = new Map<string, FarmingSessionSummary | undefined>();
  for (const id of activityBatchSessionIds(events)) summaries.set(id, lookup.get(id));
  // A session whose session_ended was never stored (reporting is best
  // effort) would otherwise stay "current" and unprunable forever: the
  // platform's next session start ends it.
  for (const event of events) {
    if (event.category !== "activity" || event.code !== "session_started" || !event.platform)
      continue;
    const started = event.data.startedAt;
    for (const summary of lookup.startedBefore(event.platform, started)) {
      const current = summaries.get(summary.id) ?? summary;
      if (current.id !== event.data.sessionId && !current.endedAt)
        summaries.set(summary.id, { ...current, endedAt: started });
    }
  }
  const records: StoredEngineEvent[] = [];
  for (const event of events) {
    if (event.category === "activity" && typeof event.sessionId === "string") {
      summaries.set(event.sessionId, foldSessionEvent(summaries.get(event.sessionId), event));
    }
    if (event.category !== "activity" || tallyKey(event) === undefined) records.push(event);
  }
  const sessions = [...summaries.values()].filter(
    (summary): summary is FarmingSessionSummary => summary !== undefined,
  );
  return { records, sessions };
}

// An open session is kept however long it has run; an ended one for the
// activity retention.
export function activitySessionRetained(session: FarmingSessionSummary, now: number): boolean {
  return !session.endedAt || session.endedAt >= activityRetentionCutoff("activity", now);
}

// The storage a host's activity messages are answered from.
export interface ActivityHistoryRepository {
  load(query: ActivityQuery): Promise<ActivityPage>;
  loadSessions(platform: Platform): Promise<FarmingSessionSummary[]>;
  // A host that does not export diagnostics leaves it out and answers none.
  exportDiagnostics?(platform: Platform): Promise<ActivityHistoryRecord[]>;
  clear(): Promise<void>;
}

export type ActivityHistoryMessage = Extract<
  RuntimeMessage,
  { type: "getActivity" | "getActivitySessions" | "exportDiagnostics" | "clearActivity" }
>;

export function createActivityMessageHandler(repository: ActivityHistoryRepository) {
  return async (
    message: RuntimeMessage,
  ): Promise<ActivityPage | ActivitySessionsPage | DiagnosticsExport | void | undefined> => {
    if (message.type === "getActivity") {
      const { type: _type, ...query } = message;
      return repository.load(query);
    }
    if (message.type === "getActivitySessions") {
      return { sessions: await repository.loadSessions(message.platform) };
    }
    if (message.type === "exportDiagnostics") {
      if (!repository.exportDiagnostics) return undefined;
      return { events: await repository.exportDiagnostics(message.platform) };
    }
    if (message.type === "clearActivity") {
      await repository.clear();
    }
    return undefined;
  };
}

interface ActivityEventReporterDeps {
  loadDiagnosticLogging(): Promise<boolean>;
  append(events: readonly EngineEvent[]): Promise<void>;
}

// What a host's reporter keeps of each batch: the timeline's activity always,
// diagnostics only while the host keeps them.
export function createActivityEventReporter(deps: ActivityEventReporterDeps) {
  return async (events: readonly EngineEvent[]): Promise<void> => {
    let diagnosticLogging = false;
    try {
      diagnosticLogging = await deps.loadDiagnosticLogging();
    } catch {
      // A settings read must not prevent durable activity history. Treat a
      // missing setting as diagnostics disabled and retain normal activity.
    }
    // Activity that is not part of the user-facing timeline (tab open/close)
    // is kept only through its diagnostic mirror.
    const accepted = events.filter((event) =>
      event.category === "activity" ? isActivityTimelineEvent(event) : diagnosticLogging,
    );
    if (accepted.length > 0) await deps.append(accepted);
  };
}
