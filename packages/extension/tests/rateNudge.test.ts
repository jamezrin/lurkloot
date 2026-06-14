import { describe, expect, it } from "vitest";
import { shouldShowRateNudge } from "@lurkloot/popup-ui/rateNudge";

describe("shouldShowRateNudge", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it("hides until the extension has been installed at least minDays", () => {
    expect(shouldShowRateNudge(daysAgo(1), "pending", now, 3)).toBe(false);
    expect(shouldShowRateNudge(daysAgo(3), "pending", now, 3)).toBe(true);
    expect(shouldShowRateNudge(daysAgo(10), "pending", now, 3)).toBe(true);
  });

  it("stays hidden once rated or dismissed, regardless of age", () => {
    expect(shouldShowRateNudge(daysAgo(30), "rated", now, 3)).toBe(false);
    expect(shouldShowRateNudge(daysAgo(30), "dismissed", now, 3)).toBe(false);
  });

  it("stays hidden when the install date is missing or unparseable", () => {
    expect(shouldShowRateNudge(undefined, "pending", now, 3)).toBe(false);
    expect(shouldShowRateNudge("not-a-date", "pending", now, 3)).toBe(false);
  });
});
