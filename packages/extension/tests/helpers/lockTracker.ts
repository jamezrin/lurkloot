import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LockTracker, TransactionLock } from "@lurkloot/core/controller";
import { LOCKED_IO_ALLOWLIST } from "./lockedIo";

// The state transaction's test instrumentation (#585). Each operation knows
// which transaction locks it holds, through AsyncLocalStorage, so:
// - a lock taken out of order, or a commit nested in a commit, is a violation;
// - a port (provider, tab or timer) called while a lock is held is a violation
//   unless a frame on its stack is a call site on #584's locked-I/O allowlist.
// Violations are recorded as well as thrown or reported, because best-effort
// callers swallow errors; the suites using the tracker assert there are none.

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "../../../core/src");

export interface LockViolation {
  readonly message: string;
  readonly stack?: string;
}

export interface TestLockTracker extends LockTracker {
  readonly violations: LockViolation[];
  // Wraps a port so every call checks the locks held by its caller.
  guardPort<F extends (...args: never[]) => unknown>(name: string, port: F): F;
  // Runs host or test code the controller calls outside the caller's lock
  // context: a test's storage mock that starts another operation mid-save
  // simulates concurrent work, which holds none of the caller's locks.
  detach<T>(operation: () => T): T;
}

const sourceLines = new Map<string, readonly string[]>();
function lineOf(file: string, line: number): string {
  let lines = sourceLines.get(file);
  if (!lines) {
    lines = readFileSync(resolve(coreSrc, file), "utf8").split("\n");
    sourceLines.set(file, lines);
  }
  return lines[line - 1] ?? "";
}

// packages/core/src-relative file and line of each stack frame in the engine.
function engineFrames(stack: string): { file: string; line: number }[] {
  const frames: { file: string; line: number }[] = [];
  for (const match of stack.matchAll(/\(?((?:file:\/\/)?\/[^\s()]+?\.ts):(\d+):\d+\)?/g)) {
    const path = match[1]!.replace(/^file:\/\//, "");
    const file = relative(coreSrc, path);
    if (file.startsWith("..")) continue;
    frames.push({ file, line: Number(match[2]) });
  }
  return frames;
}

// True when some engine frame on the stack is an allowlisted locked-I/O call.
export function allowlistedCallSite(stack: string): boolean {
  return engineFrames(stack).some(({ file, line }) => {
    const source = lineOf(file, line);
    return LOCKED_IO_ALLOWLIST.some((entry) => entry.file === file && source.includes(entry.call));
  });
}

interface HeldLock {
  readonly lock: TransactionLock;
  released: boolean;
}

export function createTestLockTracker(): TestLockTracker {
  // The context carries lock tokens rather than names: work an operation
  // detaches inside a lock inherits its context, but stops holding the lock
  // once the operation that took it has finished.
  const storage = new AsyncLocalStorage<readonly HeldLock[]>();
  const violations: LockViolation[] = [];
  const held = () => (storage.getStore() ?? []).filter((token) => !token.released).map((token) => token.lock);
  return {
    violations,
    held,
    run: (locks, operation) => {
      const inherited = (storage.getStore() ?? []).filter((token) => !token.released);
      const added = locks.slice(inherited.length).map((lock): HeldLock => ({ lock, released: false }));
      const tokens = locks.length === 0 ? [] : [...inherited.slice(0, locks.length), ...added];
      // Released from inside the operation's own promise chain, since a second
      // reaction on its result would cut the async stack traces guardPort reads.
      const release = () => {
        for (const token of added) token.released = true;
      };
      // Nothing to release: keep the operation's own result, so a caller that
      // compares promises (tick admission shares one per follow-up) still can.
      if (added.length === 0) return storage.run(tokens, operation);
      return storage.run(tokens, () => {
        const result = operation();
        if (!(result instanceof Promise)) {
          release();
          return result;
        }
        return (async () => {
          try {
            return await result;
          } finally {
            release();
          }
        })() as typeof result;
      });
    },
    violation: (error) => {
      violations.push({ message: error.message, stack: error.stack });
    },
    detach: (operation) => storage.exit(operation),
    guardPort(name, port) {
      return ((...args: never[]) => {
        const locks = held();
        if (locks.length > 0) {
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = 200;
          const stack = new Error().stack ?? "";
          Error.stackTraceLimit = limit;
          if (!allowlistedCallSite(stack)) {
            violations.push({ message: `${name} called while holding ${locks.join(" → ")}`, stack });
          }
        }
        return port(...args);
      }) as typeof port;
    },
  };
}

// Port names that reach a provider, a tab or a timer (lockedIo.ts's
// LOCKED_IO_CALLS, as the controller sees them).
const ADAPTER_PORTS = new Set([
  "claimReward", "claimChannelPoints", "claimChallenges", "refreshCampaigns", "checkAuthHealth",
  "searchCategories", "prepareWatchTab", "stopWatchTab",
]);
const DEPS_PORTS = new Set([
  "closeManagedTabs", "stopPageContextTabs", "applyAdFocus", "reconcilePageContextRecovery",
  "discardPageContextRecoveryEvidence", "createAlarm", "clearAlarm", "getAlarm", "ensureTwitchIntegrity",
  "selectSupplementalWatchTarget", "checkCredentialAvailability", "wait",
  // Not cancelTwitchIntegrityAcquisition: it aborts synchronously and waits on
  // nothing, so calling it under a lock holds the lock no longer.
]);

function guardPorts<T extends object>(
  target: T,
  ports: ReadonlySet<string>,
  label: string,
  tracker: TestLockTracker,
  wrapResult?: (name: string, value: unknown) => unknown,
): T {
  return new Proxy(target, {
    get(object, name, receiver) {
      const value = Reflect.get(object, name, receiver);
      if (typeof name !== "string" || typeof value !== "function") return value;
      const call = (...args: never[]) => {
        const result = tracker.detach(() => (value as (...args: never[]) => unknown).apply(object, args));
        return wrapResult ? wrapResult(name, result) : result;
      };
      return ports.has(name) ? tracker.guardPort(`${label}.${name}`, call) : call;
    },
  });
}

// The controller's view of an adapter, with its provider and tab calls guarded.
// Reads through to `adapter`, so a test can still replace or inspect its mocks.
const guardedAdapters = new WeakMap<object, WeakMap<TestLockTracker, object>>();
export function guardAdapter<A extends object>(adapter: A, tracker: TestLockTracker): A {
  // One guard per adapter, so the controller still sees a stable identity.
  let byTracker = guardedAdapters.get(adapter);
  if (!byTracker) guardedAdapters.set(adapter, byTracker = new WeakMap());
  let guarded = byTracker.get(tracker);
  if (!guarded) byTracker.set(tracker, guarded = guardPorts(adapter, ADAPTER_PORTS, "adapter", tracker));
  return guarded as A;
}

// The controller's deps with the tracker installed and every provider, tab and
// timer port guarded. Adapters the deps create are guarded too.
export function guardDeps<D extends object>(deps: D, tracker: TestLockTracker): D & { lockTracker: LockTracker } {
  const guarded = guardPorts(deps, DEPS_PORTS, "deps", tracker, (name, result) => {
    if (name === "createAdapter" && result && typeof result === "object" && "adapter" in result) {
      return { ...result, adapter: guardAdapter(result.adapter as object, tracker) };
    }
    if (name === "createAdapters" && result && typeof result === "object" && "adapters" in result) {
      const adapters = result.adapters as Record<string, object>;
      return {
        ...result,
        adapters: Object.fromEntries(Object.entries(adapters).map(([platform, adapter]) =>
          [platform, guardAdapter(adapter, tracker)])),
      };
    }
    return result;
  });
  return new Proxy(guarded, {
    get: (object, name, receiver) => (name === "lockTracker" ? tracker : Reflect.get(object, name, receiver)),
    has: (object, name) => name === "lockTracker" || Reflect.has(object, name),
  }) as D & { lockTracker: LockTracker };
}

// Suites that build a controller through withLockTracker fail any test whose
// controller recorded a violation. LOCK_DEBUG=1 prints each violation's engine
// frames.
const trackersInUse = new Set<TestLockTracker>();
afterEach(() => {
  const violations = [...trackersInUse].flatMap((tracker) => tracker.violations);
  trackersInUse.clear();
  if (process.env.LOCK_DEBUG) {
    for (const violation of violations) {
      const frames = (violation.stack ?? "").split("\n").filter((line) => line.includes("core/src")).slice(0, 12);
      console.log(`VIOLATION ${violation.message}\n${frames.join("\n")}`);
    }
  }
  expect(violations.map((violation) => violation.message)).toEqual([]);
});

// The controller deps with a fresh lock tracker installed and the ports guarded.
export function withLockTracker<D extends object>(deps: D): { deps: D & { lockTracker: LockTracker }; tracker: TestLockTracker } {
  const tracker = createTestLockTracker();
  trackersInUse.add(tracker);
  return { deps: guardDeps(deps, tracker), tracker };
}
