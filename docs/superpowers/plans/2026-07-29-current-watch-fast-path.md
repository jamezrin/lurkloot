# Current Watch Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a steady-state Twitch scheduler tick validate the current watch once instead of scanning every eligible campaign and candidate first.

**Architecture:** Derive the highest-priority campaign and active reward locally from the refreshed campaign inventory. When they match the current session, call the existing watch-retention validation before global channel selection and reuse its result. Fall back to the existing full selection path whenever the current target is no longer preferred or validation says it must switch.

**Tech Stack:** TypeScript, Vitest, pnpm workspace.

## Global Constraints

- Keep platform behavior behind `PlatformAdapter`.
- Keep `@lurkloot/core` free of WXT and browser globals.
- Diagnostics are English literals and platform-scoped.
- Preserve current campaign priority, channel exclusion, retry, playback, and fallback behavior.
- Use deterministic tests with mocked adapters.

---

### Task 1: Add a steady-state retention decision

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `sortCampaigns`, `isEligible`, `activeReward`, `shouldKeepWatching`.
- Produces: an internal fast-path result that contains a retained `WatchDecision` and retention health counters.

- [ ] **Step 1: Write the failing steady-state test**

Create a watching session whose campaign/reward remains the first locally ranked target. Give `listCandidateChannels` many candidates and assert it is never called, while `checkChannel` is called exactly once for the current channel and the resulting reason is `keeping_current_watch`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: the new assertion fails because `chooseCampaignDecision` currently calls `listCandidateChannels` before `shouldKeepWatching`.

- [ ] **Step 3: Implement the minimal fast path**

Add an internal helper that:

```ts
type CurrentWatchFastPath = {
  decision: WatchDecision;
  keep: Awaited<ReturnType<typeof shouldKeepWatching>>;
};
```

It must return `undefined` unless the session is watching, has a channel, and its campaign/reward IDs match the first eligible sorted campaign and that campaign's active reward. For a match, construct a current-target decision, call `shouldKeepWatching` once, and return only when `keep.keep` is true.

- [ ] **Step 4: Integrate before global selection**

Call the helper before `chooseCampaignDecision`. On a retained result, skip global selection, reuse its validation result, and emit:

```text
Campaign selection fast path retained current watch in <N>ms (1 candidate checked)
```

Otherwise run the existing global selection and retention flow unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: all scheduler and workspace extension tests pass.

### Task 2: Prove reselection behavior remains intact

**Files:**
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: the fast path from Task 1.
- Produces: regression coverage for priority and completed-reward invalidation.

- [ ] **Step 1: Write failing/regression tests**

Add cases asserting:

- A newly higher-priority campaign bypasses the fast path and performs full candidate selection.
- A completed or claimable current reward bypasses the fast path and selects the next reward.
- A failed current-channel validation falls through to full selection without reusing the failed retention result.

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- scheduler.test.ts
```

Expected: all new cases pass after the minimal implementation, or reveal a concrete fast-path gap to fix.

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm verify
```

Expected: script tests, all package typechecks/tests, site build, and Chromium/Firefox extension builds pass.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-07-29-current-watch-fast-path.md packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "perf(scheduler): retain current watch before reselection"
```
