import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeJobScheduler } from "../src/runtime/jobs";

// Job-timing tests for the CLI's Node-timer job scheduler against the job
// scheduler semantics in @lurkloot/core's jobs.ts (#593). The extension's
// browser.alarms scheduler has its own in packages/extension/tests.

describe("Node job scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a periodic job once per period", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("tick", { periodInMinutes: 7 });

    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["tick"]);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(fired).toEqual(["tick", "tick", "tick"]);
    jobs.dispose();
  });

  it("clamps a period below the minimum, as browser alarms do", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("fast", { periodInMinutes: 0.01 });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(["fast"]);
    jobs.dispose();
  });

  it("replaces a job on ensure and restarts its period", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("tick", { periodInMinutes: 5 });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await jobs.ensure("tick", { periodInMinutes: 5 });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(["tick"]);
    expect(vi.getTimerCount()).toBe(1);
    jobs.dispose();
  });

  it("fires a one-shot job once and removes it; a past time fires at once", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("refresh", { when: Date.now() + 90_000 });
    await jobs.ensure("overdue", { when: Date.now() - 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual(["overdue"]);
    expect(await jobs.get("overdue")).toBeUndefined();
    expect(await jobs.get("refresh")).toEqual({ scheduledTime: Date.now() + 90_000 });

    await vi.advanceTimersByTimeAsync(90_000);
    expect(fired).toEqual(["overdue", "refresh"]);
    expect(await jobs.get("refresh")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired).toEqual(["overdue", "refresh"]);
    jobs.dispose();
  });

  it("reports the next fire time of a periodic job", async () => {
    const jobs = createNodeJobScheduler(() => undefined);
    const start = Date.now();
    await jobs.ensure("watch", { periodInMinutes: 1 });
    expect(await jobs.get("watch")).toEqual({ scheduledTime: start + 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await jobs.get("watch")).toEqual({ scheduledTime: start + 120_000 });
    expect(await jobs.get("missing")).toBeUndefined();
    jobs.dispose();
  });

  it("cancels idempotently and reports whether a job existed", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("tick", { periodInMinutes: 1 });

    expect(await jobs.cancel("tick")).toBe(true);
    expect(await jobs.cancel("tick")).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fires once, late, after the event loop was blocked for several periods", async () => {
    const fired: number[] = [];
    const jobs = createNodeJobScheduler(() => fired.push(Date.now()));
    const start = Date.now();
    await jobs.ensure("watch", { periodInMinutes: 1 });

    // A blocked loop (or a suspended machine) moves the clock without running
    // timers; the overdue timer then runs once, not once per missed minute.
    vi.setSystemTime(start + 5 * 60_000 + 10_000);
    await vi.advanceTimersToNextTimerAsync();
    expect(fired).toHaveLength(1);
    // The next fire is a full period after the late one.
    expect(await jobs.get("watch")).toEqual({ scheduledTime: fired[0]! + 60_000 });
    jobs.dispose();
  });

  it("delivers a fire while a previous run is still in progress", async () => {
    const runs: Array<() => void> = [];
    const jobs = createNodeJobScheduler(() => {
      void new Promise<void>((resolve) => runs.push(resolve));
    });
    await jobs.ensure("watch", { periodInMinutes: 1 });

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    // The scheduler does not wait for a run: jobs coalesce their own overlaps.
    expect(runs).toHaveLength(2);
    for (const resolve of runs) resolve();
    jobs.dispose();
  });

  it("stops every job on dispose and schedules nothing afterwards", async () => {
    const fired: string[] = [];
    const jobs = createNodeJobScheduler((name) => fired.push(name));
    await jobs.ensure("tick", { periodInMinutes: 1 });
    await jobs.ensure("refresh", { when: Date.now() + 1_000 });

    jobs.dispose();
    await jobs.ensure("late", { periodInMinutes: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await jobs.get("tick")).toBeUndefined();
  });

  it("keeps nothing across a restart: a new scheduler starts empty", async () => {
    const first = createNodeJobScheduler(() => undefined);
    await first.ensure("tick", { periodInMinutes: 1 });
    first.dispose();

    const restarted = createNodeJobScheduler(() => undefined);
    expect(await restarted.get("tick")).toBeUndefined();
    restarted.dispose();
  });
});
