# Kick Realtime Flash-Drop Discovery Design

## Goal

Discover newly launched Kick flash-drop campaigns quickly enough to farm them while preserving the existing eligibility, priority, and watch-mode behavior. Realtime discovery must work for both visible-tab and tabless Kick sessions and introduce a platform-neutral seam that Twitch or another platform can implement later.

## Scope

This change will:

- subscribe to Kick's category-scoped campaign-start signal while LurkLoot is actively watching a live Kick channel;
- request an immediate Kick-only canonical campaign refresh when that signal arrives;
- coalesce repeated signals without losing a final refresh that arrives during an active tick;
- manage subscription changes, disconnects, reconnects, and shutdown safely;
- preserve all existing campaign eligibility, user priority, and current-watch replacement rules; and
- narrowly adjust deadline feasibility for just-launched, nominally exact-fit Kick watch rewards.

This change will not add periodic polling, trust campaign data from the realtime payload, hard-preempt the active campaign, add browser permissions, store credentials, or add localized diagnostic strings.

## Platform-Neutral Discovery Signal Seam

Realtime campaign discovery is a sibling capability to tabless watching. It is not part of `TablessWatchController`, because visible-tab sessions need it too and discovery signals do not earn watch progress or determine watch health.

Core will define a platform-neutral lifecycle contract equivalent to:

```ts
interface DiscoverySignalTarget {
  platform: Platform;
  channel: ChannelCandidate;
}

interface DiscoverySignalController {
  readonly platform: Platform;
  readonly targetKey: string | undefined;
  start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void>;
  drainEvents(): DiagnosticEvent[];
  stop(): Promise<void>;
}
```

`PlatformAdapter` will expose an optional `createDiscoverySignalController` factory. Platforms without the capability require no implementation and retain their existing behavior. A future Twitch implementation can translate the same neutral target and callback into its own transport without modifying the background controller or scheduler.

The target carries the active channel and its category identity through the existing `ChannelCandidate`. The platform implementation computes its own stable `targetKey`; Kick will key the subscription by category. Protocol-specific channel and event names never leave the Kick implementation.

## Controller Lifecycle

The background controller owns at most one discovery-signal controller per platform. After each scheduler result, it reconciles observers against the resulting active watch sessions independently of watch mode.

An observer is wanted only when all of the following are true:

- the platform is enabled and authenticated;
- the session is actively watching;
- the selected channel is live; and
- the platform-specific implementation has enough target context to subscribe.

The controller creates and starts the observer when needed, leaves it running when the target key is unchanged, replaces its subscription when the target changes, and stops it when the platform becomes idle, paused, disabled, unhealthy, or the controller shuts down. This lifecycle applies equally to visible-tab and tabless sessions.

The observer callback means only that canonical discovery data for its platform may have changed. It does not carry campaign data into controller or scheduler state.

## Refresh Coalescing and Data Flow

Each platform has a bounded signal-refresh state in the controller. On a discovery signal:

1. If no signal refresh is running, start a platform-only tick with the neutral trigger `discovery_signal`.
2. If a tick or signal refresh for that platform is already running, record one pending signal refresh.
3. Collapse every additional signal into that single pending refresh.
4. After the active platform tick finishes, run the pending platform-only refresh once.
5. Clear the pending state only after that follow-up has started or the platform no longer qualifies for farming.

This guarantees no overlapping platform ticks, bounds bursts to one pending refresh, and avoids losing a campaign event that arrives after an active tick has already fetched its data. Twitch and Kick remain independently serialized.

The Kick-only tick calls the existing `KickAdapter.refreshCampaigns`, including its canonical campaign and progress endpoints. The resulting campaigns pass through the existing eligibility filters, configured priority mode, explicit campaign priorities, category priority, and current-watch replacement decision. The realtime event never forces a campaign switch.

Under the default `ending_soonest` mode, an otherwise equal eligible flash campaign naturally ranks ahead of a later-ending campaign. Explicit campaign priorities, category ordering when enabled, and `priority_list_only` remain authoritative.

## Kick Realtime Implementation

`platforms/kick/discoverySignals.ts` will implement the neutral controller using Kick's Pusher-compatible realtime protocol. While watching a live channel with category `X`, it subscribes to:

```text
channel: drops_category_X
event:   drops_campaign_started
```

Only a correctly framed event for the current subscription invokes `onSignal`. The payload is treated as an opaque notification; campaign identifiers or other fields from it are not trusted or persisted. Malformed frames, unrelated events, and frames from stale or replaced sockets are ignored safely.

The implementation owns:

- connection establishment and Pusher protocol framing;
- subscription and unsubscription messages;
- connection-level ping/pong behavior required by the protocol;
- reconnect and resubscribe behavior after an unexpected disconnect;
- target changes without retaining an obsolete category subscription;
- stale callback protection when a socket is replaced; and
- bounded pending English diagnostic events.

Kick's viewer WebSocket and realtime/Pusher service are different protocols and connections. The implementation may reuse the existing injectable minimal WebSocket interface, factory type, diagnostic queue, and proven lifecycle patterns, but it will not multiplex realtime subscriptions onto the viewer socket.

Realtime connection failure is discovery degradation, not watch failure. It must not mark the session unhealthy, interrupt farming, or trigger visible-tab fallback. The existing scheduler alarm remains the fallback discovery path.

## Deadline Feasibility

The existing safety margin protects ordinary rewards from being selected when transport, startup, or interruption latency makes completion unlikely. A two-minute reward whose entire advertised earn window is also approximately two minutes can fail that check immediately even when observed at launch.

The feasibility policy will waive only the configured safety margin when all of these conditions hold:

- the campaign is on Kick;
- the reward has valid `availableFrom` and `availableUntil` timestamps;
- the full earn-window duration differs from the reward's full required watch duration by no more than 5 seconds, accounting for timestamp rounding;
- the reward is observed no more than 15 seconds after `availableFrom`; and
- the raw remaining watch duration exceeds the remaining earn window by no more than the elapsed time since `availableFrom`, capped at 15 seconds.

The startup allowance therefore compensates only for realtime detection and watch-start latency at the beginning of a structurally exact-fit reward. Once the reward is more than 15 seconds old, or its raw deficit exceeds the capped elapsed time, it is infeasible. If its window is not approximately exact-fit, its timestamps are incomplete, or it belongs to another platform, the ordinary configured safety margin applies unchanged. Disabling `skipUnfinishableRewards` continues to bypass feasibility filtering as it does today.

This rule is a pure shared reward-feasibility policy, not state attached to a realtime event. Therefore a qualifying reward discovered shortly after launch by the normal fallback alarm receives the same treatment, while ordinary and genuinely impossible rewards remain excluded.

The 5-second exact-fit tolerance and 15-second launch allowance will be named constants. They are fixed bounds for timestamp granularity and the event-to-refresh startup path, not a percentage of campaign duration. Focused boundary tests will lock their values and rationale.

## Diagnostics and Failure Handling

All new diagnostics are English literals. No locale catalog keys will be added.

Expected diagnostic coverage includes successful subscription, valid campaign signal receipt, reconnect/resubscribe attempts, malformed frame handling at debug level, and connection failures at an appropriate warning or debug level. Persistent callback diagnostics use the existing bounded drain pattern so they are reported by the next controller operation without retaining an obsolete event collector.

Stopping or replacing an observer must release timers and sockets. Expected close callbacks and callbacks from replaced sockets must not create false failure diagnostics or refresh requests.

## Testing Strategy

Implementation will follow test-driven development with focused deterministic tests and injected sockets, clocks, and platform adapters.

Tests will cover:

- creation and lifecycle of the neutral observer for both visible-tab and tabless sessions;
- no observer for idle, disabled, unhealthy, offline, or insufficient-context sessions;
- category/channel changes stopping the obsolete subscription and starting the new one;
- correct Kick subscription and unsubscription frames;
- valid signal recognition and rejection of malformed, unrelated, and stale events;
- disconnect degradation, reconnection, and resubscription without farming interruption;
- repeated signal bursts producing at most one pending refresh;
- a signal during an active tick producing exactly one follow-up refresh;
- Kick-only refresh isolation from Twitch;
- refreshed campaigns continuing through canonical eligibility and priority behavior;
- default `ending_soonest` ranking a short-lived eligible campaign first;
- explicit user priority policy keeping another campaign first;
- just-launched exact-fit Kick rewards ignoring only the ordinary safety margin;
- boundary and near-miss cases retaining the margin; and
- genuinely unfinishable rewards remaining excluded.

Focused suites will run throughout development. Final verification is `pnpm verify` from the isolated worktree.

## Expected File Boundaries

- `packages/core/src/core/discoverySignals.ts`: platform-neutral contracts and reusable bounded diagnostics/lifecycle support where appropriate.
- `packages/core/src/platforms/adapter.ts`: optional observer factory on `PlatformAdapter`.
- `packages/core/src/platforms/kick/discoverySignals.ts`: Kick Pusher protocol and subscription lifecycle.
- `packages/core/src/platforms/kick/index.ts`: construct the Kick observer using injected transport dependencies.
- `packages/core/src/background/controller.ts`: observer reconciliation, callback ownership, and per-platform refresh coalescing.
- `packages/shared/src/rewards.ts`: narrow exact-fit launch feasibility policy.
- `packages/extension/tests/`: focused observer, controller, scheduler-priority, and feasibility tests.

The scheduler receives no Kick-specific concepts and should require no realtime protocol changes.
