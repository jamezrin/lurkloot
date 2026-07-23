# Kick Authentication and Page-Context Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kick authentication health authoritative and preserve safe failure metadata when service-worker or page-context requests are rejected.

**Architecture:** Add a browser-neutral sanitized fetch error in core, use it in both Kick transports, and map it through an identity-requiring `/api/v1/user` probe. Harden Kick page-context reuse with a self-contained injected document validator while preserving existing lifecycle and recovery behavior.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, WXT browser APIs.

## Global Constraints

- Never persist or log tokens, cookies, authorization headers, sensitive request data, or complete authenticated response bodies.
- `healthy` requires a non-empty Kick account identity (`id`, `username`, or `slug` at the root or under `user`).
- Public campaign discovery must never determine authentication health.
- Preserve only bounded HTTP status, normalized reason, and bounded string or finite numeric reference metadata.
- Do not add browser permissions or attempt to bypass Kick's security policy.
- Keep `@lurkloot/core` browser-free; browser APIs remain injected through existing ports.

---

### Task 1: Sanitized Fetch Error Contract

**Files:**
- Create: `packages/core/src/core/fetchError.ts`
- Modify: `packages/core/package.json`
- Test: `packages/extension/tests/fetchError.test.ts`

**Interfaces:**
- Produces: `SafeFetchFailureKind`, `SafeFetchFailure`, `SafeFetchError`, `safeFetchFailure(input)`, and `isSafeFetchError(error)`.
- `SafeFetchFailure` contains only `kind`, optional `status`, optional `reason`, and optional `reference`.
- Later tasks import the contract through `@lurkloot/core/fetchError`.

- [ ] **Step 1: Write failing normalization tests**

Create tests that pass a source object containing status, reason, reference, token, cookie, headers, URL, and body. Assert the returned object is exactly:

```ts
{
  kind: "security_policy_blocked",
  status: 403,
  reason: "Request blocked by security policy.",
  reference: "9e4db7e3",
}
```

Also assert invalid statuses, reasons longer than 256 characters, references longer than 128 characters, non-finite numeric references, and arbitrary fields are omitted. Test that `new SafeFetchError(failure)` serializes no secret input and that `isSafeFetchError` recognizes only the typed error.

- [ ] **Step 2: Run the new test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/fetchError.test.ts`

Expected: FAIL because `@lurkloot/core/fetchError` is not exported.

- [ ] **Step 3: Implement the minimal safe error module**

Define:

```ts
export type SafeFetchFailureKind =
  | "authentication_rejected"
  | "security_policy_blocked"
  | "http_error"
  | "invalid_response"
  | "network_error";

export interface SafeFetchFailure {
  kind: SafeFetchFailureKind;
  status?: number;
  reason?: string;
  reference?: string | number;
}

export class SafeFetchError extends Error {
  readonly failure: SafeFetchFailure;
  constructor(candidate: SafeFetchFailure) {
    const failure = safeFetchFailure(candidate);
    super([failure.status ? `HTTP ${failure.status}` : undefined, failure.reason].filter(Boolean).join(" ") || failure.kind);
    this.name = "SafeFetchError";
    this.failure = failure;
  }
}
```

Implement `safeFetchFailure` with allowlists and length bounds, then export `./fetchError` from `packages/core/package.json` using the same source/types pattern as the existing `./tabs` export.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/fetchError.test.ts`

Expected: the new test file passes with no failures.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/core/src/core/fetchError.ts packages/core/package.json packages/extension/tests/fetchError.test.ts
git commit -m "feat(core): add sanitized fetch failures"
```

### Task 2: Kick Transport Metadata Preservation

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Consumes: `SafeFetchError` and `SafeFetchFailure` from Task 1.
- Produces: sanitized failures from `fetchKickInBackgroundWith` and `fetchJsonInPageWithBrowser`.
- Keeps `KickWafBlockedError` as the background-to-page fallback signal, extending it with a sanitized `failure` field.

- [ ] **Step 1: Add failing background transport tests**

Update the exact security-policy test to use:

```ts
JSON.stringify({
  error: "Request blocked by security policy.",
  reference: "9e4db7e3",
  token: "must-not-survive",
})
```

Catch the error and assert its safe failure equals:

```ts
{
  kind: "security_policy_blocked",
  status: 403,
  reason: "Request blocked by security policy.",
  reference: "9e4db7e3",
}
```

Assert serialized error data excludes `must-not-survive`. Add separate 401 and ordinary 500 cases producing `authentication_rejected` and `http_error`.

- [ ] **Step 2: Run the transport test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: FAIL because current errors expose only generic messages and no `failure` metadata.

- [ ] **Step 3: Parse and sanitize background failures**

After reading response text, parse only JSON object fields `error`, `message`, and `reference`. Classify security-policy wording before status-based authentication rules. Build `KickWafBlockedError` with the sanitized failure for block/network fallback cases and `SafeFetchError` for final 401/other HTTP failures. Never retain the raw text.

- [ ] **Step 4: Verify background transport GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: all `tabs.test.ts` tests pass.

- [ ] **Step 5: Add failing page transport envelope tests**

Mock `scripting.executeScript` to return an injected error envelope for the exact security-policy response and assert `fetchJsonInPageWithBrowser` rejects with a `SafeFetchError` carrying the same four safe fields. Add an envelope containing secret extra properties and assert they do not survive reconstruction.

- [ ] **Step 6: Run the page transport tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: FAIL because the wrapper currently returns the envelope as successful data.

- [ ] **Step 7: Implement the serializable page result envelope**

Make the self-contained `pageFetchJson` return one of:

```ts
{ ok: true, data: unknown }
{ ok: false, error: SafeFetchFailure }
```

Inline the narrow JSON error-field parsing and bounds because injected functions cannot access module helpers. Update both Manifest V3 and legacy script wrappers to unwrap success data or reconstruct `SafeFetchError` from the allowed failure fields.

- [ ] **Step 8: Verify transport tests GREEN and commit**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: all `tabs.test.ts` tests pass.

```bash
git add packages/core/src/core/tabs.ts packages/extension/tests/tabs.test.ts
git commit -m "fix(kick): preserve safe fetch failure metadata"
```

### Task 3: Authoritative Kick Authentication Probe

**Files:**
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/extension/tests/authHealth.test.ts`
- Test: `packages/extension/tests/adapters.test.ts`

**Interfaces:**
- Consumes: `SafeFetchError` and the existing `PageFetcher`.
- Produces: `KickAdapter.checkAuthHealth(): Promise<PlatformAuthHealth>` based only on `/api/v1/user` identity/error results.

- [ ] **Step 1: Replace the Kick checking-state test with failing probe tests**

Keep Twitch's existing `checking` expectation. Add table-driven Kick tests for root `{ id: 42 }`, `{ username: "viewer" }`, and nested `{ user: { slug: "viewer" } }`; each must report `healthy`, include a valid `checkedAt`, and call exactly `https://kick.com/api/v1/user`.

Add an identity-free `{ data: [] }` result and assert `invalid_credentials`. Assert a public campaign-shaped response cannot report healthy.

- [ ] **Step 2: Run adapter auth tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/authHealth.test.ts tests/adapters.test.ts`

Expected: FAIL because `KickAdapter.checkAuthHealth()` still returns `checking` without fetching.

- [ ] **Step 3: Implement the identity-requiring success path**

Add a small `hasKickIdentity` helper accepting finite/string ids and non-empty username/slug fields at the root or nested `user`. Probe `/api/v1/user`; return `healthy` only when that helper succeeds, otherwise return:

```ts
{
  status: "invalid_credentials",
  checkedAt,
  reasonCode: "credentials_rejected",
  message: { key: "authInvalidCredentials" },
}
```

- [ ] **Step 4: Run focused auth tests and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/authHealth.test.ts tests/adapters.test.ts`

Expected: identity and identity-free cases pass.

- [ ] **Step 5: Add failing classification tests**

Have the fetcher reject with `SafeFetchError` values for `authentication_rejected`, `security_policy_blocked` with reference `9e4db7e3`, `network_error`, and `http_error`. Assert the corresponding health results are `invalid_credentials`, `blocked`, `unavailable/network_unavailable`, and `unavailable/platform_unavailable`. Assert only the blocked result exposes the safe reference.

- [ ] **Step 6: Run classification tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/adapters.test.ts`

Expected: FAIL because the adapter does not yet map typed failures.

- [ ] **Step 7: Implement typed failure-to-health mapping**

Map the safe error kind to the existing shared status, reason code, and localized message keys. Create one timestamp per probe. For unknown errors, return `unavailable/platform_unavailable` without copying the unknown error message.

- [ ] **Step 8: Verify auth tests GREEN and commit**

Run: `pnpm --filter @lurkloot/extension test -- tests/authHealth.test.ts tests/adapters.test.ts tests/backgroundController.test.ts`

Expected: all selected tests pass.

```bash
git add packages/core/src/platforms/kick/index.ts packages/extension/tests/authHealth.test.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(kick): probe authenticated account identity"
```

### Task 4: Kick Page-Context Validation and Recovery

**Files:**
- Modify: `packages/core/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Produces: a self-contained injected `validateKickPageContext` result used by `findOrCreatePageContextTab` for `https://kick.com` contexts.
- Validation proves document usability, not user authentication.

- [ ] **Step 1: Add a failing completed-error-document test**

Configure a queried completed `https://kick.com/` user tab and mock validation to report a JSON content type or body matching `Request blocked by security policy.`. Assert it is not selected as the page context and a replacement managed tab is created.

- [ ] **Step 2: Run the context test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: FAIL because the completed user tab is currently reused without document validation.

- [ ] **Step 3: Implement bounded Kick document validation**

For `origin === "https://kick.com"`, inject a self-contained validator returning a small object with `usable` and optional sanitized failure. Accept HTML Kick documents; reject JSON/error or security-policy documents. Treat inability to validate as unusable. Apply validation to user tabs, retained managed tabs, and newly created tabs after readiness.

- [ ] **Step 4: Run the context test and verify GREEN**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: the blocked completed document is rejected.

- [ ] **Step 5: Add a failing recovery test**

Model the first candidate as a blocked JSON document and the replacement as a completed HTML Kick page. Assert the request executes only in the valid replacement and returns its successful JSON data. Assert managed lifecycle state contains only the recovered context.

- [ ] **Step 6: Run the recovery test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts`

Expected: FAIL until replacement validation/retry is complete.

- [ ] **Step 7: Complete recovery and cleanup behavior**

Ensure rejected managed tabs are forgotten/removed through existing lifecycle rules, a valid replacement is retained, and a later request can reuse it. Bound creation attempts so persistent blocking returns a sanitized `SafeFetchError` rather than looping.

- [ ] **Step 8: Verify page-context tests GREEN and commit**

Run: `pnpm --filter @lurkloot/extension test -- tests/tabs.test.ts tests/backgroundController.test.ts tests/scheduler.test.ts`

Expected: all selected tests pass.

```bash
git add packages/core/src/core/tabs.ts packages/extension/tests/tabs.test.ts
git commit -m "fix(kick): reject blocked page contexts"
```

### Task 5: Full Verification and Acceptance Audit

**Files:**
- Modify only files needed to fix verification failures caused by Tasks 1-4.

**Interfaces:**
- Consumes all prior task outputs.
- Produces a verified branch satisfying issue #203.

- [ ] **Step 1: Run formatting and type verification**

Run: `pnpm typecheck`

Expected: all workspace typechecks exit 0.

- [ ] **Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: all workspace tests and the Astro site test build exit 0.

- [ ] **Step 3: Run production verification**

Run: `pnpm verify`

Expected: repository checks plus Chromium and Firefox production builds exit 0.

- [ ] **Step 4: Audit security and acceptance criteria**

Run:

```bash
git diff origin/develop...HEAD -- packages/core packages/extension packages/shared | rg -n "session_token|authorization|cookie|response body|token"
git diff --check origin/develop...HEAD
git status --short --branch
```

Review every match and confirm it is transport logic, a negative security assertion, or existing safe commentary—not persisted/logged credential data. Confirm the branch is clean and each issue acceptance criterion has a corresponding passing test.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required code corrections, first add a regression test that fails for the discovered problem, make it pass, rerun the affected command, then commit only those corrections:

```bash
git add packages/core/src/core/fetchError.ts packages/core/src/core/tabs.ts packages/core/src/platforms/kick/index.ts packages/core/package.json packages/extension/tests/fetchError.test.ts packages/extension/tests/tabs.test.ts packages/extension/tests/authHealth.test.ts packages/extension/tests/adapters.test.ts
git commit -m "fix(kick): complete authentication health handling"
```

If no corrections were needed, do not create an empty commit.
