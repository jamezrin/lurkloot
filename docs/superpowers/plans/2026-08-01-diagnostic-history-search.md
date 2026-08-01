# Diagnostic History Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let popup users search every retained diagnostic message for the selected platform.

**Architecture:** Add an optional case-insensitive message substring to `ActivityQuery`; IndexedDB filters it while scanning the diagnostics index, so existing cursors page matching rows. The popup owns query state and query-scoped requests, while `ActivityLog` renders the control and its empty state.

**Tech Stack:** TypeScript, React, IndexedDB, Vitest, `@lurkloot/shared` contracts, JSON locale catalogs.

## Global Constraints

- Search only diagnostic `message` values; never add diagnostic locale keys or translated diagnostic bodies.
- Search covers retained history, not merely loaded popup events, and uses a case-insensitive substring match.
- Preserve current platform filtering, including platform-less global diagnostics.
- Keep the existing 2,000-record and seven-day diagnostic retention policy and cursor encoding; do not migrate IndexedDB.
- Match the repository’s two-space TypeScript, double-quote, semicolon style.

## File structure

- `packages/shared/src/messages.ts`: `ActivityQuery` contract.
- `packages/extension/src/core/activityStorage.ts`: indexed history search.
- `packages/extension/tests/activityStorage.test.ts`: repository test coverage.
- `packages/popup-ui/src/Popup.tsx`: query state and requests.
- `packages/popup-ui/src/activity.tsx`: search input and empty state.
- `packages/extension/tests/activityLogView.test.tsx`: rendered UI coverage.
- `packages/locales/messages/*.json`: UI-only labels.

---

### Task 1: Add paginated diagnostic-message matching to activity history

**Files:**

- Modify: `packages/shared/src/messages.ts:61-66`
- Modify: `packages/extension/src/core/activityStorage.ts:191-230`
- Test: `packages/extension/tests/activityStorage.test.ts`

**Interfaces:**

- Produces `ActivityQuery.query?: string`; a trimmed empty string does not filter.
- `ActivityRepository.load(query)` returns at most `query.limit` matching records and a cursor following the final returned match.

- [ ] **Step 1: Write the failing repository test**

Store `"Kick transport failed"`, `"Twitch connected"`, `"kick retry scheduled"`, and platform-less `"Kick global error"`. Request `{ category: "diagnostic", platform: "kick", query: "KICK", limit: 2 }`, then use its cursor for page two.

```ts
expect(first.events.map((event) => event.message)).toEqual([
  "Kick global error",
  "kick retry scheduled",
]);
expect(second.events.map((event) => event.message)).toEqual(["Kick transport failed"]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityStorage.test.ts`

Expected: FAIL because `query` is absent and unmatched rows are returned.

- [ ] **Step 3: Implement the contract and storage predicate**

Add `query?: string` to `ActivityQuery`. In `load`, derive `const normalizedQuery = query.query?.trim().toLowerCase();`; only push a platform-eligible record if the query is empty or its `message` contains the normalized query. Keep the category/time index, cursor encoding, retention, and `limit + 1` pagination untouched.

```ts
const matchesQuery = !normalizedQuery || event.message.toLowerCase().includes(normalizedQuery);
if (matchesPlatform && matchesQuery) events.push(event);
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityStorage.test.ts`

Expected: PASS.

```bash
git add packages/shared/src/messages.ts packages/extension/src/core/activityStorage.ts packages/extension/tests/activityStorage.test.ts
git commit -m "feat(activity): search diagnostic history"
```

### Task 2: Make popup diagnostic requests query-aware

**Files:**

- Modify: `packages/popup-ui/src/Popup.tsx:90-110,260-325,675-700`
- Modify: `packages/popup-ui/src/activity.logic.ts`
- Test: `packages/extension/tests/activityView.test.ts`

**Interfaces:**

- Consumes `ActivityQuery.query` from Task 1.
- Produces `diagnosticSearchQuery: string` state and a stream that represents the latest platform/query combination.
- Passes `searchQuery`, `onSearchQueryChange`, and `searchingDiagnostics` to `ActivityLog`.

- [ ] **Step 1: Write a failing stale-response test**

Extend `ActivityRequestScope` with `query: string`. Verify a late `"timeout"` page cannot update a scope whose query is `"retry"`.

```ts
expect(isActivityRequestCurrent(
  { generation: 2, platform: "kick", query: "timeout" },
  { generation: 2, platform: "kick", query: "retry" },
)).toBe(false);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityView.test.ts`

Expected: FAIL because request scopes have no query.

- [ ] **Step 3: Implement scoped query requests**

Keep raw input in `Popup.tsx`, derive a trimmed query, and advance the diagnostic request scope when it changes. Include `query: searchQuery || undefined` in initial and paginated diagnostic requests. Reset query and its stream on platform change, leaving Diagnostics, and a successful clear. Use the existing mutation sequence to discard late responses; do not bulk-load history.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityView.test.ts`

Expected: PASS.

```bash
git add packages/popup-ui/src/Popup.tsx packages/popup-ui/src/activity.logic.ts packages/extension/tests/activityView.test.ts
git commit -m "feat(popup): query diagnostic history"
```

### Task 3: Render and localize Diagnostics search

**Files:**

- Modify: `packages/popup-ui/src/activity.tsx:1-170`
- Test: `packages/extension/tests/activityLogView.test.tsx`
- Modify: every `packages/locales/messages/*.json` catalog

**Interfaces:**

- Consumes `searchQuery: string`, `onSearchQueryChange(query: string): void`, and `searchingDiagnostics: boolean`.
- Uses UI-only `searchDiagnostics` and `noDiagnosticsMatch` locale keys.

- [ ] **Step 1: Write failing view tests**

Extend the mount helper. In Diagnostics, assert an input labelled `"Search diagnostics"`, assert typing invokes the query handler, and assert an empty search result says `No diagnostics match "timeout".`. In Activity, assert no search input and the existing empty state remain.

```ts
expect(container.querySelector('input[type="search"]')?.getAttribute("aria-label")).toBe("Search diagnostics");
expect(container.textContent).toContain("No diagnostics match \"timeout\".");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityLogView.test.tsx`

Expected: FAIL because `ActivityLog` has neither search props nor a search empty state.

- [ ] **Step 3: Implement UI and translated copy**

Use the existing `SearchBox` above the diagnostic list only when `showDiagnostics` is true. When a non-empty trimmed query has no results, render `noDiagnosticsMatch`; otherwise retain `noDiagnostics`. Add translations to every catalog without changing diagnostic text.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @lurkloot/extension test -- --run tests/activityLogView.test.tsx tests/diagnosticsLocale.test.ts`

Expected: PASS.

```bash
git add packages/popup-ui/src/activity.tsx packages/extension/tests/activityLogView.test.tsx packages/locales/messages
git commit -m "feat(popup): add diagnostic search field"
```

### Task 4: Verify the integrated feature

- [ ] **Step 1: Type-check**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run all extension tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Build the popup-consuming site**

Run: `pnpm build:site`

Expected: PASS; any existing Vite chunk-size advisory remains a warning.

- [ ] **Step 4: Check the final diff**

Run: `git diff origin/develop...HEAD --check && git status --short`

Expected: no whitespace errors and only feature, tests, locales, and approved documentation changes.
