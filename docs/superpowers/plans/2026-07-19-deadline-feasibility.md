# Deadline Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip watch rewards that cannot be completed before their earliest valid deadline, with one `-1..60` minute configuration shared by extension and CLI.

**Architecture:** A pure evaluator in `@lurkloot/shared/rewards` owns all deadline arithmetic and returns typed data. The core scheduler uses it for selection and retention, while popup view models use it for localized presentation; settings normalization supplies the same default and range to both hosts.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, React, WXT, JSONC.

## Global Constraints

- `deadlineSafetyMarginMinutes` defaults to `5`.
- `-1` disables feasibility filtering, `0` is strict feasibility, and `1..60` adds that many buffer minutes.
- Missing or invalid deadlines preserve current farmability.
- Exact equality is feasible and a one-millisecond shortage is infeasible.
- Already-earned watch progress reduces remaining work.
- Platform parsers and browser permissions remain unchanged.

---

### Task 1: Shared settings contract and normalization

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Produces: `EngineSettings.deadlineSafetyMarginMinutes: number`
- Produces: `DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes === 5`
- Produces: normalization to an integer in `[-1, 60]`

- [ ] **Step 1: Write the failing settings tests**

Add assertions covering the default, `-1`, `0`, rounding, both clamps, and invalid fallback:

```ts
expect(DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes).toBe(5);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: -9 }).deadlineSafetyMarginMinutes).toBe(-1);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: -1 }).deadlineSafetyMarginMinutes).toBe(-1);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 0 }).deadlineSafetyMarginMinutes).toBe(0);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 4.6 }).deadlineSafetyMarginMinutes).toBe(5);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: 99 }).deadlineSafetyMarginMinutes).toBe(60);
expect(mergeEngineSettings({ deadlineSafetyMarginMinutes: Number.NaN }).deadlineSafetyMarginMinutes).toBe(5);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- settings.test.ts`

Expected: FAIL because `deadlineSafetyMarginMinutes` is absent.

- [ ] **Step 3: Implement the setting**

Add `deadlineSafetyMarginMinutes: number` to `EngineSettings`, add `deadlineSafetyMarginMinutes: 5` to `DEFAULT_ENGINE_SETTINGS`, and normalize it in `mergeEngineSettings` with:

```ts
deadlineSafetyMarginMinutes: clampInteger(
  value?.deadlineSafetyMarginMinutes,
  -1,
  60,
  DEFAULT_ENGINE_SETTINGS.deadlineSafetyMarginMinutes,
),
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "feat(settings): add deadline safety margin"
```

### Task 2: Pure reward feasibility evaluator

**Files:**
- Modify: `packages/shared/src/rewards.ts`
- Create: `packages/extension/tests/rewardFeasibility.test.ts`

**Interfaces:**
- Produces: `RewardFeasibility` discriminated union with `disabled`, `unknown_deadline`, `feasible`, and `insufficient_time` kinds
- Produces: `rewardFeasibility(campaign, reward, marginMinutes, now?): RewardFeasibility`
- Produces: `isRewardDeadlineFeasible(...)` convenience predicate if it removes scheduler duplication

- [ ] **Step 1: Write failing evaluator tests**

Create fixed-time tests using `const now = Date.parse("2026-07-19T12:00:00.000Z")`. Cover disabled mode, exact equality, one millisecond short, partial progress, earliest of campaign/reward deadlines, invalid deadlines, and non-watch rewards. Assert structured fields for an insufficient result:

```ts
expect(rewardFeasibility(campaign, reward, 5, now)).toEqual({
  kind: "insufficient_time",
  deadline: "2026-07-19T12:34:59.999Z",
  remainingMinutes: 30,
  availableMilliseconds: 2_099_999,
  marginMinutes: 5,
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- rewardFeasibility.test.ts`

Expected: FAIL because `rewardFeasibility` is not exported.

- [ ] **Step 3: Implement minimal evaluator**

Use these public shapes and exact comparison:

```ts
export type RewardFeasibility =
  | { kind: "disabled" }
  | { kind: "not_applicable" }
  | { kind: "unknown_deadline" }
  | { kind: "feasible"; deadline: string; remainingMinutes: number; availableMilliseconds: number; marginMinutes: number }
  | { kind: "insufficient_time"; deadline: string; remainingMinutes: number; availableMilliseconds: number; marginMinutes: number };

const requiredMilliseconds = (remainingMinutes + marginMinutes) * 60_000;
const kind = availableMilliseconds >= requiredMilliseconds ? "feasible" : "insufficient_time";
```

Return `disabled` before deadline parsing when the margin is `-1`; return `not_applicable` for claimed or non-watch rewards; select the minimum of valid campaign and reward timestamps; clamp remaining minutes to zero.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- rewardFeasibility.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/rewards.ts packages/extension/tests/rewardFeasibility.test.ts
git commit -m "feat(core): evaluate reward deadline feasibility"
```

### Task 3: Scheduler selection, retention, and diagnostics

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `rewardFeasibility(campaign, reward, settings.deadlineSafetyMarginMinutes, now)`
- Produces: scheduler decisions that never select an `insufficient_time` reward unless the setting is `-1`
- Produces: diagnostic text containing reward, remaining minutes, available minutes, deadline, and margin

- [ ] **Step 1: Write failing scheduler tests**

Add fixed-clock tests with `vi.setSystemTime` proving that selection skips an infeasible in-progress reward for a feasible locked reward, rejects a campaign when all selectable watch rewards are infeasible, accepts exact equality, honors `-1`, and stops retaining a current session once its reward becomes infeasible. Assert the exclusion diagnostic contains `insufficient time`, the reward name, and `margin 5 minutes`.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- scheduler.test.ts`

Expected: FAIL because infeasible rewards remain selectable.

- [ ] **Step 3: Integrate the evaluator**

Change reward selection to accept settings and filter using one helper:

```ts
function isRewardFeasible(campaign: DropCampaign, reward: DropReward, settings: EngineSettings, now = Date.now()): boolean {
  return rewardFeasibility(campaign, reward, settings.deadlineSafetyMarginMinutes, now).kind !== "insufficient_time";
}
```

Use it in `activeReward`, `isEligible`, and current-session retention. Preserve in-progress-before-locked ordering among feasible rewards. Emit a diagnostic when infeasibility is the reason a candidate is skipped, formatting available minutes from `availableMilliseconds / 60_000` without using the rounded display value for decisions.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- scheduler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/core/scheduler.ts packages/extension/tests/scheduler.test.ts
git commit -m "feat(scheduler): skip rewards that cannot finish"
```

### Task 4: CLI configuration

**Files:**
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/src/config.ts`
- Test: `packages/cli/tests/settings.test.ts`
- Test: `packages/cli/tests/config.test.ts`

**Interfaces:**
- Produces: `CliSettings.deadlineSafetyMarginMinutes: number`
- Produces: generated JSONC containing the setting and mode documentation
- Produces: `toEngineSettings` forwarding the normalized value

- [ ] **Step 1: Write failing CLI tests**

Assert that defaults include `5`, parsing accepts and normalizes `-1`, `0`, and out-of-range values, `toEngineSettings` forwards the field, and `defaultConfigJsonc()` includes:

```jsonc
// -1 disables deadline filtering; 0 uses exact feasibility; 1-60 adds a safety buffer.
"deadlineSafetyMarginMinutes": 5,
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @lurkloot/cli test -- settings.test.ts config.test.ts`

Expected: FAIL because the CLI rejects or omits the setting.

- [ ] **Step 3: Implement CLI support**

Add the field to `CliSettings`, `DEFAULT_CLI_SETTINGS`, `CLI_SETTING_KEYS`, the `parseCliSettings` return value using `clampInteger(..., -1, 60, ...)`, `toEngineSettings`, and the generated JSONC template with the exact explanatory comment.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @lurkloot/cli test -- settings.test.ts config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit without absorbing pre-existing edits**

Inspect `git diff -- packages/cli/src/settings.ts`, stage only issue-108 hunks if unrelated edits remain, then:

```bash
git add packages/cli/src/config.ts packages/cli/tests/settings.test.ts packages/cli/tests/config.test.ts
git commit -m "feat(cli): configure deadline safety margin"
```

### Task 5: Popup setting and insufficient-time explanation

**Files:**
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/viewModels.ts`
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/drops.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/locales/messages/*.json`
- Test: `packages/extension/tests/settingsView.test.tsx`
- Test: `packages/extension/tests/subscriptionDropsView.test.ts`

**Interfaces:**
- Consumes: `rewardFeasibility`
- Produces: `RewardView.ineligibilityReason?: "insufficient_time"`
- Changes: `campaignViewFromCampaign(..., settings: Pick<ExtensionSettings, "deadlineSafetyMarginMinutes">, now?: number)`

- [ ] **Step 1: Write failing popup tests**

Assert the Advanced number control displays `5`, accepts `-1`, saves with `{ tickAfterSave: true }`, and shows localized Disabled/minutes semantics. Add a view-model/render test proving an infeasible watch reward receives `ineligibilityReason: "insufficient_time"` and renders `t("insufficientTimeRemaining")`; verify subscription rewards do not receive it.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- settingsView.test.tsx subscriptionDropsView.test.ts`

Expected: FAIL because the control and reason are absent.

- [ ] **Step 3: Implement popup behavior**

Add a `NumberSettingRow` under Advanced with `min={-1}`, `max={60}`, whole-minute values, and tick-after-save. Pass settings from `Popup.tsx` into `campaignViewFromCampaign`; map only evaluator kind `insufficient_time` to the new view field. Render a compact warning under watch progress. Add these English keys and translated equivalents to all catalogs:

```json
"deadlineSafetyMarginTitle": { "message": "Deadline safety margin" },
"deadlineSafetyMarginDescription": { "message": "Set extra minutes required before farming a reward. Use -1 to disable deadline filtering." },
"deadlineSafetyMarginDisabled": { "message": "Disabled" },
"insufficientTimeRemaining": { "message": "Insufficient time remaining" }
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- settingsView.test.tsx subscriptionDropsView.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages packages/extension/tests/settingsView.test.tsx packages/extension/tests/subscriptionDropsView.test.ts
git commit -m "feat(popup): expose deadline feasibility controls"
```

### Task 6: Full verification and documentation consistency

**Files:**
- Modify if needed: `packages/cli/README.md`

**Interfaces:**
- Consumes: all prior task outputs
- Produces: a verified extension and CLI implementation of issue #108

- [ ] **Step 1: Document the CLI setting if the README enumerates settings**

Add one concise entry with the exact `-1`, `0`, and `1..60` semantics; do not duplicate the generated JSONC reference unnecessarily.

- [ ] **Step 2: Run focused suites**

Run:

```bash
pnpm test -- rewardFeasibility.test.ts settings.test.ts scheduler.test.ts settingsView.test.tsx subscriptionDropsView.test.ts
pnpm --filter @lurkloot/cli test -- settings.test.ts config.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 3: Run full verification**

Run: `pnpm verify`

Expected: script tests, workspace typechecks, extension tests, Astro build, and both browser builds all exit successfully.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat origin/develop...HEAD
```

Confirm no unrelated user changes are staged or committed and every acceptance criterion in the design spec maps to passing tests.

- [ ] **Step 5: Commit any documentation-only remainder**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): document deadline safety margin"
```
