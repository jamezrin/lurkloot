import { describe, expect, it } from "vitest";
import { validateTwitchExtensionReport } from "@lurkloot/core/extensions/reports";

describe("direct provider report boundary", () => {
  it("copies only the declared summary fields", () => {
    const input = { status: "farming", reasonCode: "watchtime", progress: [{ key: "daily-pack", earned: 3, required: 60 }], pending: [], extra: "discard" };
    expect(validateTwitchExtensionReport(input)).toEqual({ status: "farming", reasonCode: "watchtime", progress: [{ key: "daily-pack", earned: 3, required: 60 }], pending: [] });
  });
  it.each([
    { extra: { token: "private" } },
    { extra: { epicDeviceId: "private" } },
    { extra: "eyJheader.eyJpayload.signature" },
    { status: "unknown" },
    { progress: [{ key: ["daily-pack"], earned: 1, required: 60 }] },
    { pending: [{ key: "giveaway", state: ["open"] }] },
    { pending: [{ key: ["giveaway"], state: "open" }] },
    { reasonCode: "raw vendor exception" },
    { progress: [{ key: "daily-pack", earned: -1, required: 60 }] },
    { progress: [{ key: "unreviewed-key", earned: 1, required: 60 }] },
  ])("rejects credentials and malformed summaries even in discarded fields", (patch) => {
    expect(validateTwitchExtensionReport({ status: "farming", reasonCode: "watchtime", progress: [], pending: [], ...patch })).toBeUndefined();
  });
  it("rejects cyclic/oversized data and returns independent DTO objects", () => {
    const cycle: Record<string, unknown> = {}; cycle.cycle = cycle;
    expect(validateTwitchExtensionReport(cycle)).toBeUndefined();
    expect(validateTwitchExtensionReport({ status: "idle", reasonCode: "disabled", progress: [], pending: [], extra: new Array(3000).fill(1) })).toBeUndefined();
    const input = { status: "idle", reasonCode: "disabled", progress: [], pending: [] };
    const output = validateTwitchExtensionReport(input)!;
    expect(output).not.toBe(input);
    expect(output.progress).not.toBe(input.progress);
  });
});
