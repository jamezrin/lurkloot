# Diagnostics Polish Design

## Goal

Make diagnostics easier to correlate across background-controller restarts,
remove genuinely redundant integrity scheduling lines, identify the campaign
behind channel-selection timings, and expose material platform-lock contention.

## Controller Run Identity

Each background-controller instance will generate one opaque
`controllerRunId`. Every diagnostic emitted by that controller will carry the
ID as structured metadata.

Before the controller reports its first diagnostic, it will report one
unscoped boundary:

```text
Background controller run a1b2c3d4 started
```

The message uses a short display prefix while `controllerRunId` retains the
complete value. Unscoped events appear in both current platform-filtered views,
so Twitch and Kick exports can explain tick counter resets.

`globalTickId` and `platformTickId` remain numeric and reset for each controller
run. Their stable correlation key is therefore:

```text
(controllerRunId, globalTickId)
```

Diagnostics outside scheduler ticks carry `controllerRunId` but omit both tick
IDs.

## Compatibility Context

The compatibility profile remains an event emitted once per controller run.
This is intentional rather than redundant: it records which adapter behavior
was active for that run. Existing within-run fingerprint suppression remains.
The explicit controller boundary makes repeated profiles across runs
interpretable.

Compatibility warnings retain their current severity and structured metadata.

## Integrity Alarm Deduplication

The controller dependency contract will gain a read-only alarm lookup that
returns the current scheduled time for a named alarm. The extension host will
implement it with the browser alarms API; headless hosts may omit it.

Before recreating the proactive Twitch integrity alarm, the controller will
compare the existing scheduled time with the desired target. If they match
within 1,000 milliseconds, scheduling becomes a no-op and no diagnostic is
emitted.

If the target differs or cannot be read, the controller preserves current
behavior: create/replace the alarm and emit the new target. Lookup failures are
best-effort and must not block integrity handling.

## Channel-Selection Context

Every `Twitch channel selection finished` diagnostic will include the campaign
ID and name when campaign-specific selection is running. Idle-watchlist
selection, which has no campaign, will explicitly identify itself as idle
selection.

The existing timing and request/fallback counters remain unchanged.

## Platform-Lock Contention

Authentication refresh already acquires the platform state lock before probing
credentials. The controller will measure the time spent acquiring this lock.
When the wait is at least 50 milliseconds, it will emit:

```text
Tick #N waited Xms for Twitch platform work
```

The event carries the run and tick identifiers plus structured `waitMs`.
Uncontended and negligible waits remain silent. This measures the actual lock
boundary instead of inferring queue time from total tick duration.

## Data Contracts

`DiagnosticEvent` gains:

```ts
controllerRunId?: string;
```

The existing optional `globalTickId` and `platformTickId` fields remain.
Persisted history accepts the new optional field without a migration because
activity records are structurally stored and older records remain valid.

The alarm dependency gains a read-only shape equivalent to:

```ts
getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>;
```

Core remains browser-free; browser API access stays in the extension host.

## Testing

Tests will prove:

- One run boundary precedes the first diagnostic from a controller.
- All diagnostics in that controller share its full `controllerRunId`.
- Tick IDs reset in a new controller while the run ID changes.
- Non-tick diagnostics have a run ID and no tick IDs.
- An unchanged integrity alarm is neither recreated nor logged.
- A changed or unavailable alarm is scheduled and logged normally.
- Twitch campaign and idle channel-selection timings identify their context.
- A lock wait of at least 50 milliseconds is measured and correlated.
- Uncontended ticks emit no wait line.

Full repository verification and Chromium/Firefox production builds remain the
delivery gate.
