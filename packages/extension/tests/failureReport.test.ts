import { describe, expect, it } from "vitest";
import { buildFailureReport } from "@lurkloot/shared/failureReport";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import type { CriticalHealthState } from "@lurkloot/shared/criticalHealth";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";

const FLAGGED: CriticalHealthState = {
  ...DEFAULT_CRITICAL_HEALTH,
  status: "flagged",
  reason: "page_context_churn",
  flaggedAt: "2026-07-25T11:59:00.000Z",
  breakerOpen: true,
  lastWatchedMinutes: 12,
  managedTabOpens: ["2026-07-25T11:58:00.000Z"],
  records: [
    { at: "2026-07-25T11:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" },
    { at: "2026-07-25T11:58:30.000Z", platform: "kick", kind: "api_error", code: "http_error", status: 503, detail: "Kick inventory failed" },
  ],
};

function state(health: CriticalHealthState = FLAGGED): SchedulerState {
  return { ...structuredClone(DEFAULT_STATE), criticalHealth: { kick: health } };
}

function input(overrides?: { state?: SchedulerState; events?: readonly ActivityHistoryRecord[] }) {
  return {
    platform: "kick" as const,
    version: "1.11.0",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    locale: "en",
    at: "2026-07-25T12:00:00.000Z",
    settings: DEFAULT_SETTINGS,
    state: overrides?.state ?? state(),
    events: overrides?.events ?? [],
  };
}

describe("failure report", () => {
  it("includes environment, detector state and the failure records", () => {
    const report = buildFailureReport(input());

    expect(report).toContain("1.11.0");
    expect(report).toContain("Mozilla/5.0");
    expect(report).toContain("page_context_churn");
    expect(report).toContain("background_rejected");
    expect(report).toContain("http_error");
    expect(report).toContain("503");
  });

  it("reports tablessMode, which a real report could not be diagnosed without", () => {
    expect(buildFailureReport(input())).toMatch(/tablessMode/);
  });

  it("stays useful when the ring buffer is empty", () => {
    const report = buildFailureReport(input({ state: state({ ...FLAGGED, records: [] }) }));

    expect(report).toContain("page_context_churn");
    expect(report).toContain("_none recorded_");
  });

  it("survives a platform with no detector state at all", () => {
    const bare = structuredClone(DEFAULT_STATE);

    expect(() => buildFailureReport({ ...input(), state: bare })).not.toThrow();
    expect(buildFailureReport({ ...input(), state: bare })).toContain("_no detector state_");
  });

  it("includes recent events and caps how many it prints", () => {
    const events: ActivityHistoryRecord[] = Array.from({ length: 60 }, (_unused, index) => ({
      id: `event-${index}`,
      at: `2026-07-25T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
      category: "diagnostic",
      level: "warn",
      message: `diagnostic ${index}`,
    }));

    const report = buildFailureReport(input({ events }));

    expect(report).toContain("diagnostic 59");
    expect(report).not.toContain("diagnostic 5\n");
    expect(report.split("\n").filter((line) => line.includes("diagnostic ")).length).toBeLessThanOrEqual(40);
  });

  it("never leaks credentials or tokens", () => {
    const report = buildFailureReport(input());

    expect(report).not.toMatch(/authToken|sessionToken|cookie|Bearer/i);
  });
});
