# Kick Page-Context Recovery Design

## Goal

Close an extension-owned Kick fallback page after direct background access has demonstrably recovered, without closing user tabs or treating a burst of requests from one scheduler cycle as sustained recovery.

This change replaces the current hard-coded request-count-plus-time policy with a configurable count of successful Kick scheduler cycles. The extension exposes a recovery threshold from 1 through 10, defaulting to 3.

## Problem

When a direct Kick request from the extension service worker fails, the extension opens and retains one managed `kick.com` page context. Retaining that page is necessary while page-based requests remain the only working transport.

The current recovery code counts successful individual background requests, requires at least three successes, and also requires ten minutes since the last fallback. This does not model sustained recovery:

- one discovery tick may issue more than 40 requests and satisfy the request count immediately;
- there is no dedicated reevaluation at the ten-minute boundary;
- page-context metadata is updated from request callbacks while scheduler snapshots and service-worker recovery also hydrate and persist the same context;
- a real 1.12.2 diagnostic capture recorded one transient fallback, immediate background success, more than 23,000 later successful `kick.com` background requests, and no automatic closure during the following ten and a half hours.

The page was eventually reported as already gone when unrelated manual-watch cleanup ran. The user independently confirmed observing retained Kick fallback pages that outlive their need.

## Scope

This design covers only Kick page-context recovery and its advanced extension setting. It does not optimize Kick discovery or aggregate fetch-route diagnostics. Those are tracked separately in #498 and #499. Per-platform scheduler-trigger admission is tracked in #497.

## Recovery Unit

A recovery success is one completed canonical Kick scheduler cycle, not one HTTP request.

All extension-owned Kick fetchers record compact route evidence in one host-owned tracker shared by discovery adapters and the retained tabless watcher:

- whether any direct background request succeeded;
- whether any request fell back to the retained page context;
- the safe host or hosts involved; and
- the completion order of fallback hosts, so recovery follows the most recently required route.

After scheduler state persists, the controller invokes the browser-host reconciliation seam. The host drains that observation exactly once:

- any page fallback resets consecutive recovery successes to zero and refreshes the fallback metadata;
- no fallback plus at least one successful direct background request increments the counter once;
- a cycle with no relevant request leaves the counter unchanged;
- an aborted, failed, discarded, stale, incomplete, or uncommitted cycle does not increment the counter, but any fallback it observed still resets recovery;
- multiple scheduler triggers that consume one coalesced discovery attempt cannot count that attempt more than once.

The tick's unconditional cleanup discards any evidence left after an aborted, stale, or otherwise uncommitted path. Fallback dependency is not lost because a successful page fallback updates the retained-tab registry immediately; only its non-durable aggregate observation is discarded.

This definition makes the default threshold of 3 mean three distinct successful scheduler cycles. At the default one-minute polling interval, that is normally about three minutes of confirmed recovery.

## Setting

Add `kickPageContextRecoverySuccesses` to extension settings:

- type: integer;
- default: 3;
- normalized range: 1–10;
- UI location: General → Advanced;
- enabled only when Kick is enabled;
- description: the number of successful background-access checks required before Lurkloot closes a fallback Kick page;
- changing the value does not itself count as a success, but the next qualifying cycle applies the new threshold to the existing counter.

This is an extension-only setting because retained browser page contexts do not exist in the CLI. It must not be added to `EngineSettings` or the CLI configuration schema. The extension injects the normalized threshold at the browser-owned recovery seam.

## Component Boundaries

### Kick transport observation

`createKickFetcher` continues to own the decision between direct background fetch and page fallback. Successful route callbacks feed one extension-host tracker supplied to every Kick adapter construction, including the adapter captured by the controller-lifetime `KickWatcher`. Raw URLs, headers, credentials, tokens, and payloads are never retained.

The tracker exposes a drain-and-restore snapshot. Draining clears accumulated evidence; a failed reconciliation restores it without reordering newer fallback evidence that arrived concurrently. Page fallback also updates the retained-tab registry immediately, after the page request succeeds, so the next heartbeat state commit makes that dependency durable across service-worker suspension.

### Controller reconciliation

After a Kick platform tick persists current state, the background controller invokes an injected host reconciliation callback. The callback owns the shared tracker and is optional so browser-free core and CLI hosts remain valid.

Fallback evidence is reconciled after both successful and failed persisted attempts so it cannot be consumed and discarded on snapshot-less paths. Background success is eligible to advance recovery only after a complete discovery attempt and an error-free scheduler result. Retaining the previous snapshot after incomplete discovery therefore neither stalls fallback reconciliation nor falsely advances recovery.

### Browser page-context registry

The browser implementation remains the sole owner of actual tab removal. It applies the observation to the current retained Kick context and the configured threshold.

Recovery metadata remains attached to `ManagedPageContextTab` so it survives service-worker suspension. Updates use the page-context registry revision and the normal latest-state merge boundary so an older scheduler snapshot cannot restore a context after recovery closed it or overwrite a newer counter.

The obsolete ten-minute minimum and request-level increment logic are removed. Request-level fallback notification may still mark or refresh the retained context immediately, because a fallback must reset recovery before the cycle finishes.

## State Transitions

### No retained context

Background successes have no page-context effect. No counter is created.

### Fallback required

The extension opens or reuses at most one retained extension-owned Kick context. It records the safe fallback host, sets consecutive successes to zero, and emits the existing open/retention activity or diagnostic.

Any later fallback resets the counter to zero, including a fallback occurring in a cycle that also contained earlier background successes.

### Recovery being confirmed

Each distinct successfully committed Kick cycle with background success and no fallback increments the counter once. Intermediate confirmations use a bounded diagnostic that states the current and required cycle counts. They do not emit one message per HTTP request.

### Recovery confirmed

When the counter reaches the configured threshold, the browser verifies that the exact extension-owned tab id still has the retained origin. Immediately before the asynchronous close, it releases that exact ownership entry so a concurrent fallback must acquire a fresh managed context. It then closes the recovered tab and emits `page_context_closed` with reason `background_recovered`.

If the tab is already gone or its id now belongs to a different origin, it forgets the registry/state entry and emits the existing safe diagnostic. If the URL is temporarily unavailable during navigation or tab removal is unavailable, ownership remains for a later safe retry. A failed removal restores the old ownership only when no newer context replaced it. A registry revision check prevents a newer fallback arriving during asynchronous tab verification from being closed underneath its request.

### Lifecycle cleanup

Kick disablement, automation stop, reset, shutdown, manual-watch cleanup, and managed-tab invalidation preserve their existing immediate cleanup rules. They do not wait for recovery confirmation.

User-owned tabs are never registered as extension-owned recovery contexts and are never closed by this path.

## Concurrency and Restart Safety

- Page fallback wins over success within the same cycle.
- A drained observation can affect the counter at most once, and is restored on reconciliation failure.
- Only the current retained context tab id and current lifecycle generation may be mutated.
- Registry mutation and persisted-state merge use revision checks; stale reads retry or are discarded.
- Asynchronous tab verification rechecks registry ownership before removal; unreadable or concurrently updated ownership is retained.
- Service-worker restart hydrates the retained context and its counter from state, but cannot hydrate an entry whose tab no longer exists.
- Adapter replacement does not lose evidence because all extension Kick adapters share the host tracker.
- Every tick exit discards residual, non-counting tracker evidence, preventing an aborted or stale cycle's background success from leaking into the next committed cycle.
- The fix must remain correct when #497 later coalesces scheduler triggers more aggressively.

## Diagnostics and Activity

Keep diagnostics English-only and free of sensitive request data.

Required lifecycle evidence:

- page fallback opened or retained the managed context;
- recovery confirmation advanced from cycle N to the configured threshold;
- a new fallback reset recovery confirmation;
- recovery closed the context;
- the context was forgotten because the tab was already gone; and
- a lifecycle callback or tab removal failed safely.

The existing structured `page_context_opened` and `page_context_closed` activities remain the user-facing lifecycle events. Their automatic English diagnostic mirrors remain generated by `activityDiagnostics`; emit sites must not add hand-written duplicate diagnostic counterparts.

Issue #499 separately changes high-volume unchanged fetch-route messages. This fix may suppress request-level recovery-confirmation messages where cycle-level reporting replaces them, but it does not otherwise redesign transport aggregation.

## Testing

Use deterministic Vitest coverage with mocked browser and storage dependencies.

### Settings

- defaults to 3;
- clamps values outside 1–10 consistently with existing settings normalization;
- appears in the Advanced popup registry with localized title, description, and disabled reason where applicable;
- remains extension-only and is rejected or absent from CLI configuration.

### Recovery behavior

- 40 successful requests in one cycle count as one success;
- three qualifying cycles close the context at the default threshold;
- thresholds 1 and 10 close on exactly their respective qualifying cycle;
- a fallback after successes resets the count;
- a mixed success/fallback cycle counts as fallback, not recovery;
- failed, aborted, discarded, stale, incomplete, and uncommitted cycles do not increment but retain fallback resets;
- draining the same observation twice cannot double-count, and restore preserves newer fallback ordering;
- changing the setting applies on the next qualifying cycle;
- a background success for a different host does not confirm recovery for the fallback host.

### Ownership and lifecycle

- only an extension-owned retained tab is removed;
- a user-owned Kick tab is never removed;
- an already-closed tab is forgotten cleanly;
- disable, stop, reset, and manual-watch cleanup remain immediate;
- service-worker restart preserves the current counter and closes after the remaining cycles;
- stale scheduler persistence cannot resurrect a closed context or lower a newer counter;
- overlapping Kick ticks and adapter replacement cannot reuse stale evidence;
- Twitch page contexts and integrity handling are unaffected.

Run focused settings, tabs, controller, background-entrypoint, and popup tests, followed by `pnpm verify`.

## Rollout and Compatibility

Existing stored settings require no explicit migration: normalization supplies the default value. Existing retained contexts without recovery metadata begin at zero confirmations after upgrade. No browser permission, host permission, raw-provider persistence, or credential handling changes.

The CLI receives no behavior or configuration change. The host reconciliation contract remains optional for non-browser hosts; the tracker lives in core but is instantiated only by the extension host.

## Success Criteria

- A transient Kick background rejection no longer leaves an extension-owned page indefinitely.
- Default behavior closes it after three distinct successful Kick scheduler cycles without another fallback.
- One request-heavy cycle cannot satisfy the threshold by itself.
- Restarts and overlapping work cannot lose, duplicate, or resurrect recovery ownership.
- User-owned tabs remain untouched.
- Diagnostic volume grows by cycles and transitions rather than by recovery-related requests.
