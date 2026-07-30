# Preempt In-Flight Scheduler Ticks

## Context

Factory reset currently calls `prepareForHostReset`, which waits for the
controller's settings and state locks. A scheduler tick holds the state lock
across network-bound platform work, so reset can remain stuck on "Resetting…"
until that tick completes. Runtime shutdown has the same underlying problem:
post-claim handoffs can be aborted, but the scheduler tick itself has no
cancellation path.

The fix must cancel in-flight work before reset or shutdown cleanup begins.
Merely releasing the state lock or racing the caller against the scheduler
would leave abandoned work running and able to write stale state after storage
has been cleared.

## Goals

- Factory reset promptly cancels all active scheduler ticks before waiting for
  controller locks.
- Controller shutdown cancels the same work, including integrity waits and
  network requests reached by the tick.
- A cancelled tick rolls back without persisting partial scheduler state or
  reporting a user-facing platform failure.
- Existing serialization still prevents new mutations from crossing the host
  storage reset.
- Ordinary, non-cancellation scheduler failures retain their current reporting
  and persistence behavior.

## Non-Goals

- Redesigning the controller's global state or settings locks.
- Adding cancellation controls to the popup.
- Changing platform retry, timeout, or integrity-refresh policies.
- Cancelling unrelated operations that are not owned by a scheduler tick.

## Design

### Tick Lifetime Ownership

The background controller will own an `AbortController` for every active
scheduler tick. A collection is required rather than a single current
controller because tick calls may overlap before they serialize on the state
lock.

Each tick registers its controller before beginning asynchronous work and
removes it in a `finally` block. Reset and shutdown synchronously abort every
registered controller. A tick whose signal is already aborted must stop before
starting or persisting further work.

Post-claim handoffs remain independently tracked because their bounded loop has
a distinct lifetime. Reset and shutdown abort both active ticks and handoffs.

### Signal Propagation

`runSchedulerTick` will accept an optional signal in `SchedulerTickOptions`.
Scheduler code will pass that signal to every platform-adapter operation it
invokes. `PlatformAdapter` methods will accept an optional `AbortSignal`, and
implementations will forward it to their transports, integrity acquisition,
page-context work, and other cancellable waits.

The propagation must cover the full tick path, including:

- campaign discovery and progress reads;
- candidate listing and channel checks;
- reward, channel-points, and challenge claims;
- watch-tab preparation and teardown;
- Twitch integrity refresh and page-context acquisition;
- browser and Node HTTP transports.

The scheduler will also check the signal at phase boundaries. This handles
adapters that complete normally after cancellation and prevents subsequent
side effects from starting.

### Reset and Shutdown

`prepareForHostReset` will abort active ticks and claim handoffs before taking
the settings and state locks. It will then use the existing locked cleanup
sequence to close managed tabs, stop watchers, clear in-memory registries, run
the host storage reset callback, and report best-effort cleanup diagnostics.
Waiting for the lock remains intentional: the cancelled tick must finish its
rollback before storage is wiped.

The controller will expose a shutdown operation that aborts active ticks and
handoffs. Runtime teardown paths, including the CLI's existing final cleanup,
will call it. The shutdown API will be safe to invoke repeatedly.

### Cancellation Semantics

Cancellation is an expected control-flow outcome, not a platform failure.
When a scheduler tick is aborted:

- partially computed state and claimed-reward observations are discarded;
- no interruption activity event or error diagnostic is persisted;
- no state save occurs for the aborted scheduler result;
- no post-claim handoff begins;
- the tick lifecycle finish diagnostic may still be emitted for observability.

Errors unrelated to the tick signal continue through the existing error path.
Cancellation detection will be based on the owned signal's aborted state, so
an unrelated exception named `AbortError` is not silently swallowed.

### Concurrency Guarantees

Abort happens before reset or shutdown waits for controller locks. The active
tick releases the state lock only after its cancellation path has stopped
further side effects and skipped persistence. Reset then acquires the lock and
wipes storage. New controller mutations remain queued behind the reset's
settings/state lock sequence and therefore cannot interleave with the wipe.

Registering the tick controller before asynchronous setup closes the race where
reset begins between tick creation and signal registration.

## Testing

Deterministic controller and scheduler tests will verify:

- reset aborts a tick blocked in an adapter call and starts cleanup promptly;
- shutdown aborts the same in-flight work and is idempotent;
- an aborted tick cannot save scheduler state after host storage reset;
- adapter calls and Twitch integrity/network paths receive the tick signal;
- cancellation produces no platform interruption or error persistence;
- a tick queued during reset still cannot cross the storage wipe;
- ordinary scheduler failures retain their current diagnostics and rollback.

Focused tests will use deferred promises and mocked adapters/transports rather
than live Twitch or Kick calls. Final verification will run the repository's
full `pnpm verify` command.
