# Required Platform Wildcard Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require first-party Twitch and Kick wildcard access in the 1.8.1 hotfix and remove the now-unnecessary optional-consent feature.

**Architecture:** Replace every exact platform host and both optional wildcard declarations with two required wildcard match patterns. Delete the permission adapter, consent UI, runtime reporting, locale copy, and their focused tests as one vertical feature removal. Preserve credential-safe Twitch heartbeat diagnostics and ordinary muted-tab fallback; retain only allowlisted generic failures or HTTP status causes.

**Tech Stack:** TypeScript 7, React 19, WXT 0.20, WebExtension manifests, Vitest 4, pnpm 11.

## Global Constraints

- Required hosts are exactly `https://*.twitch.tv/*` and `https://*.kick.com/*`.
- Do not retain exact Twitch/Kick host entries, `optional_host_permissions`, or Firefox MV2 `optional_permissions`.
- Remove all optional platform-access UI and supporting code.
- Keep contextual Twitch heartbeat errors and ordinary managed-tab fallback unchanged.
- Changelog copy must explain the permission need functionally and warn that existing users may need to approve updated access.
- Do not modify package versions; the release workflow owns the `1.8.1` bump.

---

### Task 1: Require both platform wildcards

**Files:**
- Modify: `packages/extension/tests/manifestPermissions.test.ts`
- Modify: `packages/extension/wxt.config.ts`

**Interfaces:**
- Produces: `host_permissions: ["https://*.twitch.tv/*", "https://*.kick.com/*"]` for Chrome MV3 and the equivalent required `permissions` entries for Firefox MV2.

- [ ] **Step 1: Change the manifest test to require both wildcards, reject the five old exact entries, and reject both optional-permission keys**
- [ ] **Step 2: Run `pnpm --filter @lurkloot/extension exec vitest run tests/manifestPermissions.test.ts` and confirm failure against the optional implementation**
- [ ] **Step 3: Replace the manifest host list with only the two required wildcards and remove manifest-version branching**
- [ ] **Step 4: Rerun the focused test and confirm PASS**
- [ ] **Step 5: Commit as `fix(extension): require platform wildcard access`**

### Task 2: Remove optional permission consent

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/extension/entrypoints/popup/app.tsx`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx`
- Modify: `packages/popup-ui/src/settingsControls.tsx`
- Modify: `packages/shared/src/messages.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/src/core/activityMessages.ts`
- Modify: `packages/extension/tests/activityMessages.test.ts`
- Modify: `packages/extension/tests/settingsView.test.tsx`
- Delete: `packages/extension/tests/popupAdapter.test.tsx`
- Modify: `packages/locales/messages/*.json`

**Interfaces:**
- Removes: `PopupAdapter.getPlatformHostAccess`, `PopupAdapter.requestPlatformHostAccess`, `reportPlatformHostAccess`, and `PlatformHostAccessRow`.

- [ ] **Step 1: Remove the consent-focused tests and restore remaining test fixtures to their pre-consent shape**
- [ ] **Step 2: Delete permission checking/requesting, settings state and rendering, runtime reporting, and all six localized permission strings**
- [ ] **Step 3: Run `pnpm typecheck` and the extension suite; confirm no optional-consent references remain and all tests pass**
- [ ] **Step 4: Commit as `refactor(popup): remove optional host consent`**

### Task 3: Explain the migration and publish the revised hotfix

**Files:**
- Modify: `docs/store-readiness.md`
- Modify: `packages/site/src/changelog.json`

- [ ] **Step 1: Document required first-party wildcards and the one-time browser approval risk in store-readiness notes**
- [ ] **Step 2: Add this functional `1.8.1` improved item: `Expanded Twitch and Kick site access so farming keeps working when either platform moves features between its own services. Your browser may ask you to approve the updated access after installing this update.`**
- [ ] **Step 3: Run `pnpm verify` and confirm all tests, typechecks, site builds, Chromium MV3 build, and Firefox MV2 build pass**
- [ ] **Step 4: Inspect generated manifests and assert only the two required wildcard hosts exist and no optional permission key exists**
- [ ] **Step 5: Commit as `docs(release): explain platform permission migration`**
- [ ] **Step 6: Push, update PR #189, and wait for validation plus the refreshed patch release candidate**
