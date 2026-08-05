import { describe, expect, it } from "vitest";
import { isTimestampStale } from "@lurkloot/core/timestamps";

describe("isTimestampStale", () => {
  it("is stale when the timestamp cannot be parsed", () => {
    expect(isTimestampStale("not-a-date", 1000, Date.now())).toBe(true);
  });

  // A clock rollback (NTP correction, a suspended VM) can leave a self-written
  // stamp in the future. `Date.now() - parsed` would then be negative, passing
  // almost any elapsed-time bound, so a future stamp must be treated the same
  // as an unparseable one rather than as freshly written.
  it("is stale when the timestamp is in the future", () => {
    const now = Date.now();
    expect(isTimestampStale(new Date(now + 1).toISOString(), 1000, now)).toBe(true);
  });

  it("is not stale exactly at the parsed time", () => {
    const now = Date.now();
    expect(isTimestampStale(new Date(now).toISOString(), 1000, now)).toBe(false);
  });

  it("is not stale exactly at the max age boundary", () => {
    const now = Date.now();
    expect(isTimestampStale(new Date(now - 1000).toISOString(), 1000, now)).toBe(false);
  });

  it("is stale once elapsed time exceeds the max age", () => {
    const now = Date.now();
    expect(isTimestampStale(new Date(now - 1001).toISOString(), 1000, now)).toBe(true);
  });
});
