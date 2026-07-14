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

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    repository = createActivityRepositoryForTest(`activity-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await repository.deleteDatabase();
    vi.useRealTimers();
  }, 30_000);

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
});
