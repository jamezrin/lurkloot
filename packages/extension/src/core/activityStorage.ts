import type { ActivityPage, ActivityQuery } from "@lurkloot/shared/messages";
import type {
  ActivityHistoryRecord,
  EngineEvent,
  EventCategory,
  StoredEngineEvent,
  StoredLegacyEvent,
} from "@lurkloot/shared/events";

const DATABASE_NAME = "lurkloot-activity";
const DATABASE_VERSION = 2;
const EVENT_STORE = "events";
const META_STORE = "meta";
const CATEGORY_INDEX = "category_at_id";
const PLATFORM_CATEGORY_INDEX = "platform_category_at_id";
const LAST_PRUNED_AT = "lastPrunedAt";
const MAX_RECORDS_PER_CATEGORY = 2_000;
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 100;

type ActivityCursor = [at: string, id: string];
type MetaRecord = { key: string; value: string };

function encodeCursor([at, id]: ActivityCursor): string {
  return encodeURIComponent(JSON.stringify([at, id]));
}

function decodeCursor(value: string): ActivityCursor {
  const decoded = JSON.parse(decodeURIComponent(value)) as unknown;
  if (!Array.isArray(decoded) || decoded.length !== 2
    || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
    throw new Error("Invalid activity cursor");
  }
  return [decoded[0], decoded[1]];
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function categoryRange(category: EventCategory): IDBKeyRange {
  return IDBKeyRange.bound([category], [category, []]);
}

function retentionMs(category: EventCategory): number {
  return category === "activity" ? ACTIVITY_RETENTION_MS : DIAGNOSTIC_RETENTION_MS;
}

export interface ActivityRepository {
  open(): Promise<IDBDatabase>;
  append(events: readonly EngineEvent[]): Promise<void>;
  importLegacy(events: readonly StoredLegacyEvent[]): Promise<void>;
  load(query: ActivityQuery): Promise<ActivityPage>;
  clear(): Promise<void>;
  prune(): Promise<void>;
  count(category: EventCategory): Promise<number>;
  close(): void;
  deleteDatabase(): Promise<void>;
  closeForVersionChangeForTest(): void;
  failNextOpenForTest(): void;
}

class IndexedDbActivityRepository implements ActivityRepository {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private database: IDBDatabase | undefined;
  private prunePromise: Promise<void> | undefined;
  private failNextOpen = false;

  constructor(private readonly databaseName: string) {}

  open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = this.openFresh().catch((error: unknown) => {
      this.databasePromise = undefined;
      throw error;
    });
    return this.databasePromise;
  }

  private openFresh(): Promise<IDBDatabase> {
    if (this.failNextOpen) {
      this.failNextOpen = false;
      return Promise.reject(new Error("Simulated IndexedDB open failure"));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const existingEventStore = database.objectStoreNames.contains(EVENT_STORE);
        const eventStore = existingEventStore
          ? request.transaction!.objectStore(EVENT_STORE)
          : database.createObjectStore(EVENT_STORE, { keyPath: "id" });
        for (const indexName of Array.from(eventStore.indexNames)) eventStore.deleteIndex(indexName);
        eventStore.createIndex(CATEGORY_INDEX, ["category", "at", "id"]);
        eventStore.createIndex(PLATFORM_CATEGORY_INDEX, ["platform", "category", "at", "id"]);
        if (existingEventStore) {
          const cursorRequest = eventStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            cursor.update({
              ...value,
              category: value.category ?? "diagnostic",
              legacy: true,
            });
            cursor.continue();
          };
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        this.database = database;
        database.onversionchange = () => {
          if (this.database === database) this.database = undefined;
          this.databasePromise = undefined;
          database.close();
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open the activity database"));
      // Keep a blocked request pending. Rejecting cannot cancel an IDB open;
      // its later success would otherwise create an untracked connection.
      request.onblocked = () => undefined;
    });
  }

  async append(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0) return;
    const writtenAt = new Date().toISOString();
    const stored: StoredEngineEvent[] = events.map((event, index) => {
      // Prefer when the event was emitted; the batch write time is only a
      // fallback for events that reach storage without one.
      const { emittedAt, ...rest } = event;
      const at = emittedAt ?? writtenAt;
      return {
        ...rest,
        // The index keeps events that share a timestamp sorting by emission
        // order, since load() falls back to comparing ids when `at` ties.
        id: `${at}-${String(index).padStart(6, "0")}-${crypto.randomUUID()}`,
        at,
        ...(event.data ? { data: { ...event.data } } : {}),
      };
    }) as StoredEngineEvent[];
    await this.putAll(stored);
    await this.pruneIfDue();
  }

  async importLegacy(events: readonly StoredLegacyEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.putAll(events);
    await this.pruneIfDue();
  }

  private async putAll(events: readonly ActivityHistoryRecord[]): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    const done = transactionDone(transaction);
    try {
      for (const event of events) store.put(event);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Preserve the original synchronous enqueue error.
      }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }

  async load(query: ActivityQuery): Promise<ActivityPage> {
    const database = await this.open();
    const transaction = database.transaction(EVENT_STORE, "readonly");
    const index = transaction.objectStore(EVENT_STORE).index(CATEGORY_INDEX);
    const cutoff = new Date(Date.now() - retentionMs(query.category)).toISOString();
    const lower: [EventCategory, string, string] = [query.category, cutoff, ""];
    const range = query.cursor
      ? IDBKeyRange.bound(lower, [query.category, ...decodeCursor(query.cursor)], false, true)
      : IDBKeyRange.bound(lower, [query.category, []]);
    const request = index.openCursor(range, "prev");
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const events: ActivityHistoryRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("Could not read activity"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const event = cursor.value as ActivityHistoryRecord;
        if (!query.platform || !event.platform || event.platform === query.platform) {
          events.push(event);
          if (events.length === limit + 1) {
            resolve();
            return;
          }
        }
        cursor.continue();
      };
    });
    await transactionDone(transaction);

    const hasMore = events.length > limit;
    if (hasMore) events.pop();
    const last = events.at(-1);
    return {
      events,
      ...(hasMore && last ? { nextCursor: encodeCursor([last.at, last.id]) } : {}),
    };
  }

  async clear(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([EVENT_STORE, META_STORE], "readwrite");
    transaction.objectStore(EVENT_STORE).clear();
    transaction.objectStore(META_STORE).clear();
    await transactionDone(transaction);
  }

  async count(category: EventCategory): Promise<number> {
    const database = await this.open();
    const transaction = database.transaction(EVENT_STORE, "readonly");
    const count = await requestResult(transaction.objectStore(EVENT_STORE).index(CATEGORY_INDEX).count(categoryRange(category)));
    await transactionDone(transaction);
    return count;
  }

  async prune(): Promise<void> {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = this.pruneNow().finally(() => {
      this.prunePromise = undefined;
    });
    return this.prunePromise;
  }

  private async pruneIfDue(): Promise<void> {
    if (this.prunePromise) return this.prunePromise;
    const database = await this.open();
    const transaction = database.transaction(META_STORE, "readonly");
    const record = await requestResult(transaction.objectStore(META_STORE).get(LAST_PRUNED_AT)) as MetaRecord | undefined;
    await transactionDone(transaction);
    const lastPrunedAt = record ? Date.parse(record.value) : Number.NaN;
    if (!Number.isFinite(lastPrunedAt) || Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      await this.prune();
    }
  }

  private async pruneNow(): Promise<void> {
    for (const category of ["activity", "diagnostic"] as const) {
      const cutoff = new Date(Date.now() - retentionMs(category)).toISOString();
      await this.deleteExpired(category, cutoff);
      await this.deleteExcess(category);
    }
    const database = await this.open();
    const transaction = database.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put({ key: LAST_PRUNED_AT, value: new Date().toISOString() } satisfies MetaRecord);
    await transactionDone(transaction);
  }

  private async deleteExpired(category: EventCategory, cutoff: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    const range = IDBKeyRange.bound([category], [category, cutoff, ""], false, true);
    const request = store.index(CATEGORY_INDEX).openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  }

  private async deleteExcess(category: EventCategory): Promise<void> {
    const database = await this.open();
    const countTransaction = database.transaction(EVENT_STORE, "readonly");
    const count = await requestResult(countTransaction.objectStore(EVENT_STORE).index(CATEGORY_INDEX).count(categoryRange(category)));
    await transactionDone(countTransaction);
    let excess = count - MAX_RECORDS_PER_CATEGORY;
    if (excess <= 0) return;

    const deleteTransaction = database.transaction(EVENT_STORE, "readwrite");
    const store = deleteTransaction.objectStore(EVENT_STORE);
    const request = store.index(CATEGORY_INDEX).openKeyCursor(categoryRange(category), "next");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || excess <= 0) return;
      store.delete(cursor.primaryKey);
      excess -= 1;
      cursor.continue();
    };
    await transactionDone(deleteTransaction);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.databasePromise = undefined;
  }

  async deleteDatabase(): Promise<void> {
    this.close();
    await requestResult(indexedDB.deleteDatabase(this.databaseName));
  }

  closeForVersionChangeForTest(): void {
    const database = this.database;
    if (!database) return;
    this.database = undefined;
    this.databasePromise = undefined;
    database.close();
  }

  failNextOpenForTest(): void {
    this.close();
    this.failNextOpen = true;
  }
}

const repository = new IndexedDbActivityRepository(DATABASE_NAME);

export function createActivityRepositoryForTest(databaseName: string): ActivityRepository {
  return new IndexedDbActivityRepository(databaseName);
}

export function appendActivityEvents(events: readonly EngineEvent[]): Promise<void> {
  return repository.append(events);
}

export function importLegacyActivityEvents(events: readonly StoredLegacyEvent[]): Promise<void> {
  return repository.importLegacy(events);
}

export function loadActivityEvents(query: ActivityQuery): Promise<ActivityPage> {
  return repository.load(query);
}

export function clearActivityEvents(): Promise<void> {
  return repository.clear();
}
