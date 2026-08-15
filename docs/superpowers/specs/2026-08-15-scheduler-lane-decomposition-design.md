# Scheduler Lane Decomposition Design

## Purpose

Keep the active Twitch or Kick watch transport on a fixed, low-latency cadence while campaign discovery, channel availability refresh, and target selection run independently. Slow provider APIs must not postpone the operation that maintains farming progress.

This design decomposes the work into separate GitHub issues. It does not fold the refactor into the Twitch availability correction tracked by #392.

## Current behavior and root cause

The controller already has a dedicated one-minute watch alarm. However, `runPlatformWatchHeartbeat()` and the normal scheduler tick both acquire the same per-platform state lock. A discovery tick holds that lock across campaign refresh, candidate discovery and validation, scheduler evaluation, watcher reconciliation, and persistence. When discovery wins the lock, a due heartbeat waits for all of that work.

Campaign discovery and target selection are also one operation today. This means selection cannot use a stable last-known discovery result independently, and refreshing provider data always participates in the same critical path as state mutation.

The problem affects both providers even though their evidence differs:

- Twitch has campaign details, channel liveness/category checks, and channel-specific `AvailableDrops` evidence.
- Kick has campaign metadata and ACL/category-derived candidates, plus fresh channel liveness/category checks, but no Twitch-equivalent channel-specific campaign availability query.

The architecture must preserve those provider differences behind `PlatformAdapter` rather than inventing a false shared notion of authoritative availability.

## Chosen architecture

Each enabled provider has three logical lanes.

### 1. Watch lane

The watch lane maintains only the currently committed watch target. It runs on a fixed 60-second target cadence for both Twitch and Kick and does not perform campaign refresh, candidate enumeration, target prioritization, or routine auth-health probing.

The next due time is anchored to the previous heartbeat attempt rather than to completion of ancillary processing. Browser alarms may fire late, so the lane calculates lateness from persisted timing state instead of assuming exact alarm delivery.

The lane reads an immutable, internally consistent watch-context snapshot containing all values needed by the provider transport, such as platform, channel identity, broadcast identity, campaign/reward identity, and transport-specific session data. A concurrent handoff can expose either the old committed snapshot or the new committed snapshot, never a mixture.

Starting or switching a target may request an immediate heartbeat. Due-time accounting deduplicates that send against the next scheduled attempt.

Heartbeat result persistence and diagnostics use a short commit section. Discovery network work cannot hold the synchronization primitive needed to read the watch snapshot or transmit the heartbeat.

### 2. Discovery lane

Each provider periodically refreshes a provider-owned, in-memory discovery snapshot. A snapshot contains normalized campaigns and the candidate/availability observations that the provider can actually support, together with observation timestamps, completeness, and failure/ambiguity metadata.

Only one discovery refresh may run per provider. If another refresh becomes due while one is running, the controller records at most one pending refresh; it never queues every missed interval. Twitch and Kick refresh independently.

Provider-specific batching, caching, TTLs, and fail-open interpretation remain inside the adapters. A refresh failure or incomplete response does not replace the last successful coherent snapshot with an empty or authoritative-negative result. A Manifest V3 service-worker restart may begin with a cold in-memory snapshot and fetch again.

“Periodically check channels” is bounded. The adapter operates on the provider's current campaign candidate set and existing batching/rate-limit constraints. The controller does not continuously probe every possible channel, and it does not require Kick to produce channel-specific eligibility evidence that Kick's APIs do not expose.

### 3. Selection lane

Selection consumes only committed discovery snapshots. It runs when:

- a provider publishes a materially changed snapshot;
- the current watch becomes invalid or unhealthy;
- a claim requires a handoff;
- relevant settings change; or
- the user explicitly requests refresh/resume.

Selection does not run as part of the 60-second watch heartbeat. It may retain the current target using the latest known-good snapshot while discovery is incomplete or failing. This preserves the existing fail-open principle: ambiguity must not stop a healthy current watch, while a fresh explicit negative may still reject a candidate according to provider rules.

Publishing a newly selected target is an atomic handoff to the watch lane. Selection can be slow without delaying an already-due heartbeat for the old committed target.

## State and synchronization boundaries

The refactor introduces narrow ownership rather than one platform-wide critical section:

- **Watch-context synchronization:** protects only reading/replacing the immutable active watch snapshot and transport lifecycle.
- **Discovery ownership:** protects one in-flight refresh and publication of a completed provider snapshot.
- **Scheduler-state commit:** serializes short persisted state merges so heartbeat health, selection results, settings changes, and platform state cannot overwrite one another.

Network calls must not execute while holding the scheduler-state commit lock. Operations carry a generation or snapshot revision and validate it before committing, so stale discovery or selection work cannot overwrite a newer target, identity, settings generation, or disabled platform.

## Timing semantics

- The watch target cadence is 60 seconds for Twitch and Kick.
- Cadence measures target attempt times and does not accumulate processing duration as drift.
- A late browser alarm produces one due attempt, not a burst of catch-up sends.
- Concurrent watch-alarm invocations coalesce per provider.
- Discovery cadence is independent and may remain configurable by existing polling settings.
- Discovery overruns coalesce; they never create an unbounded backlog.
- Snapshot publication may trigger selection immediately, but selection never preempts or blocks a due heartbeat.

## Failure behavior

- A heartbeat failure updates watch health and can invoke the existing bounded fallback behavior without waiting for discovery.
- A discovery failure retains the last coherent snapshot and emits aggregate diagnostics.
- An incomplete or ambiguous discovery result cannot invalidate a healthy current target.
- An explicit provider-supported negative can affect future selection according to its TTL and cache rules.
- Disabling a provider or automation invalidates outstanding generations, stops its transport, and prevents late work from republishing state.
- Auth or identity changes invalidate provider caches and outstanding discovery/selection results before they can commit.

## Diagnostics

Diagnostics remain aggregate and English-only. They should distinguish:

- scheduled heartbeat due time, actual attempt time, and internal delay;
- browser-alarm lateness from time spent waiting on internal synchronization;
- discovery start/finish, duration, revision, completeness, and coalescing;
- selection trigger, consumed snapshot revision/age, and outcome;
- stale work discarded because its generation no longer matches.

No per-candidate diagnostic stream is introduced.

## Issue decomposition

### Issue A: expand #336 into a provider-neutral watch lane

Scope:

- Twitch and Kick fixed 60-second watch cadence;
- immutable atomic watch-context snapshots;
- heartbeat transmission independent of discovery and selection locks;
- immediate start/switch heartbeat deduplication;
- restart recovery from persisted timing state;
- existing heartbeat failure and tab fallback behavior;
- timing and contention diagnostics.

Out of scope: campaign/channel refresh, target ranking, stalled-progress detection, and transport canaries.

### Issue B: asynchronous provider discovery snapshots

Scope:

- provider-owned Twitch and Kick snapshot models;
- independent periodic refresh per provider;
- single-flight refresh with one coalesced pending request;
- bounded candidate checking using provider capabilities;
- coherent publication and last-good retention;
- cache/identity/settings invalidation;
- aggregate refresh diagnostics.

Out of scope: changing prioritization rules or watch transport cadence.

Existing #339 remains a Twitch discovery optimization inside this lane. Existing #337 remains a policy for backing off costly negative higher-priority searches and must preserve the #392 fail-open correction.

### Issue C: snapshot-driven selection and invalidation

Scope:

- selection reads committed snapshots instead of performing refresh inline;
- material snapshot changes trigger selection;
- explicit user/settings/claim/current-watch-invalid triggers;
- stale-snapshot fail-open retention of a healthy target;
- atomic publication of a selected watch context;
- selection revision and reason diagnostics.

Out of scope: stalled-progress detection (#53/#107) and independent transport canaries (#51).

## Delivery order

1. Issue A isolates the latency-critical watch lane without requiring the discovery data model to change.
2. Issue B creates independently refreshed, provider-owned discovery snapshots.
3. Issue C moves selection onto those snapshots and removes discovery from selection's synchronous path.

#339 and #337 can improve Twitch discovery before or during Issue B, but they do not substitute for Issue A. The #392 correction lands independently and its fail-open behavior becomes an invariant for Issues B and C.

## Testing strategy

Issue A tests use blocked discovery promises and a fake clock to prove both providers transmit a due heartbeat without waiting, avoid drift and duplicate sends, survive restart, and keep channel/broadcast/campaign context atomic during a handoff.

Issue B tests use fake adapters and clocks to prove per-provider single-flight execution, coalescing, independent Twitch/Kick progress, last-good retention, bounded candidate work, identity invalidation, and stale-result rejection.

Issue C tests prove selection consumes a named snapshot revision, reacts only to material changes or explicit triggers, retains healthy watches on ambiguous/stale data, rejects supported explicit negatives, and cannot publish a stale target after settings, identity, or target generations change.

Cross-cutting controller tests block each lane independently to demonstrate that no network-bound lane prevents the 60-second watch attempt.

## Success criteria

- A due Twitch or Kick heartbeat is not delayed by campaign refresh, channel checks, auth probing, notification work, or target selection.
- Heartbeat attempts remain anchored to a 60-second target without cumulative processing drift.
- Discovery remains fresh on its own cadence without overlapping or accumulating missed runs.
- Selection reacts to coherent completed observations without placing discovery back on the watch path.
- Healthy current farming survives ambiguous or failed refreshes.
- Twitch and Kick retain their real provider-specific eligibility semantics.
