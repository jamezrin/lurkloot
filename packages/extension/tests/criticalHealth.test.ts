import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_HEALTH, normalizeCriticalHealth } from "@lurkloot/shared/criticalHealth";

describe("critical health normalization", () => {
  it("defaults to an unflagged, closed-breaker state", () => {
    expect(DEFAULT_CRITICAL_HEALTH).toEqual({
      status: "ok",
      failingMs: 0,
      failingTicks: 0,
      contextOpens: [],
      breakerOpen: false,
      records: [],
    });
  });

  it("restores a persisted flag while discarding malformed counters", () => {
    const restored = normalizeCriticalHealth({
      status: "flagged",
      reason: "page_context_churn",
      flaggedAt: "2026-07-25T10:00:00.000Z",
      failingMs: "nonsense",
      failingTicks: -4,
      contextOpens: ["2026-07-25T09:59:00.000Z", 42],
      breakerOpen: true,
      records: [{ at: "2026-07-25T09:58:00.000Z", platform: "kick", kind: "context_open", code: "background_rejected" }],
    });

    expect(restored.status).toBe("flagged");
    expect(restored.reason).toBe("page_context_churn");
    expect(restored.breakerOpen).toBe(true);
    expect(restored.failingMs).toBe(0);
    expect(restored.failingTicks).toBe(0);
    expect(restored.contextOpens).toEqual([]);
    expect(restored.records).toHaveLength(1);
  });

  it("drops an unknown status and every malformed record", () => {
    const restored = normalizeCriticalHealth({ status: "exploded", records: [{ kind: "api_error" }, "junk"] });

    expect(restored.status).toBe("ok");
    expect(restored.records).toEqual([]);
  });
});
