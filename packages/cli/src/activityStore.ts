import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  toStoredActivityEvents,
} from "@lurkloot/shared/activityHistory";
import type { EngineEvent, StoredEngineEvent } from "@lurkloot/shared/events";
import type { FarmingSessionSummary } from "@lurkloot/shared/farmingSessions";
import type { ActivityPage, ActivityQuery } from "@lurkloot/shared/messages";
import type { Platform } from "@lurkloot/shared/models";
import { writeJsonAtomically } from "./storage";

// The CLI's activity history (#1088): the extension's history, kept in one
// bounded JSON file beside state.json instead of IndexedDB. Retention, the
// record format, the session fold and page selection are the shared ones
// (@lurkloot/shared/activityHistory). The whole history is held in memory;
// every change is pruned to the shared bounds and written back atomically.

export const ACTIVITY_FILE_NAME = "activity.json";
const FILE_VERSION = 1;

interface ActivityFile {
  version: typeof FILE_VERSION;
  events: StoredEngineEvent[];
  sessions: FarmingSessionSummary[];
}

export interface CliActivityHistory extends ActivityHistoryRepository {
  append(events: readonly EngineEvent[]): Promise<void>;
  // Resolves once every change made so far is on disk (or failed to save).
  flush(): Promise<void>;
}

export interface FileActivityHistoryOptions {
  // A write that failed; the history stays in memory and the next change
  // writes it again.
  onSaveError?(error: unknown): void;
  // A file that could not be read or parsed. The history starts empty, and the
  // next change replaces the file.
  onLoadError?(error: unknown): void;
  now?(): number;
  randomId?(): string;
}

// The history sits beside the state file, in the CLI's data directory:
// activity.json for the default state.json, `<name>.activity.json` for any
// other, so two processes with their own --state files in one directory never
// rewrite each other's history.
export function activityPathFor(statePath: string): string {
  const name = basename(statePath);
  if (name === "state.json") return join(dirname(statePath), ACTIVITY_FILE_NAME);
  const stem = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
  return join(dirname(statePath), `${stem}.${ACTIVITY_FILE_NAME}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredEvent(value: unknown): value is StoredEngineEvent {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.at === "string"
    && (value.category === "activity" || value.category === "diagnostic")
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

// Entries the CLI could not have written are dropped, not trusted.
function parseActivityFile(text: string): ActivityFile {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION)
    throw new Error(`${ACTIVITY_FILE_NAME} is not a version ${FILE_VERSION} activity file`);
  return {
    version: FILE_VERSION,
    events: Array.isArray(parsed.events) ? parsed.events.filter(isStoredEvent) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSession) : [],
  };
}

function emptyFile(): ActivityFile {
  return { version: FILE_VERSION, events: [], sessions: [] };
}

// Keeps each category within its retention and record budget (newest kept),
// and the sessions the activity retention and getActivitySessions can still
// show: an open one always, ended ones for 30 days and at most the page size
// per platform.
function prune(file: ActivityFile, now: number): ActivityFile {
  const events = [...file.events].sort(compareActivityRecords);
  const kept: StoredEngineEvent[] = [];
  for (const category of ["activity", "diagnostic"] as const) {
    const cutoff = activityRetentionCutoff(category, now);
    const recent = events.filter((event) => event.category === category && event.at >= cutoff);
    kept.push(...recent.slice(-MAX_ACTIVITY_RECORDS_PER_CATEGORY));
  }
  kept.sort(compareActivityRecords);
  const sessions: FarmingSessionSummary[] = [];
  for (const platform of ["twitch", "kick"] as const) {
    const retained = file.sessions
      .filter((session) => session.platform === platform && activitySessionRetained(session, now))
      .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
    const open = retained.filter((session) => !session.endedAt);
    const ended = retained.filter((session) => session.endedAt).slice(0, MAX_ACTIVITY_SESSIONS);
    sessions.push(...open, ...ended);
  }
  return { version: FILE_VERSION, events: kept, sessions };
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
  let dirty = false;

  const load = (): Promise<ActivityFile> => {
    if (file) return Promise.resolve(file);
    loading ??= (async () => {
      try {
        file = parseActivityFile(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onLoadError?.(error);
        file = emptyFile();
      }
      return file;
    })();
    return loading;
  };

  const write = (): void => {
    dirty = true;
    if (writing) return;
    writing = (async () => {
      while (dirty) {
        dirty = false;
        const snapshot = file ?? emptyFile();
        try {
          await writeJsonAtomically(path, snapshot, 0o600, 0);
        } catch (error) {
          options.onSaveError?.(error);
        }
      }
      writing = undefined;
    })();
  };

  const change = (apply: (current: ActivityFile) => ActivityFile): Promise<void> => {
    const run = changes.then(async () => {
      file = prune(apply(await load()), now());
      write();
    });
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
      if (events.length === 0) return Promise.resolve();
      return change((current) => {
        const stored = toStoredActivityEvents(events, new Date(now()).toISOString(), randomId);
        const byId = new Map(current.sessions.map((session) => [session.id, session]));
        const { records, sessions } = foldActivityBatch(stored, {
          get: (id) => byId.get(id),
          startedBefore: (platform, startedAt) =>
            current.sessions.filter(
              (session) => session.platform === platform && session.startedAt < startedAt,
            ),
        });
        for (const session of sessions) byId.set(session.id, session);
        return {
          version: FILE_VERSION,
          events: [...current.events, ...records],
          sessions: [...byId.values()],
        };
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
        .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1))
        .slice(0, MAX_ACTIVITY_SESSIONS);
    },

    clear: () => change(() => emptyFile()),

    async flush(): Promise<void> {
      await changes;
      while (writing) await writing;
    },
  };
}
