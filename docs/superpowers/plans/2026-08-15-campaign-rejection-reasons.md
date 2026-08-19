# Campaign Rejection Reasons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain every campaign rejected before channel selection through shared structured evaluation, deduplicated diagnostics, and localized popup guidance.

**Architecture:** A pure evaluator in `@lurkloot/shared` becomes the single source for farmability and rejection codes. The scheduler consumes evaluation results for selection and an in-memory rejection fingerprint, while popup view models translate the same structured result into localized presentation without persisting derived state.

**Tech Stack:** TypeScript, Vitest, React, WXT, pnpm workspace, JSON locale catalogs.

## Global Constraints

- Scheduler selection behavior must remain unchanged.
- Core/shared code must not import React, WXT, browser globals, or localized strings.
- Diagnostic bodies remain English literals and never receive locale keys.
- Popup explanations are localized in every catalog.
- Rejection diagnostics emit only when the evaluated snapshot changes.
- Work remains on `feat/campaign-rejection-reasons` in `.worktrees/campaign-rejection-reasons`.

---

### Task 1: Shared Campaign Farming Evaluator

**Files:**
- Create: `packages/shared/src/campaignFarming.ts`
- Modify: `packages/shared/src/campaignFilters.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/extension/tests/campaignFarming.test.ts`

**Interfaces:**
- Produces: `CampaignFarmingRejectionCode`, `CampaignFarmingEvaluation`, and `evaluateCampaignFarming(campaign, settings, options?)`.
- Consumes: existing lifecycle, category, reward-window, prerequisite, deadline, exclusion, linking, and farming-priority data.

- [ ] Write failing table-driven evaluator tests covering each stable code and precedence, plus farmable campaigns.
- [ ] Run `pnpm --filter @lurkloot/extension test -- campaignFarming.test.ts` and confirm failures are caused by the missing evaluator.
- [ ] Implement the discriminated union and pure evaluator with deterministic primary-reason ordering.
- [ ] Refactor `campaignEligibleClass` and `campaignFarmable` into thin evaluator consumers without changing their public behavior.
- [ ] Run the focused evaluator and existing campaign-filter tests until green.
- [ ] Commit with `feat(shared): explain campaign farming rejections`.

### Task 2: Scheduler Rejection Diagnostics

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/shared/src/models.ts` only if scheduler runtime state needs a typed in-memory field; prefer a module-local `WeakMap`/runtime field with no persisted migration.
- Test: `packages/extension/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `evaluateCampaignFarming` and its stable rejection codes/context.
- Produces: one aggregate diagnostic and active-campaign detail diagnostics when the rejection fingerprint changes.

- [ ] Write a failing scheduler test asserting aggregate counts account for every discovered campaign.
- [ ] Run the focused scheduler test and verify the expected missing diagnostic failure.
- [ ] Implement aggregate formatting and active-campaign English detail formatting as pure helpers.
- [ ] Write a failing test proving identical consecutive ticks do not repeat the snapshot.
- [ ] Add per-scheduler-instance in-memory fingerprint state and make the deduplication test pass.
- [ ] Write failing tests for changed reasons, active-only details, reward/deadline context, and a background restart producing a fresh snapshot.
- [ ] Implement the minimal snapshot comparison and detail emission needed for those tests.
- [ ] Run `pnpm --filter @lurkloot/extension test -- scheduler.test.ts campaignFarming.test.ts` until green.
- [ ] Commit with `feat(core): diagnose campaign farming rejections`.

### Task 3: Popup View Model and Presentation

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/viewModels.ts`
- Modify: `packages/popup-ui/src/drops.tsx`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx` or the locale description consumed by the existing row.
- Test: `packages/extension/tests/popupViewModels.test.ts` or the existing view-model test file discovered during implementation.
- Test: `packages/extension/tests/popupUi.test.tsx` or the existing Drops rendering test file discovered during implementation.

**Interfaces:**
- Consumes: `CampaignFarmingEvaluation` from shared evaluation during `campaignViewFromCampaign`.
- Produces: structured rejection data on `CampaignView`, collapsed warning semantics, and expanded localized explanation.

- [ ] Write a failing view-model test proving a rejected campaign carries the shared code and safe context.
- [ ] Run the focused test and confirm failure on the missing view property.
- [ ] Extend `CampaignView` and populate it during view-model construction using current settings.
- [ ] Write failing rendering tests for the collapsed warning, expanded reason, and suppression while actively farming.
- [ ] Render an accessible warning indicator and compact expanded explanation row using existing primitives and static imports.
- [ ] Clarify the global unlinked-campaign setting description to mention platform-required linking.
- [ ] Run focused view-model and rendering tests until green.
- [ ] Commit with `feat(popup): show campaign farming rejection reasons`.

### Task 4: Localized Popup Copy

**Files:**
- Modify: `packages/locales/messages/en.json`
- Modify: all other `packages/locales/messages/*.json` catalogs.
- Test: `packages/extension/tests/locales.test.ts`

**Interfaces:**
- Consumes: stable rejection codes mapped to explicit `TFunction` message keys in popup UI.
- Produces: localized titles/explanations for every popup-visible rejection code; no diagnostic locale keys.

- [ ] Write or extend a failing locale consistency test for the new popup message keys and absence of diagnostic-prefixed keys.
- [ ] Run the locale test and confirm missing-key failures.
- [ ] Add concise English copy and translations following each catalog's established terminology.
- [ ] Run locale and popup rendering tests until green.
- [ ] Commit with `feat(locales): translate campaign rejection reasons`.

### Task 5: Cross-Package Verification and Documentation

**Files:**
- Modify: `docs/architecture.md` or the existing campaign farmability document to describe the evaluator and diagnostic snapshot.
- Modify: `docs/superpowers/plans/2026-08-15-campaign-rejection-reasons.md` to mark completed checkboxes.

**Interfaces:**
- Consumes: completed evaluator, scheduler, popup, and locale work.
- Produces: verified branch ready for review.

- [ ] Update architecture documentation with the shared evaluation and diagnostic flow.
- [ ] Run `pnpm typecheck` and fix only feature-related type failures.
- [ ] Run `pnpm test` and fix only feature-related regressions.
- [ ] Run `pnpm build:site` to verify the embedded popup UI.
- [ ] Run `pnpm build` and `pnpm build:firefox` to verify both extension targets.
- [ ] Run `git diff --check` and inspect the final diff/status for unrelated files.
- [ ] Commit documentation with `docs: document campaign rejection diagnostics` if documentation changed after earlier commits.
