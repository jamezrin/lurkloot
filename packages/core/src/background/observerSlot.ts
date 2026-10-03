import type { EventEmitter, EngineEvent } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import { emitHostCallbackError } from "./helpers";

// A long-lived observer the controller starts while it is wanted and stops when
// it is not: a socket or subscription that turns platform pushes into work.
export interface SlotObserver {
  stop(): Promise<void>;
  drainEvents(): readonly EngineEvent[];
}

export interface ObserverSlotHooks {
  // Called whenever the slot's observer changes (created, cleared or stopped),
  // before any await, so callbacks captured by the old observer are refused.
  onChange?(): void;
}

export interface ObserverReconcile<T extends SlotObserver> extends ObserverSlotHooks {
  wanted: boolean;
  factory: (() => T) | undefined;
  start(observer: T): Promise<void>;
  // False once the observers are closed (shutdown, host reset).
  open(): boolean;
  // The slot's epoch read before the caller decided `wanted`. A stop since
  // then means the decision is out of date: nothing is created, and an
  // observer that finishes starting afterwards is stopped again.
  since: number;
  emit: EventEmitter;
}

// One observer's lifecycle (#587): create, start, drain its diagnostics, stop,
// and tear down a start that finished after the observer stopped being wanted.
// The observer kinds differ only in whether they are wanted, their factory and
// what their signals do. A slot is serialized by its epoch rather than a lock,
// so a stop never waits on a start that is still setting up its transport.
export class ObserverSlot<T extends SlotObserver> {
  current: T | undefined;
  private stopEpoch = 0;

  constructor(
    private readonly platform: Platform,
    private readonly label: string,
    // What a failed start does with its observer. "retain" keeps it, and the
    // next reconcile calls start() on it again; "discard" stops and clears it,
    // and the next reconcile creates a fresh one.
    private readonly failedStart: "retain" | "discard",
  ) {}

  // Read before deciding whether the observer is wanted; pass as `since`.
  get epoch(): number {
    return this.stopEpoch;
  }

  async stop(emit: EventEmitter, hooks: ObserverSlotHooks = {}): Promise<void> {
    this.stopEpoch += 1;
    hooks.onChange?.();
    const observer = this.current;
    if (!observer) return;
    // Clear before awaiting host cleanup so a callback captured by the old
    // observer cannot enqueue work while its teardown finishes.
    this.current = undefined;
    await this.teardown(observer, emit);
  }

  async reconcile(request: ObserverReconcile<T>): Promise<void> {
    const { emit } = request;
    if (!request.wanted || !request.factory || !request.open()) {
      if (this.current) await this.stop(emit, request);
      return;
    }
    if (this.stopEpoch !== request.since) return;

    let observer = this.current;
    if (!observer) {
      try {
        observer = request.factory();
      } catch (error) {
        emitHostCallbackError(emit, this.platform, error, `Could not create the ${this.label}`);
        return;
      }
      this.current = observer;
      request.onChange?.();
    }

    this.drain(observer, emit);
    try {
      await request.start(observer);
    } catch (error) {
      emitHostCallbackError(emit, this.platform, error, `Could not start the ${this.label}`);
      if (this.failedStart === "discard" && this.current === observer) {
        this.current = undefined;
        request.onChange?.();
      }
    } finally {
      this.drain(observer, emit);
    }

    // A stop, shutdown or reset can land while start() awaits its transport.
    // Teardown wins: the finished start must not keep its callback or socket.
    if (this.current !== observer || !request.open() || this.stopEpoch !== request.since) {
      if (this.current === observer) {
        this.current = undefined;
        request.onChange?.();
      }
      await this.teardown(observer, emit);
    }
  }

  private async teardown(observer: T, emit: EventEmitter): Promise<void> {
    this.drain(observer, emit);
    try {
      await observer.stop();
    } catch (error) {
      emitHostCallbackError(emit, this.platform, error, `Could not stop the ${this.label}`);
    } finally {
      this.drain(observer, emit);
    }
  }

  private drain(observer: T, emit: EventEmitter): void {
    for (const event of observer.drainEvents()) emit(event);
  }
}
