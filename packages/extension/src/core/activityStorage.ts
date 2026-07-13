import type { ActivityPage } from "@lurkloot/shared/messages";
import type { EventCategory, EventLogEntry, Platform } from "@lurkloot/shared/models";

const DATABASE_NAME = "lurkloot-activity";
const DATABASE_VERSION = 1;
const STORE_NAME = "events";
const MAX_RECORDS = 2_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("at", "at");
      store.createIndex("platform", "platform");
      store.createIndex("category", "category");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("Could not open the activity database"));
    };
  });
  return databasePromise;
}

export async function appendActivityEvents(events: readonly EventLogEntry[]): Promise<void> {
  if (events.length === 0) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const event of events) store.put(event);
  await transactionDone(transaction);
  await pruneActivityEvents();
}

export async function loadActivityEvents(query: {
  platform?: Platform;
  category?: EventCategory;
  before?: string;
  limit?: number;
}): Promise<ActivityPage> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("at");
  const upperBound = query.before ? IDBKeyRange.upperBound(query.before, true) : undefined;
  const request = index.openCursor(upperBound, "prev");
  const limit = Math.min(100, Math.max(1, query.limit ?? 80));
  const events: EventLogEntry[] = [];
  let hasMore = false;

  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Could not read activity"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const event = cursor.value as EventLogEntry;
      const category = event.category ?? "diagnostic";
      const matches = (!query.platform || !event.platform || event.platform === query.platform)
        && (!query.category || category === query.category);
      if (matches && events.length < limit) events.push(event);
      else if (matches) {
        hasMore = true;
        resolve();
        return;
      }
      cursor.continue();
    };
  });
  await transactionDone(transaction);
  return { events, hasMore };
}

export async function clearActivityEvents(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
}

async function pruneActivityEvents(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const at = store.index("at");
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const stale = at.openKeyCursor(IDBKeyRange.upperBound(cutoff, true));
  stale.onsuccess = () => {
    const cursor = stale.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
  const count = await requestResult(store.count());
  let excess = Math.max(0, count - MAX_RECORDS);
  if (excess > 0) {
    const oldest = at.openKeyCursor(undefined, "next");
    oldest.onsuccess = () => {
      const cursor = oldest.result;
      if (!cursor || excess <= 0) return;
      store.delete(cursor.primaryKey);
      excess -= 1;
      cursor.continue();
    };
  }
  await transactionDone(transaction);
}
