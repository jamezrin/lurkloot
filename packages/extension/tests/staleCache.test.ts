import { afterEach, describe, expect, it, vi } from "vitest";
import { StaleWhileRevalidateCache } from "@lurkloot/core/staleCache";

afterEach(() => vi.useRealTimers());

describe("StaleWhileRevalidateCache", () => {
  it("has nothing cached until the first refresh completes", async () => {
    const cache = new StaleWhileRevalidateCache<string[]>(1000);

    expect(cache.get()).toBeUndefined();
    expect(cache.isStale()).toBe(true);

    await cache.refreshOnce(async () => ["a"]);

    expect(cache.get()).toEqual(["a"]);
    expect(cache.isStale()).toBe(false);
  });

  it("shares one in-flight refresh across overlapping callers", async () => {
    const cache = new StaleWhileRevalidateCache<string[]>(1000);
    let resolvePerform: ((value: string[]) => void) | undefined;
    let calls = 0;
    const perform = () => {
      calls += 1;
      return new Promise<string[]>((resolve) => {
        resolvePerform = resolve;
      });
    };

    const first = cache.refreshOnce(perform);
    const second = cache.refreshOnce(perform);

    expect(calls).toBe(1);
    resolvePerform?.(["shared"]);
    await Promise.all([first, second]);

    expect(cache.get()).toEqual(["shared"]);
  });

  it("reports stale once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    const cache = new StaleWhileRevalidateCache<string[]>(1000);
    await cache.refreshOnce(async () => ["a"]);

    expect(cache.isStale()).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(cache.isStale()).toBe(true);
    // A stale cache still serves its last value; staleness only signals that a
    // refresh should be kicked off, never that the value should be discarded.
    expect(cache.get()).toEqual(["a"]);
  });

  it("clears the in-flight guard after a refresh settles, so the next refresh runs fresh", async () => {
    const cache = new StaleWhileRevalidateCache<string[]>(1000);
    let calls = 0;
    const perform = async () => {
      calls += 1;
      return [`call-${calls}`];
    };

    await cache.refreshOnce(perform);
    await cache.refreshOnce(perform);

    expect(calls).toBe(2);
  });
});
