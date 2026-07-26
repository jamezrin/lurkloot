# Twitch Discovery Retention State Design

## Problem

`TwitchAdapter` retains the last successful dashboard campaign IDs and campaign-detail responses for 30 minutes so transient Twitch failures do not remove campaigns that are absent from inventory. The extension and CLI reconstruct their adapters for each controller operation or tick, so the adapter-owned retention state is discarded before it can protect the next refresh.

## Scope

Retention must survive `TwitchAdapter` reconstruction during the lifetime of one extension background process or CLI transport. It does not need to survive an extension/background restart, browser restart, or CLI restart. The existing 30-minute expiration remains unchanged.

The fix must preserve these behaviors:

- Transient dashboard failures reuse the last successful dashboard campaign IDs.
- Transient campaign-detail failures reuse the last successful detail response for that campaign.
- Authentication failures still propagate.
- A successful empty dashboard is authoritative and clears the retained dashboard campaign IDs.
- Extension and CLI hosts use the same retention semantics.
- Adapters continue to receive current settings, compatibility resolution, event emitters, and operation-scoped ports when reconstructed.

## Design

Add an exported `TwitchDiscoveryState` class to the Twitch platform module. It owns only the process-lifetime discovery data:

- the retained dashboard campaign IDs and their expiration;
- the campaign-detail response map and each entry's expiration.

The state exposes focused methods to remember and retrieve those values. Retrieval removes expired entries. Remembering a successful empty dashboard stores an empty ID list, so a later failure cannot revive obsolete campaigns.

`TwitchAdapterOptions` gains an optional `discoveryState`. A `TwitchAdapter` uses the supplied state or creates a private state when none is supplied. The private default preserves existing standalone callers and tests without introducing global state.

Each host creates one shared state at its existing process-lifetime boundary:

- The extension background module creates one state beside other long-lived host state and passes it through every `createAdapters` call.
- Each CLI HTTP or impersonate transport creates one state when the transport is created and passes it through every transport `createAdapters` call.

This follows the existing injected-state pattern used by `KickClaimState`. It keeps Twitch-specific retention inside the Twitch platform implementation while allowing short-lived adapters to share it.

## Alternatives Considered

### Persist a `TwitchAdapter`

Keeping one adapter instance would preserve its cache, but would also retain compatibility settings, emitters, and operation-scoped ports. Those dependencies are intentionally refreshed, so adapter persistence has a larger and less safe lifecycle.

### Move retention into the controller

The controller is process-lived and could retain complete discovery results, but it would need knowledge of Twitch-specific dashboard and campaign-detail failure semantics. That would weaken the platform abstraction and duplicate logic already owned by `TwitchAdapter`.

### Use module-global state

A module singleton would survive reconstruction with minimal wiring, but would leak state between independently created transports, tests, or identities in the same process. Explicit host-owned injection gives each runtime instance a clear isolation boundary.

## Data Flow

1. A host creates one `TwitchDiscoveryState`.
2. Each controller operation constructs a fresh `TwitchAdapter` with current dependencies and the shared state.
3. Successful Twitch dashboard and detail responses update the shared state with a 30-minute expiration.
4. A later adapter reads the shared state only when the corresponding Twitch request fails.
5. Successful responses, including an empty dashboard, remain authoritative and replace retained data.
6. State disappears naturally when the extension background process or CLI transport ends.

## Testing

Adapter regression tests will share one `TwitchDiscoveryState` across two separate `TwitchAdapter` instances:

- The first adapter completes discovery successfully.
- The second adapter encounters a dashboard failure and still returns a previously discovered campaign not present in inventory.
- The second adapter encounters a campaign-detail failure and still returns the retained campaign details.
- A separate reconstruction test receives a successful empty dashboard and confirms obsolete dashboard campaigns are not retained.

Host tests or source-boundary assertions will verify that the extension background and both CLI transports create one state outside their adapter factories and inject it into reconstructed Twitch adapters.

Focused adapter, controller/transport, boundary, and typecheck tests will run before the repository-wide verification command.

## Non-Goals

- Persisting retention data in browser or filesystem storage.
- Changing the 30-minute retention window.
- Retaining complete `TwitchAdapter` instances.
- Changing scheduler campaign replacement behavior.
- Generalizing this state into a cross-platform cache abstraction.
