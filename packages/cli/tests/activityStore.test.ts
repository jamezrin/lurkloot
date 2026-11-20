import { stateSidecarPath } from "../src/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTIVITY_RETENTION_MS,
  InvalidActivityCursorError,
  MAX_ACTIVITY_RECORDS_PER_CATEGORY,
} from "@lurkloot/shared/activityHistory";
import type { ActivityHistoryRecord, EngineEvent } from "@lurkloot/shared/events";
import {
  ACTIVITY_WRITE_INTERVAL_MS,
  type CliActivityHistory,
  createFileActivityHistory,
} from "../src/activityStore";

let dir: string;
let path: string;
// Every store a test made, flushed before its directory goes.
const stores: CliActivityHistory[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-activity-"));
  path = join(dir, "activity.json");
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await rm(dir, { recursive: true, force: true });
});

function track(store: CliActivityHistory): CliActivityHistory {
  stores.push(store);
  return store;
}

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function claimed(rewardName: string, emittedAt: string, sessionId?: string | null): EngineEvent {
  return {
    category: "activity",
    code: "reward_claimed",
    level: "info",
    platform: "twitch",
    data: {
      campaignId: "campaign",
      campaignName: "Campaign",
      rewardId: rewardName,
      rewardName,
      method: "automatic",
    },
    emittedAt,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function rewardName(event: ActivityHistoryRecord | undefined): string | undefined {
  return (event?.data as { rewardName?: string } | undefined)?.rewardName;
}

function sessionStarted(sessionId: string, startedAt: string): EngineEvent {
  return {
    category: "activity",
    code: "session_started",
    level: "info",
    platform: "twitch",
    sessionId,
    data: { sessionId, startedAt },
    emittedAt: startedAt,
  };
}

function history(options: { now?: () => number } = {}) {
  let id = 0;
  return track(
    createFileActivityHistory(path, {
      now: options.now ?? (() => NOW),
      randomId: () => String((id += 1)).padStart(8, "0"),
    }),
  );
}

describe("CLI activity history", () => {
  it("lives beside the state file", () => {
    expect(stateSidecarPath("/data/lurkloot/state.json", "activity")).toBe(
      "/data/lurkloot/activity.json",
    );
    // Two --state files in one directory keep two histories.
    expect(stateSidecarPath("/data/lurkloot/alt.json", "activity")).toBe(
      "/data/lurkloot/alt.json.activity.json",
    );
    expect(stateSidecarPath("/data/lurkloot/state.json", "diagnostics")).toBe(
      "/data/lurkloot/state.json.diagnostics.json",
    );
    expect(stateSidecarPath("/data/lurkloot/alt.json", "diagnostics")).toBe(
      "/data/lurkloot/alt.json.diagnostics.json",
    );
    expect(stateSidecarPath("/data/lurkloot/alt-state", "activity")).toBe(
      "/data/lurkloot/alt-state.activity.json",
    );
  });

  it("pages activity newest first with a cursor", async () => {
    const store = history();
    await store.append([
      claimed("first", at(-3_000)),
      claimed("second", at(-2_000)),
      claimed("third", at(-1_000)),
    ]);

    const first = await store.load({ category: "activity", platform: "twitch", limit: 2 });
    expect(first.events.map((event) => rewardName(event))).toEqual(["third", "second"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await store.load({
      category: "activity",
      platform: "twitch",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.events.map((event) => rewardName(event))).toEqual(["first"]);
    expect(second.nextCursor).toBeUndefined();

    // A record with a platform is shown under its own platform only.
    expect((await store.load({ category: "activity", platform: "kick" })).events).toEqual([]);
  });

  it("keeps a fractional limit a bounded page", async () => {
    const store = history();
    await store.append([
      claimed("a", at(-3_000)),
      claimed("b", at(-2_000)),
      claimed("c", at(-1_000)),
    ]);
    const page = await store.load({ category: "activity", limit: 1.5 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("refuses a cursor it did not issue", async () => {
    const store = history();
    await expect(store.load({ category: "activity", cursor: "%%%" })).rejects.toBeInstanceOf(
      InvalidActivityCursorError,
    );
    await expect(
      store.load({ category: "activity", cursor: encodeURIComponent("[1]") }),
    ).rejects.toBeInstanceOf(InvalidActivityCursorError);
  });

  it("survives a restart", async () => {
    const store = history();
    await store.append([sessionStarted("s1", at(-5_000)), claimed("kept", at(-1_000), "s1")]);
    await store.close();

    const reopened = history();
    const page = await reopened.load({ category: "activity" });
    expect(page.events.map((event) => event.code)).toEqual(["reward_claimed", "session_started"]);
    const sessions = await reopened.loadSessions("twitch");
    expect(sessions).toEqual([
      expect.objectContaining({ id: "s1", startedAt: at(-5_000), rewardCounts: { drop: 1 } }),
    ]);
  });

  it("coalesces batches within the write interval and saves them when idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const store = history();
    try {
      await store.clear();
      await store.append([claimed("second", at(-2_000))]);
      await store.append([claimed("third", at(-1_000))]);
      expect((await store.load({ category: "activity" })).events).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(ACTIVITY_WRITE_INTERVAL_MS - 1);
      expect(await readFile(path, "utf8")).not.toContain("second");
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => {
        const saved = await readFile(path, "utf8");
        expect(saved).toContain("second");
        expect(saved).toContain("third");
      });
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  it("keeps interruption reasons but drops unstructured exception text", async () => {
    const store = history();
    await store.append([
      {
        category: "activity",
        code: "interruption",
        level: "error",
        platform: "twitch",
        data: { reason: "platform_error", detail: "request failed with OAuth private-token" },
      },
    ]);
    await store.close();
    const { events } = await history().load({ category: "activity" });
    expect(events[0]?.data).toEqual({ reason: "platform_error" });
    expect(await readFile(path, "utf8")).not.toContain("private-token");
  });

  it("preserves publisher link parameters and removes URL credentials", async () => {
    const store = history();
    const claim = claimed("reward", at(-1_000));
    if (claim.category !== "activity" || claim.code !== "reward_claimed") throw new Error();
    await store.append([
      {
        ...claim,
        data: {
          ...claim.data,
          campaignUrl: "https://example.com/campaign?campaign=launch#rewards",
          rewardImageUrl: "https://user:private-password@example.com/reward",
        },
      },
    ]);
    await store.close();
    const { events } = await history().load({ category: "activity" });
    expect(events[0]?.data).toHaveProperty(
      "campaignUrl",
      "https://example.com/campaign?campaign=launch#rewards",
    );
    expect(events[0]?.data).toHaveProperty("rewardImageUrl", "https://example.com/reward");
    expect(await readFile(path, "utf8")).not.toContain("private-");
  });

  it("stays within the shared record budget and retention", async () => {
    const store = history();
    const events = Array.from({ length: MAX_ACTIVITY_RECORDS_PER_CATEGORY + 50 }, (_, index) =>
      claimed(`reward-${index}`, at(-1_000_000 + index)),
    );
    await store.append([claimed("expired", at(-ACTIVITY_RETENTION_MS - 1_000)), ...events]);
    await store.close();

    const onDisk = JSON.parse(await readFile(path, "utf8")) as { events: unknown[] };
    expect(onDisk.events).toHaveLength(MAX_ACTIVITY_RECORDS_PER_CATEGORY);
    const newest = await store.load({ category: "activity", limit: 1 });
    expect(rewardName(newest.events[0])).toBe(`reward-${MAX_ACTIVITY_RECORDS_PER_CATEGORY + 49}`);
    const all = JSON.stringify(onDisk);
    expect(all).not.toContain('"expired"');
    expect(all).not.toContain('"reward-49"');
    expect(all).toContain('"reward-50"');
  });

  it("drops sessions that ended past the retention, keeping an open one", async () => {
    let clock = NOW;
    const store = history({ now: () => clock });
    await store.append([
      sessionStarted("old", at(-10_000)),
      {
        category: "activity",
        code: "session_ended",
        level: "info",
        platform: "twitch",
        sessionId: "old",
        data: { sessionId: "old", startedAt: at(-10_000), endedAt: at(-9_000), reason: "disabled" },
        emittedAt: at(-9_000),
      },
      sessionStarted("open", at(-8_000)),
    ]);
    expect((await store.loadSessions("twitch")).map((session) => session.id)).toEqual([
      "open",
      "old",
    ]);

    clock = NOW + ACTIVITY_RETENTION_MS;
    await store.append([claimed("later", new Date(clock).toISOString(), "open")]);
    expect((await store.loadSessions("twitch")).map((session) => session.id)).toEqual(["open"]);
  });

  it("folds points into the session without storing them as rows", async () => {
    const store = history();
    await store.append([
      sessionStarted("s1", at(-5_000)),
      {
        category: "activity",
        code: "points_earned",
        level: "info",
        platform: "twitch",
        sessionId: "s1",
        data: { channelId: "42", channelLogin: "someone", reason: "WATCH", amount: 10 },
        emittedAt: at(-4_000),
      },
    ]);
    const page = await store.load({ category: "activity" });
    expect(page.events.map((event) => event.code)).toEqual(["session_started"]);
    const [session] = await store.loadSessions("twitch");
    expect(session?.tallies["channel_points:42"]?.total).toBe(10);
  });

  it("ends a session left open when the platform starts its next one", async () => {
    const store = history();
    await store.append([sessionStarted("s1", at(-5_000))]);
    await store.append([sessionStarted("s2", at(-1_000))]);
    const sessions = await store.loadSessions("twitch");
    expect(sessions.map((session) => [session.id, session.endedAt])).toEqual([
      ["s2", undefined],
      ["s1", at(-1_000)],
    ]);
  });

  it("clears events and sessions, on disk too", async () => {
    const store = history();
    await store.append([sessionStarted("s1", at(-5_000)), claimed("gone", at(-1_000), "s1")]);
    await store.close();
    const live = history();
    await live.append([claimed("queued", at(-500))]);
    await live.clear();

    expect((await live.load({ category: "activity" })).events).toEqual([]);
    expect(await live.loadSessions("twitch")).toEqual([]);
    const reopened = history();
    expect((await reopened.load({ category: "activity" })).events).toEqual([]);
    expect(await reopened.loadSessions("twitch")).toEqual([]);
  });

  it("writes atomically and leaves no temporary file", async () => {
    const store = history();
    await store.append([claimed("one", at(-2_000))]);
    await store.append([claimed("two", at(-1_000))]);
    await store.close();
    expect(await readdir(dir)).toEqual(["activity.json"]);
  });

  it("starts empty from an unreadable file and reports it", async () => {
    await writeFile(path, "{not json");
    const onLoadError = vi.fn();
    const store = track(createFileActivityHistory(path, { onLoadError, now: () => NOW }));
    expect((await store.load({ category: "activity" })).events).toEqual([]);
    expect(onLoadError).toHaveBeenCalledOnce();

    await store.append([claimed("fresh", at(-1_000))]);
    await store.close();
    expect((await history().load({ category: "activity" })).events).toHaveLength(1);
  });

  it("rejects snapshots larger than 4 MiB", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        events: [],
        sessions: [],
        padding: " ".repeat(4 * 1024 * 1024),
      }),
    );
    const onLoadError = vi.fn();
    const store = track(createFileActivityHistory(path, { onLoadError }));
    expect((await store.load({ category: "activity" })).events).toEqual([]);
    expect(onLoadError).toHaveBeenCalledOnce();
  });

  it("leaves an unsupported version on disk after clear, append and close", async () => {
    const newer = JSON.stringify({ version: 2, records: ["newer history"] });
    await writeFile(path, newer);
    const store = history();
    await expect(store.clear()).rejects.toThrow("version");
    await store.append([claimed("live only", at(-1_000))]);
    expect((await store.load({ category: "activity" })).events).toHaveLength(1);
    await store.close();
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it("keeps the history in memory when a write fails, and writes it next time", async () => {
    const blocked = join(dir, "missing-dir-is-a-file");
    await writeFile(blocked, "");
    const onSaveError = vi.fn();
    const file = join(blocked, "activity.json");
    const store = track(
      createFileActivityHistory(file, {
        onSaveError,
        now: () => NOW,
      }),
    );
    await store.append([claimed("kept", at(-1_000))]);
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalled());
    expect((await store.load({ category: "activity" })).events).toHaveLength(1);
    await rm(blocked);
    await store.append([claimed("later", at(-500))]);
    await store.close();
    expect(await readFile(file, "utf8")).toContain("kept");
    expect(await readFile(file, "utf8")).toContain("later");
  });

  it("retains history if the atomic clear cannot be saved", async () => {
    const blocked = join(dir, "state-directory");
    await writeFile(blocked, "");
    const store = track(
      createFileActivityHistory(join(blocked, "activity.json"), { now: () => NOW }),
    );
    await store.append([claimed("kept", at(-1_000))]);
    await expect(store.clear()).rejects.toThrow();
    expect((await store.load({ category: "activity" })).events).toHaveLength(1);
  });
});

// What a history is lives once, in @lurkloot/shared/activityHistory: each
// host's backend calls its fold and retention rather than restating them.
describe("one activity history implementation", () => {
  const backends = [
    resolve(__dirname, "../src/activityStore.ts"),
    resolve(__dirname, "../../extension/src/core/activityStorage.ts"),
  ];

  it.each(backends)("%s folds batches and applies retention through the shared module", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/from "@lurkloot\/shared\/activityHistory"/);
    expect(source).toContain("foldActivityBatch(");
    expect(source).toContain("activityRetentionCutoff(");
    expect(source).not.toContain("foldSessionEvent");
    expect(source).not.toMatch(/RETENTION_MS\s*=/);
  });
});
