# Dual Tick Identifiers Design

## Goal

Keep tick diagnostics easy to follow in the current platform-filtered views
without losing the globally unique ordering needed by a future combined Twitch
and Kick diagnostics view.

## Identifier Model

The controller will assign every platform tick two monotonically increasing,
in-memory identifiers:

- `globalTickId`: unique across all Twitch and Kick ticks created by the
  controller instance.
- `platformTickId`: sequential within the tick's platform.

Both sequences reset when the extension background controller restarts, matching
the existing global tick counter behavior. They are diagnostic correlation
identifiers, not persisted scheduler state.

## Diagnostic Contract

`DiagnosticEvent` will expose optional numeric `globalTickId` and
`platformTickId` fields. Every diagnostic produced as part of a scheduler tick,
including the immediate start, authentication timing, and finish events, will
carry both identifiers.

Diagnostics outside a scheduler tick will omit the fields. Activity events are
unchanged; their automatically generated English diagnostic counterparts receive
tick identifiers when they are emitted inside a tick.

## Display Behavior

Existing platform-filtered diagnostics will render `platformTickId` in the
English lifecycle message:

```text
Tick #4 started (trigger=alarm, platforms=twitch)
```

The global identifier remains structured metadata and is not added to today's
message, avoiding extra noise. A future combined view can use `globalTickId` for
unique correlation and true interleaved ordering, and can optionally render both
identifiers.

## Concurrency

JavaScript increments both counters synchronously before the tick first awaits,
so concurrent Twitch and Kick ticks cannot receive the same global identifier.
Each platform maintains an independent local counter.

## Testing

Controller tests will prove that:

- Interleaved Twitch and Kick ticks receive unique, increasing global IDs.
- Twitch and Kick each receive continuous platform-local IDs.
- Lifecycle messages use the platform-local ID.
- Start, authentication timing, scheduler diagnostics, and finish events from
  one tick carry the same identifier pair.
- Diagnostics emitted outside a scheduler tick remain uncorrelated.

