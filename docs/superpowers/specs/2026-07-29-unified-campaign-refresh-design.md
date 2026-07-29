# Unified Campaign Refresh Design

## Goal

Replace the scheduler's fixed `discoverCampaigns` then `readProgress` sequence
with one adapter-owned campaign refresh operation. Each platform will choose the
most efficient request plan while returning the same fully reconciled
`DropCampaign[]` snapshot the scheduler consumes today.

## Adapter Contract

`PlatformAdapter` will expose:

```ts
refreshCampaigns(
  session?: WatchSession,
  options?: AdapterOperationOptions,
): Promise<DropCampaign[]>;
```

The scheduler will call this method once per enabled platform and will no longer
coordinate discovery and progress reconciliation as separate operations.
Platform-specific request ordering, concurrency, parsing, and partial-failure
behavior remain inside the adapter.

The existing `discoverCampaigns` and `readProgress` methods will be removed
rather than retained as competing scheduler contracts. Internal adapter helpers
may keep those names where they still clarify platform-specific phases.

## Twitch Data Flow

Twitch refresh will:

1. Fetch inventory and the drops dashboard concurrently.
2. Fetch campaign details in the existing bounded GraphQL batches.
3. Merge the inventory progress already obtained during discovery into the
   detailed campaigns.
4. If an active Twitch watch session exists, perform only the additional
   current-session reconciliation needed for that session.

It will not issue a second inventory request immediately after discovery.
Existing retained campaign-detail behavior, authentication failures, integrity
retry behavior, and malformed-response fallbacks remain unchanged.

## Kick Data Flow

Kick refresh will fetch `/drops/campaigns` and `/drops/progress` concurrently,
then parse the campaign definitions and merge the progress response.

If campaign discovery fails, the refresh fails as it does today. If the progress
request fails with a non-authentication error, Kick returns the parsed campaigns
with their last-known/default progress and emits the existing warning.
Authentication failures and cancellation continue to propagate.

## Scheduler Behavior

The scheduler will measure one platform refresh and emit:

```text
Campaign refresh finished in Nms (X campaigns)
```

Platform adapters will retain their detailed phase diagnostics, including
Twitch campaign-detail batching and Kick progress fallback warnings. All later
scheduler behavior—claiming, eligibility filtering, campaign selection,
critical-health observation, and state persistence—continues to operate on the
returned campaign array without semantic changes.

## Compatibility and Migration

All first-party adapters and deterministic test adapters will migrate to the new
method in the same change. Core remains browser-free. No shared persisted state,
settings schema, browser permissions, or locale catalogs change.

The CLI receives the optimization automatically because it uses the same core
adapters.

## Testing

Tests will prove:

- The scheduler invokes one refresh operation instead of a discover/read pair.
- Twitch performs only one inventory request per non-watching refresh.
- Twitch still performs active-session reconciliation without repeating the
  base inventory request.
- Kick begins campaigns and progress requests concurrently.
- Kick preserves campaigns when progress fails non-fatally.
- Kick propagates authentication failures and cancellation.
- Existing claim, selection, diagnostics scoping, and platform isolation tests
  remain green.

Full verification will run workspace checks plus Chromium and Firefox builds.
