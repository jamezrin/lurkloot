# Kick discovery performance implementation plan

> Execute inline with systematic debugging, TDD, and verification-before-completion; no subagents or publication.

**Goal:** Meet issue #498 by avoiding statically unnecessary Kick discovery and bounding/deduplicating the remaining channel requests.

**Architecture:** Keep inventory in the shared snapshot collector, evaluate static farmability before candidate enumeration using the captured settings and time, and add an optional adapter bulk-check boundary. Kick owns a revision-local response cache and three workers; each campaign still derives its own category check and candidate metadata. Results remain ordered; all workers settle before publication or failure.

**Base:** Explicit stack on reviewed #497 commit `c9669a0e`, branch `perf/kick-discovery-performance`. Audited `origin/develop=d948ab88` and all open PRs on 2026-09-09. #500 modifies cycle observation around the Kick fetcher; preserve its lifecycle and ensure workers drain before discovery returns. #490 publication handling is already carried by #497. Other open PRs affect dependencies/UI/release integration.

**Constraints:** Shared extension/CLI core; preserve inventory, priority, unknown campaign eligibility, abort propagation and coherent snapshots. No permissions or sensitive diagnostics. Cache raw provider evidence only within one revision, then apply each request's campaign/category separately. Stop admitting work after failure; await active work. HTTP 429 must not generate page-fallback retries.

## Task 1: Pre-discovery gate

- [ ] Add table-driven collector tests with completed, expired, excluded, unlinked-disallowed, subscription-disallowed, category-filtered, infeasible and blocked reward fixtures; assert inventory unchanged and no channel listing/checks. Include eligible/unlinked-allowed/claimable positive controls.
- [ ] Observe red with `pnpm --filter @lurkloot/extension exec vitest run tests/kickDiscoveryPerformance.test.ts`.
- [ ] Add optional settings to `collectDiscoverySnapshot`; use `evaluateCampaignFarming(campaign, settings, { includePriorityMode: true, now })` before retained observations/listing. Pass settings from controller; count skipped campaigns in metrics and diagnostics.
- [ ] Repeat focused suite to green; commit gate changes.

## Task 2: Revision-local bounded Kick checks

- [ ] Write real Kick-adapter tests using controlled PageFetcher responses: duplicate channel across same/different categories, metadata preservation, fresh evidence on the next revision, three active workers and deterministic output, cancellation/failure with active-worker drain, rate-limit no fallback.
- [ ] Observe red before adding optional `checkChannels(requests, options)` adapter capability returning ordered checks and unique check count.
- [ ] Collector accumulates eligible campaign/idle candidates and invokes bulk checks once. Kick uses three workers and a scoped raw-response promise cache; apply channel metadata independently. Existing single checks retain their behavior.
- [ ] Require complete progress/evidence for snapshot refreshes; failed bulk/progress refresh keeps the old snapshot.
- [ ] Run focused tests to green; commit bulk changes.

## Task 3: Integration, diagnostics and verification

- [ ] Add controlled-latency and request-count coverage for idle, retained watch, and target switch through real Kick adapter, collector and snapshot selection; assert diagnostics carry campaign/skipped/unique counts and duration.
- [ ] Run focused controller/adapter/discovery/baseline tests; fix regressions with observed failing cases.
- [ ] Document the new discovery contract in `docs/architecture.md`.
- [ ] Run fresh `pnpm verify`, self-review diff and acceptance criteria, commit final coverage/docs. Report base, commits, verification and #500 integration concerns without pushing.
