import { randomUUID } from "node:crypto";
import {
  type ActivityHistoryRepository,
  MAX_ACTIVITY_RECORDS_PER_CATEGORY,
  MAX_ACTIVITY_SESSIONS,
  activityPageLimit,
  activityQueryMatcher,
  activityRetentionCutoff,
  activitySessionRetained,
  compareActivityRecords,
  decodeActivityCursor,
  encodeActivityCursor,
  foldActivityBatch,
  sanitizeStoredActivity,
  selectActivityHistoryEvents,
  toStoredActivityEvents,
} from "@lurkloot/shared/activityHistory";
import type { ActivityEvent, EngineEvent, StoredEngineEvent } from "@lurkloot/shared/events";
import { isActivityTimelineEvent } from "@lurkloot/shared/farmingSessions";
import type { FarmingSessionSummary } from "@lurkloot/shared/farmingSessions";
import type { ActivityPage, ActivityQuery } from "@lurkloot/shared/messages";
import { PLATFORMS, type Platform } from "@lurkloot/shared/models";
import { readJsonSidecar, writeJsonAtomically } from "./storage";

// The CLI's activity history (#1088): the extension's history, kept in one
// bounded JSON file beside state.json instead of IndexedDB. Retention, the
// record format, the session fold and page selection are the shared ones
// (@lurkloot/shared/activityHistory). The whole history is held in memory;
// every change is pruned to the shared bounds and written back atomically.

export const ACTIVITY_WRITE_INTERVAL_MS = 30_000;
const FILE_VERSION = 1;

type StoredActivity = ActivityEvent & Pick<StoredEngineEvent, "id" | "at">;

interface ActivityFile {
  version: typeof FILE_VERSION;
  events: StoredActivity[];
  sessions: FarmingSessionSummary[];
}

export interface CliActivityHistory extends ActivityHistoryRepository {
  append(events: readonly EngineEvent[]): Promise<void>;
  // Stops accepting events and drains changes and writes already queued.
  close(): Promise<void>;
}

export interface FileActivityHistoryOptions {
  // A write that failed; the history stays in memory and the next change
  // writes it again.
  onSaveError?(error: unknown): void;
  // The history starts empty when the file cannot be read or parsed.
  // An unsupported version stays on disk while new activity is kept in memory.
  onLoadError?(error: unknown): void;
  now?(): number;
  randomId?(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredEvent(value: unknown): value is StoredActivity {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.at === "string"
    && value.category === "activity"
    && typeof value.code === "string"
    && isRecord(value.data)
    && isActivityTimelineEvent({ category: value.category, code: value.code })
  );
}

function isSession(value: unknown): value is FarmingSessionSummary {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && (value.platform === "twitch" || value.platform === "kick")
    && typeof value.startedAt === "string"
    && isRecord(value.tallies)
    && isRecord(value.rewardCounts)
  );
}

class UnsupportedActivityVersionError extends Error {}

// Entries the CLI could not have written are dropped, not trusted.
function parseActivityFile(parsed: unknown): ActivityFile {
  if (!isRecord(parsed) || !("version" in parsed)) {
    throw new Error("Invalid activity history snapshot");
  }
  if (parsed.version !== FILE_VERSION) {
    throw new UnsupportedActivityVersionError(
      "Unsupported activity history version. The file was left intact",
    );
  }
  return {
    version: FILE_VERSION,
    events: Array.isArray(parsed.events)
      ? parsed.events.filter(isStoredEvent).map(sanitizeStoredActivity)
      : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSession) : [],
  };
}

function emptyFile(): ActivityFile {
  return { version: FILE_VERSION, events: [], sessions: [] };
}

// Keep recent rows and sessions within the shared activity budget.
function prune(file: ActivityFile, now: number): ActivityFile {
  const cutoff = activityRetentionCutoff("activity", now);
  const events = file.events
    .filter((event) => event.at >= cutoff)
    .sort(compareActivityRecords)
    .slice(-MAX_ACTIVITY_RECORDS_PER_CATEGORY);
  const sessions: FarmingSessionSummary[] = [];
  for (const platform of PLATFORMS) {
    const retained = file.sessions
      .filter((session) => session.platform === platform && activitySessionRetained(session, now))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const open = retained.filter((session) => !session.endedAt);
    const ended = retained.filter((session) => session.endedAt);
    sessions.push(...[...open, ...ended].slice(0, MAX_ACTIVITY_SESSIONS));
  }
  return { version: FILE_VERSION, events, sessions };
}

export function createFileActivityHistory(
  path: string,
  options: FileActivityHistoryOptions = {},
): CliActivityHistory {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  let file: ActivityFile | undefined;
  let loading: Promise<ActivityFile> | undefined;
  // Changes apply one at a time, in the order they were made.
  let changes: Promise<void> = Promise.resolve();
  // One write in flight; a change made meanwhile is written after it.
  let writing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let nextWriteAt = 0;
  let unsupportedVersion: UnsupportedActivityVersionError | undefined;
  let dirty = false;
  let saveFailed = false;
  let clearing = false;
  let closing: Promise<void> | undefined;

  const load = (): Promise<ActivityFile> => {
    if (file) return Promise.resolve(file);
    loading ??= (async () => {
      try {
        file = prune(parseActivityFile((await readJsonSidecar(path)).value), now());
      } catch (error) {
        if (error instanceof UnsupportedActivityVersionError) unsupportedVersion = error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onLoadError?.(error);
        file = emptyFile();
      }
      return file;
    })();
    return loading;
  };

  const persist = async (snapshot: ActivityFile): Promise<void> => {
    nextWriteAt = performance.now() + ACTIVITY_WRITE_INTERVAL_MS;
    await writeJsonAtomically(path, snapshot, 0o600, 0);
  };

  const persistBestEffort = async (snapshot: ActivityFile): Promise<void> => {
    try {
      await persist(snapshot);
      saveFailed = false;
    } catch (error) {
      saveFailed = true;
      options.onSaveError?.(error);
    }
  };

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const scheduleWrite = (): void => {
    if (!dirty || timer || writing || clearing || closing) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!file) return;
        dirty = false;
        writing = persistBestEffort(file).finally(() => {
          writing = undefined;
          scheduleWrite();
        });
      },
      Math.max(0, Math.ceil(nextWriteAt - performance.now())),
    );
    timer.unref();
  };

  const change = (apply: () => Promise<void>): Promise<void> => {
    const run = changes.then(apply);
    changes = run.catch(() => undefined);
    return run;
  };

  // Reads wait for the changes made before them.
  const read = async (): Promise<ActivityFile> => {
    await changes;
    return load();
  };

  return {
    append: (events) => {
      if (closing) return Promise.resolve();
      const activity = selectActivityHistoryEvents(events, false);
      if (activity.length === 0) return Promise.resolve();
      return change(async () => {
        const current = await load();
        const stored = toStoredActivityEvents(activity, new Date(now()).toISOString(), randomId);
        const byId = new Map(current.sessions.map((session) => [session.id, session]));
        const { records, sessions } = foldActivityBatch(stored, {
          get: (id) => byId.get(id),
          startedBefore: (platform, startedAt) =>
            current.sessions.filter(
              (session) => session.platform === platform && session.startedAt < startedAt,
            ),
        });
        for (const session of sessions) byId.set(session.id, session);
        file = prune(
          {
            version: FILE_VERSION,
            events: [...current.events, ...records.filter(isStoredEvent)],
            sessions: [...byId.values()],
          },
          now(),
        );
        dirty = !unsupportedVersion;
        scheduleWrite();
      });
    },

    async load(query: ActivityQuery): Promise<ActivityPage> {
      // Before reading, so a bad cursor fails without touching the history.
      const before = query.cursor ? decodeActivityCursor(query.cursor) : undefined;
      const current = await read();
      const cutoff = activityRetentionCutoff(query.category, now());
      const limit = activityPageLimit(query.limit);
      const matches = activityQueryMatcher(query);
      const events: StoredEngineEvent[] = [];
      // Newest first, below the cursor.
      for (let index = current.events.length - 1; index >= 0; index -= 1) {
        const event = current.events[index]!;
        if (event.category !== query.category || event.at < cutoff) continue;
        if (before && compareActivityRecords(event, { at: before[0], id: before[1] }) >= 0)
          continue;
        if (!matches(event)) continue;
        events.push(event);
        if (events.length === limit + 1) break;
      }
      const hasMore = events.length > limit;
      if (hasMore) events.pop();
      const last = events.at(-1);
      return {
        events,
        ...(hasMore && last ? { nextCursor: encodeActivityCursor([last.at, last.id]) } : {}),
      };
    },

    async loadSessions(platform: Platform): Promise<FarmingSessionSummary[]> {
      const current = await read();
      const at = now();
      return current.sessions
        .filter((session) => session.platform === platform && activitySessionRetained(session, at))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, MAX_ACTIVITY_SESSIONS);
    },

    clear: () => {
      if (closing) return Promise.reject(new Error("The activity history is closed"));
      return change(async () => {
        await load();
        if (unsupportedVersion) throw unsupportedVersion;
        clearing = true;
        cancelTimer();
        try {
          await writing;
          const empty = emptyFile();
          await persist(empty);
          file = empty;
          dirty = false;
          saveFailed = false;
        } finally {
          clearing = false;
          scheduleWrite();
        }
      });
    },

    close() {
      cancelTimer();
      closing ??= (async () => {
        await changes;
        await writing;
        if (file && (dirty || saveFailed)) await persistBestEffort(file);
      })();
      return closing;
    },
  };
}
