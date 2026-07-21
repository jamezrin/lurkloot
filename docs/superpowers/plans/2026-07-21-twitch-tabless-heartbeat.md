# Optional Platform Host Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Twitch's Spade heartbeat without disabling the extension on upgrade, while allowing users to pre-authorize future first-party Twitch and Kick subdomains.

**Architecture:** Preserve the exact hosts already shipped as required permissions and declare one optional wildcard per provider. The extension popup owns permission checks and user-gesture requests through optional adapter methods; shared popup/demo code receives state and callbacks without importing browser APIs. Twitch transport diagnostics and the existing muted-tab fallback remain unchanged.

**Tech Stack:** TypeScript 7, React 19, WXT 0.20, WebExtension permissions API, Vitest 4, pnpm 11.

## Global Constraints

- Keep `www.twitch.tv`, `gql.twitch.tv`, `kick.com`, `web.kick.com`, and `websockets.kick.com` mandatory.
- Declare `https://*.twitch.tv/*` and `https://*.kick.com/*` only in `optional_host_permissions`.
- Request Twitch and Kick independently and only from an explicit user click.
- Denial must not disable a provider or remove current exact-host behavior.
- Never log paths, query strings, headers, cookies, tokens, or payloads.
- Do not modify package versions; the release workflow owns the `1.8.1` bump.

---

### Task 1: Preserve contextual Twitch heartbeat failures

**Files:**
- Modify: `packages/core/src/platforms/twitch/heartbeat/spade.ts`
- Test: `packages/extension/tests/twitchHeartbeat.test.ts`
- Create: `packages/extension/src/core/twitchHeartbeatTransport.ts`
- Create: `packages/extension/tests/heartbeatTransport.test.ts`
- Modify: `packages/extension/entrypoints/background.ts`

**Interfaces:**
- Produces: `twitchHeartbeatFetchText(url, init): Promise<string>` and `twitchHeartbeatPost(url, init): Promise<{ status: number }>`.
- Produces: private `SpadeSendResult = { ok: true } | { ok: false; message: string }`.

- [x] **Step 1: Add failing tests for destination fetch and final POST errors**
- [x] **Step 2: Confirm the old POST path collapses the thrown message**
- [x] **Step 3: Preserve safe stage/hostname context through one Spade retry**
- [x] **Step 4: Run `pnpm --filter @lurkloot/extension test -- twitchHeartbeat.test.ts heartbeatTransport.test.ts` and confirm PASS**
- [x] **Step 5: Commit the core and extension transport changes**

### Task 2: Declare optional provider wildcards

**Files:**
- Modify: `packages/extension/wxt.config.ts`
- Test: `packages/extension/tests/manifestPermissions.test.ts`

**Interfaces:**
- Produces required exact hosts plus `optional_host_permissions: ["https://*.twitch.tv/*", "https://*.kick.com/*"]`.

- [ ] **Step 1: Change the manifest test to assert the new Twitch heartbeat exact hosts are absent from `host_permissions`, both wildcards occur under `optional_host_permissions`, and all five previously shipped exact hosts remain required**
- [ ] **Step 2: Run `pnpm --filter @lurkloot/extension test -- manifestPermissions.test.ts` and confirm it fails against the current mandatory hosts**
- [ ] **Step 3: Remove `assets`, `spade`, and `beacon` from required hosts and add the two optional wildcards**
- [ ] **Step 4: Rerun the focused test and confirm PASS**
- [ ] **Step 5: Commit as `fix(extension): make platform wildcard access optional`**

### Task 3: Add the permission adapter boundary

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/extension/entrypoints/popup/app.tsx`
- Test: `packages/extension/tests/popupAdapter.test.tsx`

**Interfaces:**
- Produces: `getPlatformHostAccess?(platform: Platform): Promise<boolean>`.
- Produces: `requestPlatformHostAccess?(platform: Platform): Promise<boolean>`.
- Maps Twitch to only `https://*.twitch.tv/*` and Kick to only `https://*.kick.com/*`.

- [ ] **Step 1: Add failing adapter tests asserting exact `permissions.contains` and `permissions.request` calls for each provider**
- [ ] **Step 2: Run `pnpm --filter @lurkloot/extension test -- popupAdapter.test.tsx` and confirm FAIL**
- [ ] **Step 3: Add the optional adapter methods and the provider-to-origin mapping without adding browser imports to `popup-ui`**
- [ ] **Step 4: Rerun the focused test and confirm PASS**
- [ ] **Step 5: Commit as `feat(popup): expose optional platform host access`**

### Task 4: Add provider-specific consent UI

**Files:**
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx`
- Modify: `packages/popup-ui/src/settingsControls.tsx`
- Modify: `packages/locales/messages/*.json`
- Test: `packages/extension/tests/settingsRegistry.test.tsx`

**Interfaces:**
- `SettingsView` loads permission state for each provider when mounted.
- `PlatformHostAccessRow` displays available, pending, granted, or denied state and invokes only the selected provider callback.
- Demo adapters omit permission methods, so screenshots and the site demo render no permission action.

- [ ] **Step 1: Add failing tests for missing/granted state, a disabled pending button, denial retry, and absence when adapter methods are unavailable**
- [ ] **Step 2: Run `pnpm --filter @lurkloot/extension test -- settingsRegistry.test.tsx` and confirm FAIL**
- [ ] **Step 3: Implement the focused action row and pass permission state/callbacks into the settings registry**
- [ ] **Step 4: Add catalog-complete copy for access title, explanation, grant, granted, pending, and denied states**
- [ ] **Step 5: Rerun the focused test and locale validation and confirm PASS**
- [ ] **Step 6: Commit as `feat(popup): request optional platform access`**

### Task 5: Document and publish the patch PR update

**Files:**
- Modify: `docs/store-readiness.md`
- Modify: `packages/site/src/changelog.json`

- [ ] **Step 1: Replace mandatory Twitch heartbeat-host documentation with optional Twitch/Kick wildcard justification and denial behavior**
- [ ] **Step 2: Prepend an undated `1.8.1` fixed item: `Fixed Twitch tabless farming falling back to muted watch tabs because required heartbeat services could not be reached.`**
- [ ] **Step 3: Run `pnpm verify` and confirm all tests, typechecks, site build, Chromium build, and Firefox build pass**
- [ ] **Step 4: Inspect both generated manifests and confirm the two wildcards are optional, the new Twitch heartbeat exact hosts are not required, and the five existing exact hosts remain required**
- [ ] **Step 5: Commit as `docs(release): add 1.8.1 hotfix changelog`**
- [ ] **Step 6: Push the branch and update PR #189 with permission consent, fallback, changelog, and verification details**
