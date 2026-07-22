# Kick Page-Context Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Kick fully tabless while cookie-authenticated background transport works, stabilize the single inventory-page fallback context when it does not, report every real managed context open/close with a safe reason, and defer recovery after a user closes a farming tab.

**Architecture:** `createKickFetcher` remains background-first and reports sanitized transport outcomes to an injected browser lifecycle port. The browser-backed page-context registry owns retained metadata, adaptive recovery, real tab mutations, and lifecycle emission; the scheduler persists the registry and closes contexts only for explicit lifecycle reasons. Typed shared activity events and localized popup formatting make actual opens/closes visible independently of diagnostic logging.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, WXT browser adapters, React popup UI, JSON locale catalogs.

## Global Constraints

- Background cookie replay is always attempted before any page-context creation.
- Recovery requires three consecutive successful background requests and ten minutes since the most recent page fallback.
- A new fallback resets the success count and recovery window.
- Only successful browser create/remove operations emit open/close activity events.
- Activity and diagnostics may contain platform, safe hostname, enumerated action, and enumerated reason only; never paths, query strings, cookies, tokens, headers, payloads, or raw errors.
- User-owned tabs are never registered or closed as managed contexts.
- Extension-created Kick page contexts open `https://kick.com/drops/inventory` unpinned, muted, and inactive.
- Closing a managed farming tab clears stale state but never calls the scheduler from `tabs.onRemoved`.
- Core remains browser-global-free; live browser APIs stay behind the extension adapter.

---

### Task 1: Typed and localized page-context activity

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/popup-ui/src/activity.logic.ts`
- Modify: `packages/locales/messages/*.json`
- Test: `packages/extension/tests/activityView.test.ts`

**Interfaces:**
- Produces: `PageContextOpenReason`, `PageContextCloseReason`, and `ActivityEvent` variants `page_context_opened` / `page_context_closed` with `data: { host: string; reason: ... }`.
- Consumes: existing `StoredEngineEvent`, `TFunction`, and locale catalog conventions.

- [ ] **Step 1: Add failing formatter tests**

Add cases that pass stored Kick `page_context_opened` and `page_context_closed` events to `formatActivityEvent`, asserting localized output such as `Opened a Kick background context on kick.com because Kick rejected the tabless request.` and `Closed the Kick background context on kick.com because tabless requests recovered.`

- [ ] **Step 2: Run the focused tests and confirm the type/formatter failure**

Run: `pnpm --filter @lurkloot/extension test -- activityView.test.ts`

Expected: FAIL because the new event codes and formatter branches do not exist.

- [ ] **Step 3: Add exact shared event contracts**

Add:

```ts
export type PageContextOpenReason = "background_rejected" | "managed_context_unusable";
export type PageContextCloseReason =
  | "background_recovered"
  | "user_tab_available"
  | "platform_disabled"
  | "automation_disabled"
  | "manual_watch"
  | "managed_context_unusable";
```

Extend `ActivityEvent` with structured `page_context_opened` and `page_context_closed` variants. Both use `level: "info"`, a required `platform`, and `{ host, reason }` data.

- [ ] **Step 4: Format and localize the new activity variants**

Add exhaustive reason formatters and event branches in `activity.logic.ts`. Add English source strings and corresponding translated catalog keys in every existing locale file, following the repository's catalog completeness rules.

- [ ] **Step 5: Run the focused tests**

Run: `pnpm --filter @lurkloot/extension test -- activityView.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the activity contract**

```bash
git add packages/shared/src/events.ts packages/popup-ui/src/activity.logic.ts packages/locales/messages packages/extension/tests/activityView.test.ts
git commit -m "feat(activity): report page-context tab lifecycle"
```

### Task 2: Ownership-safe browser lifecycle and diagnostics

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Consumes: Task 1 activity event reason types and existing `EventEmitter`.
- Produces: optional `lastFallbackAt?: string` and `backgroundSuccesses?: number` on `ManagedPageContextTab`; `recordPageContextBackgroundSuccessWithBrowser(...)`; reason-aware `stopManagedPageContextTabsWithBrowser(...)`; `PageFetchOptions.emit` and `PageFetchOptions.openReason`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover one real create emitting exactly one `page_context_opened`, retained reuse emitting no second open, user-tab replacement emitting one successful close, a failed remove emitting no false close, stale/manual closure emitting only a forget diagnostic, and all messages containing only safe hostnames.

- [ ] **Step 2: Run the focused lifecycle tests**

Run: `pnpm --filter @lurkloot/extension test -- tabs.test.ts`

Expected: FAIL because page-context operations do not emit typed activity or reasoned diagnostics.

- [ ] **Step 3: Add persisted adaptive metadata**

Extend `ManagedPageContextTab` with optional recovery fields. When a fallback is acquired, store `lastFallbackAt` as ISO time and reset `backgroundSuccesses` to zero. Preserve backwards compatibility when restoring records without either field.

- [ ] **Step 4: Emit real mutation events at the ownership boundary**

Thread `EventEmitter` and enumerated reasons through page acquisition and managed cleanup. Emit `page_context_opened` only after `tabs.create`, mute/update, and readiness succeed. Emit `page_context_closed` only after `tabs.remove` resolves. Add a safe diagnostic for every create, reuse, retain, replace, close, and forget decision.

- [ ] **Step 5: Keep user-owned tabs outside managed cleanup**

Retain the existing `createdByExtension: false` representation for queried user tabs. When one replaces a managed context, remove only the registered managed tab ID; never insert the user tab into `retainedPageContextTabs`.

- [ ] **Step 6: Run focused lifecycle tests**

Run: `pnpm --filter @lurkloot/extension test -- tabs.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit browser lifecycle behavior**

```bash
git add packages/shared/src/models.ts packages/core/src/core/tabs.ts packages/extension/src/core/tabs.ts packages/extension/tests/tabs.test.ts
git commit -m "fix(kick): make page-context cleanup ownership-aware"
```

### Task 3: Adaptive background recovery

**Files:**
- Modify: `packages/core/src/platforms/kick/index.ts`
- Modify: `packages/core/src/core/tabs.ts`
- Modify: `packages/extension/src/core/tabs.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/adapters.test.ts`
- Test: `packages/extension/tests/tabs.test.ts`

**Interfaces:**
- Consumes: Task 2 `recordPageContextBackgroundSuccessWithBrowser` and fallback metadata.
- Produces: `createKickFetcher` lifecycle callbacks `onBackgroundSuccess(host, emit)` and `onPageFallback(host, emit)`; extension wrappers bound to the live browser.

- [ ] **Step 1: Add failing transport-policy tests**

Assert background success calls the success hook without page fetch, WAF rejection calls the fallback hook before page fetch, non-WAF background errors retain existing fallback behavior, and hooks receive only `new URL(url).host` plus the operation emitter.

- [ ] **Step 2: Add failing threshold tests with an injected clock**

Register a managed Kick context and assert: one or two successes retain it; three successes before ten minutes retain it; three successes after ten minutes remove it once and emit `background_recovered`; a fallback between successes resets both fields.

- [ ] **Step 3: Run both focused files and confirm failure**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts tabs.test.ts`

Expected: FAIL because transport outcome hooks and recovery reconciliation are absent.

- [ ] **Step 4: Implement sanitized outcome hooks**

Extend `createKickFetcher` dependencies with optional async lifecycle callbacks. Await the success callback after a successful background response; await the fallback callback before executing page fetch. Pass only `safeHost(url)` and `emit`.

- [ ] **Step 5: Implement the recovery state machine**

Use constants `PAGE_CONTEXT_RECOVERY_SUCCESSES = 3` and `PAGE_CONTEXT_RECOVERY_MIN_MS = 10 * 60_000`. Success increments the persisted counter. Close only when both thresholds pass. Fallback stamps the current time and resets the counter. A remove failure forgets stale metadata but does not emit a false close activity.

- [ ] **Step 6: Bind the extension lifecycle port**

Add thin wrappers in `packages/extension/src/core/tabs.ts` and inject them into `createKickFetcher` from `background.ts`, passing the operation's `emit` so events reach the controller collector and durable Activity repository.

- [ ] **Step 7: Run focused tests**

Run: `pnpm --filter @lurkloot/extension test -- adapters.test.ts tabs.test.ts activityView.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit adaptive recovery**

```bash
git add packages/core/src/platforms/kick/index.ts packages/core/src/core/tabs.ts packages/extension/src/core/tabs.ts packages/extension/entrypoints/background.ts packages/extension/tests/adapters.test.ts packages/extension/tests/tabs.test.ts
git commit -m "fix(kick): release recovered page contexts"
```

### Task 4: Scheduler retention and explicit cleanup reasons

**Files:**
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: reason-aware Task 2 stop port and current managed registry snapshot.
- Produces: `StopPageContextTabs` options `{ platforms?: Platform[]; reason: PageContextCloseReason; emit?: EventEmitter }` and explicit reason mapping for scheduler/controller cleanup.

- [ ] **Step 1: Add the cycling regression test**

Drive consecutive Kick scheduler ticks with a retained context while normal watching continues. Assert the stop port is not invoked merely because `prepareWatchTab` ran and the same context remains in `state.managedPageContextTabs`.

- [ ] **Step 2: Add explicit cleanup tests**

Assert automation stop uses `automation_disabled`, Kick disable uses `platform_disabled`, manual-watch takeover uses `manual_watch`, and startup/manual-close handling never closes an unowned tab.

- [ ] **Step 3: Run scheduler/controller tests and confirm failure**

Run: `pnpm --filter @lurkloot/extension test -- scheduler.test.ts backgroundController.test.ts`

Expected: FAIL on unconditional teardown and missing reason propagation.

- [ ] **Step 4: Remove ordinary watch-transition teardown**

Delete the unconditional `stopPageContextTabs(currentManagedPageContextTabs(), { platforms: [platform] })` after watch preparation. Continue assigning `currentManagedPageContextTabs()` into next state so metadata changes persist.

- [ ] **Step 5: Propagate explicit cleanup reasons**

Pass the appropriate enumerated close reason and current operation emitter from manual-watch and disabled branches through the injected browser stop port. Preserve the headless default by making pure `forgetManagedPageContextTabs` accept and ignore browser-only emission details.

- [ ] **Step 6: Run scheduler/controller tests**

Run: `pnpm --filter @lurkloot/extension test -- scheduler.test.ts backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit scheduler lifecycle behavior**

```bash
git add packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/extension/entrypoints/background.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(scheduler): retain required Kick page context"
```

### Task 5: Use the Kick Drops inventory as the managed context

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/tabs.test.ts`
- Test: `packages/extension/tests/compatibility.test.ts`

**Interfaces:**
- Consumes: existing `fetchJsonInPage(originUrl, requestUrl, init, options)` binding.
- Produces: `KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory"` as the extension-created fallback target while retaining origin identity `https://kick.com`.

- [ ] **Step 1: Write the failing production-wiring test**

In `compatibility.test.ts`, read `entrypoints/background.ts` with its existing `backgroundSource` fixture and assert:

```ts
expect(backgroundSource).toContain('const KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory";');
expect(backgroundSource).toContain("fetchJsonInPage<unknown>(KICK_PAGE_CONTEXT_URL, url, init");
```

- [ ] **Step 2: Run the exact source test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- compatibility.test.ts -t "uses the Kick Drops inventory for page-context fallback"`

Expected: FAIL because production currently passes the Kick homepage literal.

- [ ] **Step 3: Add the browser-property test**

Update the managed page-context creation test to call `fetchJsonInPageWithBrowser` with `https://kick.com/drops/inventory`. Assert:

```ts
expect(browser.tabs.create).toHaveBeenCalledWith({
  url: "https://kick.com/drops/inventory",
  pinned: false,
  active: false,
});
expect(browser.tabs.update).toHaveBeenCalledWith(14, { muted: true, active: false });
expect(currentManagedPageContextTabs().kick).toMatchObject({
  originUrl: "https://kick.com/drops/inventory",
  origin: "https://kick.com",
});
```

- [ ] **Step 4: Add and bind the inventory context constant**

In `packages/extension/entrypoints/background.ts`, define:

```ts
const KICK_PAGE_CONTEXT_URL = "https://kick.com/drops/inventory";
```

Pass that constant as `originUrl` to `fetchJsonInPage`. Do not change API request URLs, request authentication, origin matching, or user-tab reuse.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @lurkloot/extension test -- tabs.test.ts compatibility.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the inventory context URL**

```bash
git add packages/extension/entrypoints/background.ts packages/extension/tests/tabs.test.ts packages/extension/tests/compatibility.test.ts
git commit -m "fix(kick): open fallback on drops inventory"
```

### Task 6: Defer farming-tab recovery after manual closure

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: `handleTabRemoved(tabId)` and the existing controller state lock/event collector.
- Produces: a tab-free idle `WatchSession`, removal of `managedWatchTabs[platform]`, and no scheduler invocation from the removal callback.

- [ ] **Step 1: Replace the immediate-reopen test with a failing deferred-recovery test**

For a running, enabled Twitch session with `tabManagedByExtension: true`, tab id `10`, channel metadata, and a matching `managedWatchTabs.twitch`, call `handleTabRemoved(10)` and assert:

```ts
expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
expect(env.state.sessions.twitch).toMatchObject({
  platform: "twitch",
  status: "idle",
  offlineChecks: 0,
});
expect(env.state.sessions.twitch.tabId).toBeUndefined();
expect(env.state.sessions.twitch.channel).toBeUndefined();
expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
```

- [ ] **Step 2: Run the exact test and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts -t "defers recovery when the active managed farming tab is closed"`

Expected: FAIL because `handleTabRemoved` immediately calls `tick()` and leaves stale session/ownership fields until that tick replaces them.

- [ ] **Step 3: Clear the removed farming tab atomically**

Inside the existing state lock, identify every enabled/running platform whose watching session is extension-managed and matches `tabId`. For each match, replace the session with:

```ts
{
  platform,
  status: "idle",
  offlineChecks: 0,
}
```

Delete that platform from a copied `managedWatchTabs` map, persist the updated state, and emit a safe diagnostic stating that the managed farming tab was closed and recovery is deferred to the next scheduler cycle.

- [ ] **Step 4: Remove callback-driven scheduling**

Make `handleTabRemoved` return after its serialized persistence/reporting work. Delete the `shouldRerunScheduler` return value and trailing `if (shouldRerunScheduler) await tick()` path. Preserve manual-watch cleanup in the same atomic state update.

- [ ] **Step 5: Add ordinary-cycle recovery coverage**

After the deferred-closure assertions, clear adapter mocks and call `env.controller.tick()`. Assert discovery and `prepareWatchTab` are called and the session receives the replacement tab. This proves eventual recovery remains available without coupling it to `tabs.onRemoved`.

- [ ] **Step 6: Add separation cases**

Keep or extend tests proving unrelated ids and disabled platforms do not prepare tabs. Add a page-context id distinct from the farming session id and assert its removal does not clear the farming session or `managedWatchTabs` entry.

- [ ] **Step 7: Run focused controller tests**

Run: `pnpm --filter @lurkloot/extension test -- backgroundController.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit deferred recovery**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(core): defer closed farming tab recovery"
```

### Task 7: Integrated verification and publication

**Files:**
- Verify only: all files changed by Tasks 1-6

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: verified branch and draft pull request for issue #193.

- [ ] **Step 1: Run all workspace tests**

Run: `pnpm test`

Expected: all extension, CLI, and site tests pass.

- [ ] **Step 2: Run required release-grade verification**

Run: `pnpm verify`

Expected: script tests, all workspace typechecks, extension and CLI tests, site build, Chromium build, and Firefox build all pass.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git status --short && git log --oneline origin/develop..HEAD`

Expected: no whitespace errors, only issue #193 files changed, and focused Conventional Commits.

- [ ] **Step 4: Push and open the draft PR**

```bash
git push -u origin fix/kick-page-context-lifecycle
gh pr create --draft --base develop --head fix/kick-page-context-lifecycle --title "fix(kick): stabilize page-context tab lifecycle" --body-file /tmp/lurkloot-193-pr.md
```

The PR body must summarize background-first adaptive behavior, user-visible open/close activity, ownership safety, and verification; include `Closes #193`.
