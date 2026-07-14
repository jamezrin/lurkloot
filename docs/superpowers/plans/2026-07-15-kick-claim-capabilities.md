# Kick Claim Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add response-aware Kick claim-link handling that stops repeated impossible claims, surfaces safe guidance, and remains selectable alongside the legacy campaign-only behavior.

**Architecture:** A versioned claim policy classifies claim responses and owns session-scoped suppression. The Kick adapter performs network I/O, delegates classification, and returns structured guidance without changing scheduler-wide backoff behavior.

**Tech Stack:** TypeScript, Fetch API, Vitest, shared popup campaign models.

## Global Constraints

- Requires the compatibility-profile foundation plan.
- `kick-claim-v2` is recommended; `kick-claim-v1` remains a legacy rollback.
- Parse only bundled response shapes: top-level/nested `connect_url` and `connectUrl`.
- Suppression is process/session scoped and keyed by campaign plus reward.
- Never open returned links automatically.
- Unexpected claim errors retain current propagation behavior.

---

### Task 1: Model and classify link-required claim responses

**Files:**
- Create: `packages/core/src/platforms/kick/claim/types.ts`
- Create: `packages/core/src/platforms/kick/claim/v1.ts`
- Create: `packages/core/src/platforms/kick/claim/v2.ts`
- Create: `packages/core/src/platforms/kick/claim/factory.ts`
- Modify: `packages/shared/src/models.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Produces `KickClaimOutcome = { kind: "claimed" } | { kind: "not_claimed" } | { kind: "link_required"; url: string }`.
- Produces `KickClaimCapability.classify(response, campaign): KickClaimOutcome`.
- Adds optional safe claim guidance to campaign/reward models without storing response bodies.

- [ ] **Step 1: Write failing classification tests**

Test top-level and nested snake/camel fields, malformed/non-URL values, normal success, campaign-metadata-only v1, and unexpected errors. Use HTTPS guidance URLs in positive cases.

- [ ] **Step 2: Run focused adapter tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts -t "Kick claim"`

Expected: FAIL because response-aware classification does not exist.

- [ ] **Step 3: Implement strict classification**

Accept a link only when `new URL(value)` succeeds and protocol is `https:`. V2 searches the response object and its `data` object for both supported field names. V1 preserves current reliance on `campaign.accountLinked === false`. Do not accept arbitrary nested traversal or javascript/data URLs.

- [ ] **Step 4: Run adapter tests**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/kick/claim packages/core/src/platforms/kick/index.ts packages/shared/src/models.ts packages/extension/tests/adapters.test.ts
git commit -m "feat(kick): classify link-required claims"
```

### Task 2: Suppress repeated claims and clear on affirmative evidence

**Files:**
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/platforms/kick/claim/v2.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Produces a private suppression map keyed by `${campaign.id}:${reward.id}`.
- Produces structured link-required diagnostics and updated guidance state.

- [ ] **Step 1: Write failing suppression lifecycle tests**

Call automatic claim twice after the same link rejection and assert one POST. Refresh progress without affirmative changed link evidence and assert suppression remains. Refresh with explicit linked evidence and assert the next claim posts again. Construct a new adapter and assert it may retry once.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts -t "link-required"`

Expected: FAIL because suppression is absent.

- [ ] **Step 3: Implement session-scoped suppression**

Before a claim, return `false` without a request when the key is suppressed. On `link_required`, store the URL and emit one actionable diagnostic. Clear only when refreshed campaign/progress data explicitly changes from unlinked/link-required to linked; absence of fields is not affirmative evidence. Keep unexpected exceptions unchanged.

- [ ] **Step 4: Run adapter and controller tests**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platforms/kick packages/extension/tests/adapters.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(kick): suppress repeated link-required claims"
```

### Task 3: Surface guidance in popup models and UI

**Files:**
- Modify: `packages/popup-ui/src/drops.tsx`
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/locales/messages/en.json`
- Modify: `packages/locales/messages/ar.json`
- Modify: `packages/locales/messages/de.json`
- Modify: `packages/locales/messages/es.json`
- Modify: `packages/locales/messages/fr.json`
- Modify: `packages/locales/messages/hi.json`
- Modify: `packages/locales/messages/it.json`
- Modify: `packages/locales/messages/pt_BR.json`
- Modify: `packages/locales/messages/ru.json`
- Modify: `packages/locales/messages/zh_CN.json`
- Test: `packages/extension/tests/dropsView.test.tsx`

**Interfaces:**
- Consumes safe HTTPS guidance from normalized campaign/reward state.
- Produces a user-clicked external link only; no automatic navigation.

- [ ] **Step 1: Write failing UI tests**

Assert link-required rewards show localized guidance and a link when present, render no link for rejected unsafe URLs, and never call open/navigation during render.

- [ ] **Step 2: Run the view test and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- dropsView.test.tsx -t "account link"`

Expected: FAIL because claim-time guidance is not rendered.

- [ ] **Step 3: Render actionable but passive guidance**

Reuse existing campaign account-link presentation where possible. Label the action as requiring an external game account. Route clicks through the existing popup adapter/open-link boundary so extension permission handling remains centralized.

- [ ] **Step 4: Add locale keys and run tests**

Run: `pnpm --filter @lurkloot/extension test -- dropsView.test.tsx adapters.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui/src packages/locales/messages packages/extension/tests/dropsView.test.tsx
git commit -m "feat(popup): show Kick claim link guidance"
```

### Task 4: Select claim behavior and verify

**Files:**
- Modify: `packages/core/src/compatibility/registry.ts`
- Modify: `packages/core/src/platforms/kick/index.ts`
- Test: `packages/extension/tests/compatibility.test.ts`
- Test: `packages/extension/tests/adapters.test.ts`

- [ ] **Step 1: Write failing version-selection tests**

Assert automatic uses v2, explicit v1 preserves campaign-only behavior, and diagnostics include the effective claim capability.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts`

Expected: FAIL because the resolved claim capability is not used.

- [ ] **Step 3: Wire the exhaustive claim factory**

Construct the policy from `resolvedCompatibility.kick.claim`; do not switch policies in response to request failure. Mark v2 recommended and v1 legacy in registry metadata.

- [ ] **Step 4: Run full verification**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts adapters.test.ts backgroundController.test.ts dropsView.test.tsx && pnpm verify`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compatibility/registry.ts packages/core/src/platforms/kick/index.ts packages/extension/tests
git commit -m "feat(kick): select claim compatibility versions"
```
