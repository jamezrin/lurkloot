import { describe, expect, it, vi } from "vitest";
import { createTwitchExtensionRuntime } from "../src/extensions/runtime";
import { twitchExtensionProviders } from "@lurkloot/core/extensions/registry";
import type { DriverSession } from "../src/extensions/session";

const provider = twitchExtensionProviders[0];
function setup() {
  let now = 1_800_000_000_000;
  const stop = vi.fn();
  const refresh = vi.fn(async () => {});
  const driver = vi.fn(async (_session: DriverSession, emit: (value: unknown) => void) => {
    emit({ status: "farming", reasonCode: "watchtime", progress: [], pending: [] });
    return { stop, refresh };
  });
  const query = vi.fn(async () => {
    const jwt = `eyJheader.${btoa(JSON.stringify({ channel_id: "123", exp: now / 1000 + 120, role: "viewer", opaque_user_id: "Uviewer", user_id: "viewer" })).replace(/=/g, "")}.signature`;
    return { data: { user: { channel: { selfInstalledExtensions: [{ installation: { extension: { id: provider.extensionId, version: "1.1.2" }, activationConfig: { state: "ACTIVE" } }, token: { jwt } }] } } } };
  });
  const contains = vi.fn(async () => true);
  const report = vi.fn();
  const violation = vi.fn();
  const runtime = createTwitchExtensionRuntime({ source: { query, hasSession: async () => true, now: () => now }, contains, drivers: { nopixel: driver }, report, onViolation: violation });
  return { runtime, driver, query, stop, refresh, contains, report, violation, advance(ms: number) { now += ms; } };
}
const selected = { nopixel: "123" };
describe("privileged tabless provider runtime", () => {
  it("does no work without a selected provider", async () => {
    const s = setup(); await s.runtime.update({});
    expect(s.contains).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled(); expect(s.driver).not.toHaveBeenCalled();
  });
  it("verifies backend access and starts a driver without browser tab APIs", async () => {
    const s = setup(); await s.runtime.update(selected);
    expect(s.contains).toHaveBeenCalledWith(provider.backendOrigin);
    expect(s.driver).toHaveBeenCalledOnce();
    expect(s.report).toHaveBeenCalledWith("nopixel", expect.objectContaining({ status: "farming" }));
  });
  it("does not acquire authorization with a missing backend grant", async () => {
    const s = setup(); s.contains.mockResolvedValue(false); await s.runtime.update(selected);
    expect(s.query).not.toHaveBeenCalled();
    expect(s.report).toHaveBeenCalledWith("nopixel", expect.objectContaining({ reasonCode: "permission-required" }));
  });
  it("coalesces concurrent starts and respects polling floors", async () => {
    const s = setup(); await Promise.all([s.runtime.update(selected), s.runtime.update(selected)]);
    expect(s.driver).toHaveBeenCalledOnce();
    await s.runtime.update(selected); expect(s.refresh).not.toHaveBeenCalled();
    s.advance(60_000); await s.runtime.update(selected);
    // Authorization is renewed before expiry rather than polling with it.
    expect(s.driver).toHaveBeenCalledTimes(2); expect(s.stop).toHaveBeenCalledOnce();
  });
  it("aborts session acquisition and discards late driver resources", async () => {
    const s = setup(); let resolve!: (value: { stop: () => void }) => void;
    s.driver.mockImplementation(async () => new Promise((done) => { resolve = done; }) as never);
    const pending = s.runtime.update(selected);
    await vi.waitFor(() => expect(s.driver).toHaveBeenCalledOnce());
    const signal = s.driver.mock.calls[0][0].signal!;
    s.runtime.stop("nopixel"); expect(signal.aborted).toBe(true);
    resolve({ stop: s.stop }); await pending;
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.report).not.toHaveBeenCalled();
  });
  it("rejects a credential-carrying driver report and stops the driver", async () => {
    const s = setup(); s.driver.mockImplementation(async (_session, emit) => {
      emit({ status: "farming", reasonCode: "watchtime", progress: [], pending: [], token: "private" });
      return { stop: s.stop, refresh: s.refresh };
    });
    await s.runtime.update(selected);
    expect(s.report).not.toHaveBeenCalled(); expect(s.violation).toHaveBeenCalledWith("nopixel", "Twitch Extension runtime stopped: invalid provider report.");
    expect(s.stop).toHaveBeenCalledOnce();
  });
  it("drops late reports after a stop", async () => {
    const s = setup(); await s.runtime.update(selected); const emit = s.driver.mock.calls[0][1];
    s.runtime.stop(); s.report.mockClear(); emit({ status: "complete", reasonCode: "rewards-complete", progress: [], pending: [] });
    expect(s.report).not.toHaveBeenCalled();
  });
});


it("aborts resources bound to a failed driver initialization", async () => {
  const s = setup();
  let signal!: AbortSignal;
  s.driver.mockImplementation(async (session) => { signal = session.signal!; throw new Error("private"); });
  await s.runtime.update(selected);
  expect(signal.aborted).toBe(true);
  expect(s.report).toHaveBeenLastCalledWith("nopixel", expect.objectContaining({ reasonCode: "provider-error" }));
  s.runtime.stop();
});

it("terminates a still-active driver when authorization expires", async () => {
  vi.useFakeTimers();
  try {
    const s = setup(); await s.runtime.update(selected);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.driver.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.report).toHaveBeenLastCalledWith("nopixel", expect.objectContaining({ reasonCode: "auth-required" }));
    s.runtime.stop();
  } finally { vi.useRealTimers(); }
});

it("reacquires rejected provider authorization on a bounded retry", async () => {
  const s = setup();
  s.driver.mockImplementation(async (_session, emit) => {
    emit({ status: "error", reasonCode: "auth-required", progress: [], pending: [] });
    return { stop: s.stop, refresh: s.refresh };
  });
  await s.runtime.update(selected);
  expect(s.driver.mock.calls[0][0].signal?.aborted).toBe(true);
  expect(s.stop).toHaveBeenCalledOnce();
  await s.runtime.update(selected); expect(s.query).toHaveBeenCalledOnce();
  s.advance(60_000); await s.runtime.update(selected);
  expect(s.query).toHaveBeenCalledTimes(2);
  s.runtime.stop();
});
