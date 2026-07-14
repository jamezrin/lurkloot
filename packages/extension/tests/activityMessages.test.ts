import { describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import { createActivityEventReporter, createActivityMessageHandler } from "../src/core/activityMessages";

describe("activity message routing", () => {
  it("handles history messages through the extension repository", async () => {
    const page = { events: [], nextCursor: undefined };
    const load = vi.fn(async () => page);
    const clear = vi.fn(async () => undefined);
    const handler = createActivityMessageHandler({ load, clear });

    await expect(handler({ type: "getActivity", category: "activity", platform: "twitch", limit: 80 }))
      .resolves.toBe(page);
    await expect(handler({ type: "clearActivity" })).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledWith({ category: "activity", platform: "twitch", limit: 80 });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("returns undefined without using the repository for non-activity messages", async () => {
    const load = vi.fn();
    const clear = vi.fn();
    const handler = createActivityMessageHandler({ load, clear });

    await expect(handler({ type: "getSnapshot" })).resolves.toBeUndefined();

    expect(load).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("activity event reporting", () => {
  const activity: EngineEvent = {
    category: "activity",
    code: "interruption",
    level: "warn",
    data: { reason: "runtime_restart" },
  };
  const diagnostic: EngineEvent = {
    category: "diagnostic",
    level: "debug",
    message: "detail",
  };

  it("always persists activity and omits diagnostics when logging is disabled", async () => {
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => false,
      append,
    });

    await report([diagnostic, activity]);

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([activity]);
  });

  it("persists one ordered batch when diagnostic logging is enabled", async () => {
    const append = vi.fn(async () => undefined);
    const report = createActivityEventReporter({
      loadDiagnosticLogging: async () => true,
      append,
    });

    await report([diagnostic, activity]);

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([diagnostic, activity]);
  });
});
