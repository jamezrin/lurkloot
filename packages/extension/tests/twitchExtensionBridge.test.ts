import { describe, expect, it, vi } from "vitest";
import { createBridgeValidator, BRIDGE_PROTOCOL } from "../src/extensions/bridgeProtocol";

const origin = "https://nstuq90nghenyqwqme61jgvmtp253a.ext-twitch.tv";
const source = {};
function setup() {
  const violation = vi.fn();
  const validator = createBridgeValidator({
    origin, source, provider: "nopixel",
    contracts: { progress: { keys: ["earned", "required", "details"], unsolicited: true }, result: { keys: ["outcome"], unsolicited: false } },
    onViolation: violation,
  });
  const envelope = { channel: "lurkloot.twitch-extension", protocol: BRIDGE_PROTOCOL, direction: "up", provider: "nopixel", requestId: "r1", kind: "progress", payload: { earned: 1, required: 2 } };
  const event = { source, origin, data: envelope };
  return { validator, envelope, event, violation };
}

describe("Twitch Extension bridge screening", () => {
  it("accepts declared unsolicited reports and strips unknown payload keys", () => {
    const { validator, event, envelope } = setup();
    expect(validator.receive(event)?.payload).toEqual(envelope.payload);
    expect(validator.receive({ ...event, data: { ...envelope, payload: { earned: 1, extra: "discard" } } })?.payload).toEqual({ earned: 1 });
  });
  it("drops foreign frames, wrong origin, protocol, direction, provider and undeclared kinds", () => {
    const { validator, event, envelope } = setup();
    expect(validator.receive({ ...event, source: {} })).toBeUndefined();
    expect(validator.receive({ ...event, origin: "https://evil.test" })).toBeUndefined();
    for (const patch of [{ protocol: 2 }, { direction: "down" }, { provider: "fortnite" }, { kind: "unknown" }, { requestId: "" }, { payload: null }]) {
      expect(validator.receive({ ...event, data: { ...envelope, ...patch } })).toBeUndefined();
    }
  });
  it("requires an outstanding request with the expected response kind and consumes it once", () => {
    const { validator, event, envelope } = setup();
    const response = { ...event, data: { ...envelope, kind: "result", payload: { outcome: "ok" } } };
    expect(validator.receive(response)).toBeUndefined();
    validator.expectResponse("r1", "result");
    expect(validator.receive({ ...response, data: { ...response.data, kind: "progress" } })).toBeUndefined();
    expect(validator.receive(response)?.kind).toBe("result");
    expect(validator.receive(response)).toBeUndefined();
  });
  it.each([
    { jwt: "redacted" }, { extra: { epicSessionToken: "redacted" } },
    { details: [{ epicDeviceId: "redacted" }] }, { details: { Authorization: "redacted" } },
    { details: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature" },
  ])("disables the frame on authorization material, including discarded keys: %j", (payload) => {
    const { validator, event, envelope, violation } = setup();
    expect(validator.receive({ ...event, data: { ...envelope, payload } })).toBeUndefined();
    expect(violation).toHaveBeenCalledExactlyOnceWith("Twitch Extension bridge disabled: authorization material in report.");
    expect(validator.receive(event)).toBeUndefined();
  });
  it("bounds outstanding requests and rejects deeply nested or cyclic reports", () => {
    const { validator, event, envelope } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validator.receive({ ...event, data: { ...envelope, payload: { details: cyclic } } })).toBeUndefined();
    for (let n = 0; n < 100; n++) validator.expectResponse(`r${n}`, "result");
    expect(() => validator.expectResponse("overflow", "result")).toThrow();
  });
});

describe("Twitch Extension frame relay", () => {
  it("forwards only screened envelopes and removes its listener on stop", async () => {
    const { startFrameRelay } = await import("../src/extensions/frameRelay");
    let listener: ((event: { origin: string; source: unknown; data: unknown }) => void) | undefined;
    const forward = vi.fn(async (_envelope: unknown) => {});
    const post = vi.fn();
    const remove = vi.fn(() => { listener = undefined; });
    const relay = startFrameRelay({
      source, origin, provider: "nopixel", contracts: { progress: { keys: ["earned"], unsolicited: true } },
      addListener: (callback) => { listener = callback; }, removeListener: remove,
      postMessage: post, forward, diagnostic: vi.fn(),
    });
    const { event, envelope } = setup();
    listener?.({ ...event, origin: "https://evil.test" });
    expect(forward).not.toHaveBeenCalled();
    listener?.({ ...event, data: { ...envelope, payload: { earned: 2, extra: 3 } } });
    expect(forward).toHaveBeenCalledExactlyOnceWith({ ...envelope, payload: { earned: 2 } });
    relay.stop();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ direction: "down", kind: "stop" }), origin);
    expect(listener).toBeUndefined();
  });
  it("stops forwarding after a protocol violation and never logs the offending payload", async () => {
    const { startFrameRelay } = await import("../src/extensions/frameRelay");
    let listener: ((event: { origin: string; source: unknown; data: unknown }) => void) | undefined;
    const forward = vi.fn(async (_envelope: unknown) => {});
    const diagnostic = vi.fn();
    const post = vi.fn();
    startFrameRelay({
      source, origin, provider: "nopixel", contracts: { progress: { keys: ["earned"], unsolicited: true } },
      addListener: (callback) => { listener = callback; }, removeListener: () => {},
      postMessage: post, forward, diagnostic,
    });
    const { event, envelope } = setup();
    listener?.({ ...event, data: { ...envelope, payload: { token: "private-value" } } });
    listener?.(event);
    expect(forward).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Twitch Extension bridge disabled: authorization material in report.");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-value");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: "stop" }), origin);
  });
});

describe("Twitch Extension relay requests", () => {
  it("correlates a requested response and supports cancellation", async () => {
    const { startFrameRelay } = await import("../src/extensions/frameRelay");
    let listener: ((event: { origin: string; source: unknown; data: unknown }) => void) | undefined;
    const forward = vi.fn(async (_envelope: unknown) => {});
    const post = vi.fn();
    const relay = startFrameRelay({
      source, origin, provider: "nopixel", contracts: { result: { keys: ["outcome"], unsolicited: false } },
      addListener: (callback) => { listener = callback; }, removeListener: () => {},
      postMessage: post, forward, diagnostic: vi.fn(),
    });
    const id = relay.request("refresh", {}, "result");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ direction: "down", requestId: id, kind: "refresh" }), origin);
    const { envelope } = setup();
    const event = { source, origin, data: { ...envelope, requestId: id, kind: "result", payload: { outcome: "ok" } } };
    listener?.(event);
    listener?.(event);
    expect(forward).toHaveBeenCalledTimes(1);
    const cancelled = relay.request("refresh", {}, "result");
    relay.cancelRequest(cancelled);
    listener?.({ ...event, data: { ...event.data, requestId: cancelled } });
    expect(forward).toHaveBeenCalledTimes(1);
    relay.stop();
    expect(() => relay.request("refresh", {}, "result")).toThrow("stopped");
  });
  it("tears down when the background transport rejects and uses only a fixed diagnostic", async () => {
    const { startFrameRelay } = await import("../src/extensions/frameRelay");
    let listener: ((event: { origin: string; source: unknown; data: unknown }) => void) | undefined;
    const forward = vi.fn(async (_envelope: unknown) => { throw new Error("private payload"); });
    const remove = vi.fn();
    const diagnostic = vi.fn();
    startFrameRelay({
      source, origin, provider: "nopixel", contracts: { progress: { keys: ["earned"], unsolicited: true } },
      addListener: (callback) => { listener = callback; }, removeListener: remove,
      postMessage: vi.fn(), forward, diagnostic,
    });
    const { event } = setup();
    listener?.(event);
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Twitch Extension bridge stopped: background relay unavailable.");
    listener?.(event);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

describe("Twitch Extension retained envelope fields", () => {
  it("disables the frame when an unsolicited request id carries a JWT", () => {
    const { validator, event, envelope, violation } = setup();
    const requestId = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature";
    expect(validator.receive({ ...event, data: { ...envelope, requestId } })).toBeUndefined();
    expect(violation).toHaveBeenCalledExactlyOnceWith("Twitch Extension bridge disabled: authorization material in report.");
    expect(validator.receive(event)).toBeUndefined();
  });
});
