import "fake-indexeddb/auto";
import type { EngineEvent, StoredLegacyEvent } from "@lurkloot/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivityRepositoryForTest, type ActivityRepository } from "../src/core/activityStorage";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function activityEvent(rewardId: string, platform: "twitch" | "kick" = "twitch"): EngineEvent {
  return {
    category: "activity",
    code: "reward_claimed",
    level: "info",
    platform,
    data: {
      campaignId: `campaign-${rewardId}`,
      campaignName: `Campaign ${rewardId}`,
      rewardId,
      rewardName: `Reward ${rewardId}`,
      method: "automatic",
    },
  };
}

function diagnosticEvent(index: number): EngineEvent {
  return {
    category: "diagnostic",
    level: "debug",
    message: `diagnostic-${index}`,
    data: { index },
  };
}

describe("activity repository", () => {
  let repository: ActivityRepository;
  let databaseName: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    databaseName = `activity-${crypto.randomUUID()}`;
    repository = createActivityRepositoryForTest(databaseName);
  });

  afterEach(async () => {
    await repository.deleteDatabase();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }, 30_000);

  // A tick emits its events over real time (an integrity wait alone can take
  // 12s) but persists them in one batch. Stamping the batch time onto all of
  // them made every event in an exported log share one timestamp, so durations
  // were unrecoverable exactly when they mattered.
  it("keeps the time each event was emitted rather than the batch write time", async () => {
    const first = new Date(NOW.getTime() - 24_000).toISOString();
    const second = new Date(NOW.getTime() - 12_000).toISOString();

    await repository.append([
      { ...diagnosticEvent(1), emittedAt: first },
      { ...diagnosticEvent(2), emittedAt: second },
      diagnosticEvent(3),
    ]);

    const stored = (await repository.load({ category: "diagnostic" })).events;
    const byMessage = new Map(stored.map((event) => [event.message, event.at]));
    expect(byMessage.get("diagnostic-1")).toBe(first);
    expect(byMessage.get("diagnostic-2")).toBe(second);
    // No emittedAt: falls back to the write time, which is all we know.
    expect(byMessage.get("diagnostic-3")).toBe(NOW.toISOString());
    expect(new Set(stored.map((event) => event.at)).size).toBe(3);
  }, 30_000);

  it("round-trips diagnostic controller and tick correlation fields", async () => {
    await repository.append([{
      category: "diagnostic",
      level: "debug",
      message: "correlated diagnostic",
      controllerRunId: "controller-run-id",
      globalTickId: 42,
      platformTickId: 7,
    }]);

    const [stored] = (await repository.load({ category: "diagnostic" })).events;

    expect(stored).toMatchObject({
      controllerRunId: "controller-run-id",
      globalTickId: 42,
      platformTickId: 7,
    });
  });

  it("keeps activity when diagnostics exceed their independent cap", async () => {
    await repository.append([activityEvent("a")]);
    await repository.append(Array.from({ length: 2_001 }, (_, index) => diagnosticEvent(index)));
    await repository.prune();

    expect((await repository.load({ category: "activity" })).events.map((event) => event.data))
      .toContainEqual(expect.objectContaining({ rewardId: "a" }));
    expect(await repository.count("diagnostic")).toBe(2_000);
    expect((await repository.load({ category: "diagnostic", limit: 100 })).events).toHaveLength(100);
  }, 30_000);

  it("does not double-count expired rows while enforcing the cap", async () => {
    await repository.importLegacy([
      ...Array.from({ length: 100 }, (_, index): StoredLegacyEvent => ({
        id: `expired-${String(index).padStart(4, "0")}`,
        at: new Date(NOW.getTime() - 31 * DAY_MS - index).toISOString(),
        category: "activity",
        level: "info",
        message: "expired",
        legacy: true,
      })),
      ...Array.from({ length: 2_000 }, (_, index): StoredLegacyEvent => ({
        id: `current-${String(index).padStart(4, "0")}`,
        at: new Date(NOW.getTime() - DAY_MS + index).toISOString(),
        category: "activity",
        level: "info",
        message: "current",
        legacy: true,
      })),
    ]);

    await repository.prune();

    expect(await repository.count("activity")).toBe(2_000);
  }, 30_000);

  it("paginates every record sharing the same millisecond", async () => {
    await repository.append([activityEvent("a"), activityEvent("b"), activityEvent("c")]);

    const first = await repository.load({ category: "activity", limit: 2 });
    const second = await repository.load({ category: "activity", limit: 2, cursor: first.nextCursor });

    expect(first.nextCursor).toBeDefined();
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(3);
  });

  it("excludes expired records even before scheduled pruning runs", async () => {
    await repository.importLegacy([
      { id: "expired", at: new Date(NOW.getTime() - 31 * DAY_MS).toISOString(), category: "activity", level: "info", message: "expired", legacy: true },
      { id: "current", at: new Date(NOW.getTime() - DAY_MS).toISOString(), category: "activity", level: "info", message: "current", legacy: true },
    ]);

    expect((await repository.load({ category: "activity" })).events.map(({ id }) => id)).toEqual(["current"]);
  });

  it("expires diagnostics after 7 days while retaining same-age activity", async () => {
    await repository.append([activityEvent("prune-marker")]);
    const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
    await repository.importLegacy([
      { id: "old-activity", at: eightDaysAgo, category: "activity", level: "info", message: "activity", legacy: true },
      { id: "old-diagnostic", at: eightDaysAgo, category: "diagnostic", level: "info", message: "diagnostic", legacy: true },
    ]);

    expect((await repository.load({ category: "activity" })).events.map(({ id }) => id)).toContain("old-activity");
    expect((await repository.load({ category: "diagnostic" })).events).toEqual([]);
    expect(await repository.count("diagnostic")).toBe(1);

    await repository.prune();

    expect(await repository.count("diagnostic")).toBe(0);
    expect(await repository.count("activity")).toBe(2);
  });

  it("reopens after versionchange closes the cached connection", async () => {
    await repository.open();
    repository.closeForVersionChangeForTest();

    await expect(repository.load({ category: "activity" })).resolves.toBeDefined();
  });

  it("opens the version 2 compound-index schema", async () => {
    const database = await repository.open();
    const transaction = database.transaction(["events", "meta"], "readonly");
    const indexes = Array.from(transaction.objectStore("events").indexNames);

    expect(database.version).toBe(2);
    expect(indexes).toEqual(["category_at_id", "platform_category_at_id"]);
  });

  it("normalizes category-less version 1 rows during the version 2 upgrade", async () => {
    const versionOne = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("events", { keyPath: "id" });
        store.createIndex("at", "at");
        store.createIndex("platform", "platform");
        store.createIndex("category", "category");
        store.put({
          id: "v1-diagnostic",
          at: new Date(NOW.getTime() - DAY_MS).toISOString(),
          level: "info",
          message: "legacy diagnostic",
        });
        store.put({
          id: "v1-expired-diagnostic",
          at: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
          level: "info",
          message: "expired legacy diagnostic",
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    versionOne.close();

    const page = await repository.load({ category: "diagnostic" });

    expect(page.events).toEqual([expect.objectContaining({
      id: "v1-diagnostic",
      category: "diagnostic",
      legacy: true,
    })]);
    expect(await repository.count("diagnostic")).toBe(2);
    await repository.prune();
    expect(await repository.count("diagnostic")).toBe(1);
  });

  it("keeps a blocked upgrade pending and leaves no late connection behind", async () => {
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const versionChange = new Promise<void>((resolve) => {
      blocker.onversionchange = () => resolve();
    });
    let settledWhileBlocked = false;
    const openResult = repository.open().then(
      (database) => ({ status: "resolved" as const, database }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    void openResult.then(() => {
      settledWhileBlocked = true;
    });
    await versionChange;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const wasSettledWhileBlocked = settledWhileBlocked;
    blocker.close();
    const result = await openResult;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Open version 3 as an external lifecycle probe. Any abandoned v2
    // connection must close on versionchange or this request remains blocked.
    repository.close();
    const probe = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    probe.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    expect(wasSettledWhileBlocked).toBe(false);
    expect(result.status).toBe("resolved");
  });

  it("resets a rejected open so the next operation can retry", async () => {
    repository.failNextOpenForTest();

    await expect(repository.open()).rejects.toThrow("Simulated IndexedDB open failure");
    await expect(repository.open()).resolves.toBeDefined();
  });

  it("orders newest records first and clears all records", async () => {
    await repository.importLegacy([
      { id: "older", at: new Date(NOW.getTime() - 2_000).toISOString(), category: "activity", level: "info", message: "older", legacy: true },
      { id: "newer", at: new Date(NOW.getTime() - 1_000).toISOString(), category: "activity", level: "info", message: "newer", legacy: true },
    ]);

    expect((await repository.load({ category: "activity" })).events.map(({ id }) => id)).toEqual(["newer", "older"]);
    await repository.clear();
    expect((await repository.load({ category: "activity" })).events).toEqual([]);
  });

  it("includes platform-less global events in a platform-filtered activity page", async () => {
    await repository.append([
      activityEvent("twitch", "twitch"),
      activityEvent("kick", "kick"),
      { category: "activity", code: "interruption", level: "warn", data: { reason: "runtime_restart" } },
    ]);

    const page = await repository.load({ category: "activity", platform: "twitch" });

    expect(page.events).toHaveLength(2);
    expect(page.events.some((event) => event.platform === "kick")).toBe(false);
    expect(page.events.some((event) => event.platform == null)).toBe(true);
  });

  it("paginates case-insensitive diagnostic message matches within a platform", async () => {
    await repository.append([
      { category: "diagnostic", level: "error", platform: "kick", message: "Kick transport failed" },
      { category: "diagnostic", level: "info", platform: "kick", message: "Twitch connected" },
      { category: "diagnostic", level: "info", platform: "kick", message: "kick retry scheduled" },
      { category: "diagnostic", level: "info", platform: "twitch", message: "KICK connection from Twitch" },
      { category: "diagnostic", level: "error", message: "Kick global error" },
    ]);

    const first = await repository.load({ category: "diagnostic", platform: "kick", query: "KICK", limit: 2 });
    const second = await repository.load({
      category: "diagnostic",
      platform: "kick",
      query: "KICK",
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.events.map((event) => event.message)).toEqual([
      "Kick global error",
      "kick retry scheduled",
    ]);
    expect(second.events.map((event) => event.message)).toEqual(["Kick transport failed"]);
    expect([...first.events, ...second.events].some((event) => event.message === "KICK connection from Twitch")).toBe(false);
  });

  it("exports every retained diagnostic for a platform without the page cap or search filter", async () => {
    await repository.append([
      ...Array.from({ length: 101 }, (_, index) => ({
        category: "diagnostic" as const,
        level: "debug" as const,
        platform: "kick" as const,
        message: `kick-${String(index).padStart(3, "0")}`,
        emittedAt: new Date(NOW.getTime() - index * 1_000).toISOString(),
      })),
      {
        category: "diagnostic",
        level: "info",
        platform: "twitch",
        message: "twitch-only",
        emittedAt: NOW.toISOString(),
      },
      {
        category: "diagnostic",
        level: "error",
        message: "global",
        emittedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      },
    ]);

    const page = await repository.load({ category: "diagnostic", platform: "kick", limit: 100 });
    const searched = await repository.load({ category: "diagnostic", platform: "kick", query: "global" });
    const exported = await repository.exportDiagnostics("kick");

    expect(page.events).toHaveLength(100);
    expect(page.nextCursor).toBeDefined();
    expect(searched.events.map((event) => event.message)).toEqual(["global"]);
    expect(exported.map((event) => event.message)).toEqual([
      "global",
      ...Array.from({ length: 101 }, (_, index) => `kick-${String(index).padStart(3, "0")}`),
    ]);
    expect(exported.some((event) => event.message === "twitch-only")).toBe(false);
  });

  it("omits diagnostics past the seven-day cutoff from a full export", async () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
    await repository.importLegacy([
      { id: "old", at: eightDaysAgo, category: "diagnostic", level: "info", message: "expired", legacy: true },
      { id: "current", at: NOW.toISOString(), category: "diagnostic", level: "info", platform: "kick", message: "current", legacy: true },
    ]);

    expect((await repository.exportDiagnostics("kick")).map((event) => event.message)).toEqual(["current"]);
  });

  it("matches English diagnostic text independently of the browser locale", async () => {
    expect("KICK".toLocaleLowerCase("tr")).not.toBe("kick".toLocaleLowerCase("tr"));
    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (
      this: string,
      locales?: Intl.LocalesArgument,
    ) {
      return originalToLocaleLowerCase.call(this, locales ?? "tr");
    });
    await repository.append([{
      category: "diagnostic",
      level: "debug",
      platform: "kick",
      message: "lowercase kick diagnostic",
    }]);

    const page = await repository.load({
      category: "diagnostic",
      platform: "kick",
      query: "KICK",
    });

    expect(page.events.map((event) => event.message)).toEqual(["lowercase kick diagnostic"]);
  });

  it("aborts the entire legacy import when a later value cannot be cloned", async () => {
    const invalid = {
      id: "invalid",
      at: NOW.toISOString(),
      category: "diagnostic",
      level: "info",
      message: "invalid",
      legacy: true,
      data: { invalid: () => undefined },
    } as unknown as StoredLegacyEvent;

    await expect(repository.importLegacy([
      { id: "valid", at: NOW.toISOString(), category: "diagnostic", level: "info", message: "valid", legacy: true },
      invalid,
    ])).rejects.toBeInstanceOf(DOMException);

    expect(await repository.count("diagnostic")).toBe(0);
  });
});
