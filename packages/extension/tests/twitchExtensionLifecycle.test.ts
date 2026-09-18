import { describe, expect, it, vi } from "vitest";
import { createTwitchExtensionLifecycle } from "../src/extensions/lifecycle";

describe("tabless provider lifecycle", () => {
  it("stops the previous channel before starting a replacement", async () => {
    const events: string[] = [];
    const lifecycle = createTwitchExtensionLifecycle(async (channel, signal) => {
      events.push(`start:${channel}`);
      signal.addEventListener("abort", () => events.push(`stop:${channel}`));
    });
    await lifecycle.select("one");
    await lifecycle.select("two");
    lifecycle.stop();
    expect(events).toEqual(["start:one", "stop:one", "start:two", "stop:two"]);
  });
  it("coalesces repeated selection and drops a cancelled initialization result", async () => {
    let resolve!: () => void;
    const cleanup = vi.fn();
    const start = vi.fn(async () => { await new Promise<void>((done) => { resolve = done; }); return cleanup; });
    const lifecycle = createTwitchExtensionLifecycle(start);
    const first = lifecycle.select("one");
    const second = lifecycle.select("one");
    expect(start).toHaveBeenCalledTimes(1);
    lifecycle.stop();
    resolve();
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("scrubs initialization failures and permits a retry", async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error("private vendor data")).mockResolvedValue(undefined);
    const lifecycle = createTwitchExtensionLifecycle(start);
    expect(await lifecycle.select("one")).toBe("failed");
    expect(await lifecycle.select("one")).toBe("active");
  });
});
