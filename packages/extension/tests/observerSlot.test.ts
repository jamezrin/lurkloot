import { describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "@lurkloot/shared/events";
import { ObserverSlot, type SlotObserver } from "@lurkloot/core/background/observerSlot";

class FakeObserver implements SlotObserver {
  stops = 0;
  async stop(): Promise<void> {
    this.stops += 1;
  }
  drainEvents(): EngineEvent[] {
    return [];
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// The shared observer lifecycle (#587).
describe("ObserverSlot", () => {
  const emit = vi.fn();
  const open = () => true;

  it("creates and starts an observer while wanted, and stops it when not", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const observer = new FakeObserver();
    const start = vi.fn(async () => undefined);
    await slot.reconcile({ wanted: true, factory: () => observer, start, open, since: slot.epoch, emit });
    expect(slot.current).toBe(observer);
    expect(start).toHaveBeenCalledWith(observer);

    await slot.reconcile({ wanted: false, factory: () => observer, start, open, since: slot.epoch, emit });
    expect(slot.current).toBeUndefined();
    expect(observer.stops).toBe(1);
  });

  it.each([
    ["retain", 1, 0],
    ["discard", 2, 1],
  ] as const)("on a failed start, %s the observer", async (failedStart, factoryCalls, stops) => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", failedStart);
    const first = new FakeObserver();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(new FakeObserver());
    const start = vi.fn().mockRejectedValueOnce(new Error("socket refused")).mockResolvedValue(undefined);

    await slot.reconcile({ wanted: true, factory, start, open, since: slot.epoch, emit });
    expect(first.stops).toBe(stops);
    await slot.reconcile({ wanted: true, factory, start, open, since: slot.epoch, emit });

    expect(factory).toHaveBeenCalledTimes(factoryCalls);
    expect(start).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ platform: "kick", message: "socket refused" }));
  });

  it("stops an observer whose start finishes after a stop", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const observer = new FakeObserver();
    const started = deferred();
    const reconciling = slot.reconcile({ wanted: true, factory: () => observer, start: () => started.promise, open, since: slot.epoch, emit });

    await slot.stop(emit);
    started.resolve();
    await reconciling;

    expect(slot.current).toBeUndefined();
    expect(observer.stops).toBe(2);
  });

  it("creates nothing when a stop landed after the caller read its state", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const since = slot.epoch;
    await slot.stop(emit);
    const factory = vi.fn(() => new FakeObserver());

    await slot.reconcile({ wanted: true, factory, start: async () => undefined, open, since, emit });

    expect(factory).not.toHaveBeenCalled();
    expect(slot.current).toBeUndefined();
  });

  it("creates nothing once the observers are closed", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const factory = vi.fn(() => new FakeObserver());
    await slot.reconcile({ wanted: true, factory, start: async () => undefined, open: () => false, since: slot.epoch, emit });
    expect(factory).not.toHaveBeenCalled();
  });
});
