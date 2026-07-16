# Fix Twitch False “Not Linked” Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Twitch campaigns such as EWC 2026 from being labeled “Not linked” when Twitch provides no account-link flow, while retaining genuine account-link warnings.

**Architecture:** Keep the behavior change at the Twitch normalization boundary in `parseTwitchInventory`. A campaign is considered unlinked only when it has an actual `accountLinkURL` and Twitch explicitly reports `self.isAccountConnected === false`; the existing popup and scheduler continue consuming the normalized `accountLinked`/`eligibility` fields.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, `@lurkloot/core`, `@lurkloot/shared`.

## Global Constraints

- Keep Twitch/Kick behavior isolated behind the platform adapter and parser.
- Do not change browser permissions, account credentials, cookies, or external platform behavior.
- Follow the repository’s two-space indentation, double quotes, semicolons, and strict TypeScript style.
- Use deterministic parser fixtures; do not call Twitch from tests.

---

### Task 1: Add regression coverage for linkable and non-linkable Twitch campaigns

**Files:**
- Modify: `packages/extension/tests/parsers.test.ts` near the existing Twitch campaign eligibility tests
- Test: `packages/extension/tests/parsers.test.ts`

**Interfaces:**
- Consumes: `parseTwitchInventory(input)` from `@lurkloot/core/twitch/parser`.
- Produces: failing tests that define the intended `accountLinked` and `eligibility` contract.

- [ ] **Step 1: Write the failing test for a URL-less campaign**

Add a test fixture with `self: { isAccountConnected: false }`, no `accountLinkURL`, and one ordinary time-based reward. Assert that parsing returns:

```ts
expect(campaigns[0]).toMatchObject({
  accountLinked: true,
  eligibility: "eligible",
});
```

This reproduces EWC’s shape and must fail against the current parser because it currently trusts the explicit `false` value unconditionally.

- [ ] **Step 2: Write the failing test for a genuine unlinked campaign**

Add a separate fixture with the same explicit disconnected state but an actual `accountLinkURL`, then assert:

```ts
expect(campaigns[0]).toMatchObject({
  accountLinked: false,
  accountLinkUrl: "https://example.test/connect",
  eligibility: "account_not_linked",
});
```

This protects the existing warning and link action for campaigns that really provide a publisher-account connection flow.

- [ ] **Step 3: Run the focused parser tests and verify the new URL-less case fails**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/parsers.test.ts
```

Expected: the new URL-less campaign test fails with `accountLinked` equal to `false`; the existing parser tests continue to identify the current behavior accurately.

### Task 2: Fix Twitch campaign link-state normalization

**Files:**
- Modify: `packages/core/src/platforms/twitch/parser.ts:85`

**Interfaces:**
- Consumes: raw Twitch campaign fields `accountLinkURL` and `self.isAccountConnected`.
- Produces: the existing normalized `DropCampaign.accountLinked`, `accountLinkUrl`, `eligibility`, and `eligibilityReason` fields.

- [ ] **Step 1: Implement the minimal predicate change**

Replace the unconditional explicit-state preference:

```ts
const accountLinked = campaign.self?.isAccountConnected ?? campaign.accountLinkURL == null;
```

with a predicate that requires both signals for an unlinked state:

```ts
const accountLinked = campaign.accountLinkURL == null || campaign.self?.isAccountConnected !== false;
```

This keeps campaigns with no link URL linked, including EWC, and keeps campaigns with a real link URL plus an explicit disconnected state unlinked. Do not alter popup rendering, scheduler filtering, or claim behavior in this task.

- [ ] **Step 2: Run the focused parser tests and verify they pass**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/parsers.test.ts
```

Expected: PASS, including both new regression cases and the existing Kick/Twitch eligibility coverage.

### Task 3: Verify downstream behavior and type safety

**Files:**
- No additional source files expected.

**Interfaces:**
- Consumes: normalized campaign state from Task 2.
- Produces: evidence that the popup no longer renders the misleading badge and the scheduler no longer excludes URL-less Twitch campaigns because of this parser state.

- [ ] **Step 1: Run the extension test suite**

Run:

```bash
pnpm test
```

Expected: PASS. In particular, the adapter test for a real Twitch account-link URL must still expect `accountLinked: false` and `eligibility: "account_not_linked"`.

- [ ] **Step 2: Run workspace typechecking**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Review the final diff for scope**

Run:

```bash
git diff -- packages/core/src/platforms/twitch/parser.ts packages/extension/tests/parsers.test.ts
```

Confirm the diff contains only the predicate change and focused regression tests. If the repository’s normal contribution workflow requires a commit, use:

```bash
git add packages/core/src/platforms/twitch/parser.ts packages/extension/tests/parsers.test.ts
git commit -m "fix(twitch): avoid false unlinked campaign status"
```
