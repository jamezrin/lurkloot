# Scheduler tick baseline

Issue #452 is measured with credential-free, deterministic controller fixtures. The fixtures use normalized campaign and channel models; they contain no cookies, tokens, authorization headers, or raw authenticated provider payloads.

Run the focused extension and CLI matrices from the repository root:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension test -- tickBaseline.test.ts
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli test -- run.test.ts -t "baseline"
pnpm --filter @lurkloot/extension exec vitest run tests/twitchCampaignDetailsReuse.test.ts --reporter=dot
pnpm --filter @lurkloot/extension exec vitest run tests/adapters.test.ts --reporter=dot
```

To stream every opted-in JSON record even when its test passes, run the focused files directly:

```bash
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/extension exec vitest run tests/tickBaseline.test.ts --disableConsoleIntercept --reporter=dot
LURKLOOT_TICK_BASELINE=1 pnpm --filter @lurkloot/cli exec vitest run tests/run.test.ts -t "baseline" --disableConsoleIntercept --reporter=dot
```

Each `TICK_BASELINE` line is JSON containing the host, provider, scenario, aggregate work counts, and controlled-clock durations. Normal test runs do not print these records.

The controlled clock assigns fixed costs to observable boundaries:

- discovery request: 30 ms, or 300 ms in the slow-response scenario;
- candidate listing and channel validation: 10 ms each, or 100 ms each in the slow-response scenario;
- watcher preparation: 5 ms;
- each extension persisted state commit: 5 ms. CLI persistence is intentionally not assigned a synthetic duration because the production run loop no longer exposes test-only hooks.

These values are not production latency claims. They prove that phase attribution and total duration remain deterministic when work counts change. Environment-specific before/after tables and live limitations belong in issue #452 so the repository does not preserve stale timing snapshots.

The four-cell matrix covers idle, stable retained watch, real target switch, a higher-priority target that is unavailable followed by retention of the current watch, failed discovery, and slow discovery/selection for Twitch and Kick in both hosts.

The `heartbeatOverlap` row additionally drives the real shared controller through each host wrapper: the extension's named alarm dispatcher and the CLI's recurring discovery and heartbeat timers. A seeded normalized tabless session is due for one heartbeat while campaign refresh and the watcher heartbeat are held at test-owned deferred boundaries. The harness releases discovery, then heartbeat, on consecutive controlled-clock steps and derives the two blocking counters from the observed milestone order:

- `heartbeatAttempts` counts normalized `TablessWatchController.tick` calls;
- `heartbeatBlockedByDiscovery` is `1` when heartbeat start is observed only after discovery reaches channel validation;
- `discoveryBlockedByHeartbeat` is `1` when discovery reaches channel validation only after heartbeat transport finishes.

Therefore `heartbeatAttempts: 1`, `heartbeatBlockedByDiscovery: 0`, and `discoveryBlockedByHeartbeat: 0` demonstrate progress ordering for this controlled overlap. They do not claim universal production latency, network performance, or an absence of unrelated host scheduling delay.

Related scheduler entry paths and concurrency boundaries remain pinned by focused deterministic tests rather than duplicated inside every matrix cell:

- extension alarm dispatch: `backgroundEntrypoint.test.ts` asserts Twitch and Kick alarm names dispatch targeted `alarm` ticks;
- manual/settings overlap: `backgroundController.test.ts` covers a pending manual claim while the sibling scheduler completes, settings patches during active work, and non-overlapping settings reconciliation;
- heartbeat isolation: `backgroundController.test.ts` blocks Twitch heartbeat work and proves Kick heartbeat and persistence complete independently;
- claim handoff: `backgroundController.test.ts` covers independent cross-platform handoffs, immediate post-claim heartbeats, and duplicate-handoff suppression;
- discovery-signal overlap: `backgroundController.test.ts` proves bursts coalesce into one non-overlapping follow-up.

The CLI interval baseline blocks one refresh across another elapsed interval. It proves provider work stays serialized by the controller lock, but every elapsed interval is queued and later runs. Changing that policy remains in #394; the planned implementation order remains #336 → #394 → #395 → #337.

## Counting semantics

- `adapterOperations` counts calls across the normalized `PlatformAdapter` boundary, including the authentication probe and discovery/selection operations. It deliberately does not claim to count HTTP requests: an adapter operation may issue zero, one, or several transport requests. Provider transport request counts belong in focused adapter tests.
- `watcherReconciliations` counts observable watcher preparation, not a no-op traversal of the controller's watcher map.
- The overlap blocking counters are calculated from observed controller milestones. The harness never assigns zero merely because it released a deferred operation.
- `eventPublications` counts non-empty aggregate batches passed to the host reporter, not individual diagnostic or activity records.
- Authentication health is saved before scheduler work so a later failure cannot erase the health observation. That makes two state saves per measured tick intentional.
- `observedControllerMs` is parsed from the controller's emitted refresh, selection, and tick-completion diagnostics; assertions therefore verify the production timing instrumentation rather than only the fixture clock.
- Real Twitch transport counts are pinned in `twitchCampaignDetailsReuse.test.ts`: the three-campaign cold refresh performs three `fetchJson` calls, while the following warm refresh adds only inventory and dashboard (five cumulative). `adapters.test.ts` pins a Kick refresh at two concurrent transport calls (campaigns and progress). The host matrix does not relabel adapter calls as HTTP requests.

PR #450 / issue #339 merged before this baseline. Its Twitch campaign-details reuse is part of the starting behavior.
