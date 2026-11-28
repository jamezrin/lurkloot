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
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
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
    await slot.reconcile({
      wanted: true,
      factory: () => observer,
      start,
      open,
      since: slot.epoch,
      emit,
    });
    expect(slot.current).toBe(observer);
    expect(start).toHaveBeenCalledWith(observer);

    await slot.reconcile({
      wanted: false,
      factory: () => observer,
      start,
      open,
      since: slot.epoch,
      emit,
    });
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
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket refused"))
      .mockResolvedValue(undefined);

    await slot.reconcile({ wanted: true, factory, start, open, since: slot.epoch, emit });
    expect(first.stops).toBe(stops);
    await slot.reconcile({ wanted: true, factory, start, open, since: slot.epoch, emit });

    expect(factory).toHaveBeenCalledTimes(factoryCalls);
    expect(start).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "kick", message: "socket refused" }),
    );
  });

  it("stops an observer whose start finishes after a stop", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const observer = new FakeObserver();
    const started = deferred();
    const reconciling = slot.reconcile({
      wanted: true,
      factory: () => observer,
      start: () => started.promise,
      open,
      since: slot.epoch,
      emit,
    });

    await slot.stop(emit);
    started.resolve();
    await reconciling;

    expect(slot.current).toBeUndefined();
    expect(observer.stops).toBe(2);
  });

  it("waits for teardown and abandons a credential replacement interrupted by a stop", async () => {
    const slot = new ObserverSlot<FakeObserver>("twitch", "test observer", "retain");
    const closing = deferred();
    const original = new FakeObserver();
    original.stop = () => closing.promise;
    const originalRevision = Symbol();
    const replacementRevision = Symbol();
    const request = { wanted: true, start: async () => {}, open, emit };
    await slot.reconcile({
      ...request,
      factory: () => original,
      revision: originalRevision,
      since: slot.epoch,
    });

    const replacement = vi.fn(() => new FakeObserver());
    const reconciling = slot.reconcile({
      ...request,
      factory: replacement,
      revision: replacementRevision,
      since: slot.epoch,
    });
    expect(slot.observerFor(originalRevision)).toBeUndefined();
    expect(replacement).not.toHaveBeenCalled();
    const stopped = vi.fn();
    const stopping = slot.stop(emit).then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();

    closing.resolve();
    await Promise.all([reconciling, stopping]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("keeps a second reconcile from creating an observer during credential teardown", async () => {
    const slot = new ObserverSlot<FakeObserver>("twitch", "test observer", "retain");
    const closing = deferred();
    const original = new FakeObserver();
    original.stop = () => closing.promise;
    const request = { wanted: true, start: async () => {}, open, emit };
    await slot.reconcile({
      ...request,
      factory: () => original,
      revision: Symbol(),
      since: slot.epoch,
    });

    const replacement = new FakeObserver();
    const factory = vi.fn(() => replacement);
    const next = { ...request, factory, revision: Symbol() };
    const first = slot.reconcile({ ...next, since: slot.epoch });
    const second = slot.reconcile({ ...next, since: slot.epoch });
    try {
      await Promise.resolve();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      closing.resolve();
      await Promise.all([first, second]);
    }
    expect(factory).toHaveBeenCalledOnce();
    expect(slot.current).toBe(replacement);
  });

  it("creates nothing when a stop landed after the caller read its state", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const since = slot.epoch;
    await slot.stop(emit);
    const factory = vi.fn(() => new FakeObserver());

    await slot.reconcile({
      wanted: true,
      factory,
      start: async () => undefined,
      open,
      since,
      emit,
    });

    expect(factory).not.toHaveBeenCalled();
    expect(slot.current).toBeUndefined();
  });

  it("creates nothing once the observers are closed", async () => {
    const slot = new ObserverSlot<FakeObserver>("kick", "test observer", "retain");
    const factory = vi.fn(() => new FakeObserver());
    await slot.reconcile({
      wanted: true,
      factory,
      start: async () => undefined,
      open: () => false,
      since: slot.epoch,
      emit,
    });
    expect(factory).not.toHaveBeenCalled();
  });
});
