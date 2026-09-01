# Scheduler tick baseline

Issue #452 is measured with credential-free, deterministic controller fixtures. The fixtures use normalized campaign and channel models; they contain no cookies, tokens, authorization headers, or raw authenticated provider payloads.

Run the focused extension and CLI matrices from the repository root:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension exec vitest run tests/tickBaseline.test.ts --reporter=dot
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli exec vitest run tests/run.test.ts --reporter=dot
```

Each `TICK_BASELINE` line is JSON containing the host, provider, scenario, aggregate work counts, and controlled-clock durations. Normal test runs do not print these records.

The controlled clock assigns fixed costs to observable boundaries:

- discovery request: 30 ms, or 300 ms in the slow-response scenario;
- candidate listing and channel validation: 10 ms each, or 100 ms each in the slow-response scenario;
- watcher preparation: 5 ms;
- each persisted state commit: 5 ms.

These values are not production latency claims. They prove that phase attribution and total duration remain deterministic when work counts change. Environment-specific before/after tables and live limitations belong in issue #452 so the repository does not preserve stale timing snapshots.

The matrix covers idle, stable retained watch, target switch, unavailable candidate, failed discovery, and slow discovery/selection for Twitch and Kick in both hosts. Existing controller tests separately block Twitch work and prove Kick completes independently. Timer/heartbeat isolation and trigger coalescing remain ordered work in #336, #394, and #395.

## Counting semantics

- `providerRequests` includes the authentication probe and adapter discovery/selection calls.
- `watcherReconciliations` counts observable watcher preparation, not a no-op traversal of the controller's watcher map.
- `eventPublications` counts non-empty aggregate batches passed to the host reporter, not individual diagnostic or activity records.
- CLI state loads include the post-tick read used to report subscription waits; extension has no equivalent wrapper read.
- Authentication health is saved before scheduler work so a later failure cannot erase the health observation. That makes two state saves per measured tick intentional.

PR #450 / issue #339 merged before this baseline. Its Twitch campaign-details reuse is part of the starting behavior.
