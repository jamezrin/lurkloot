# Rotating Popup Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed popup priority hint with localized tips that rotate every 10 seconds and can be hidden from General settings.

**Architecture:** Keep tip selection and sequencing in a small pure helper, and render it through a focused `TipsBanner` React component. Persist only an extension-host `showTips` preference; the rotation position remains ephemeral and the farming engine and CLI stay unchanged.

**Tech Stack:** TypeScript, React, Framer Motion, Vitest, WXT locale JSON, pnpm.

## Global Constraints

- Tips are visible by default for new and existing users.
- Start at a random tip, advance sequentially every 10 seconds, and do not repeat within a cycle.
- Pause while the popup document is hidden and clean up timers on unmount.
- Respect reduced-motion preferences.
- The only dismissal control is a `Hide tips` toggle in General settings.
- External links open safely in a new tab; settings tips remain plain text.
- Keep `showTips` out of `EngineSettings` and CLI configuration.
- Update all ten locale catalogs.

---

### Task 1: Persist the extension-only preference

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Produces: `ExtensionSettings.showTips: boolean`, defaulted and normalized by `DEFAULT_SETTINGS` and `mergeSettings`.

- [ ] **Step 1: Write the failing settings tests**

Add assertions that `mergeSettings(undefined).showTips` is `true`, that `false` is preserved, and that a non-boolean persisted value falls back to `true`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/extension/tests/settings.test.ts`
Expected: FAIL because `showTips` does not exist.

- [ ] **Step 3: Add the minimal extension setting**

Add `showTips: boolean` only to `ExtensionSettings`, set it to `true` in `DEFAULT_SETTINGS`, and normalize it through `booleanOr` in `mergeSettings`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run packages/extension/tests/settings.test.ts`
Expected: PASS.

### Task 2: Add deterministic rotation logic and the focused banner

**Files:**
- Create: `packages/popup-ui/src/tips.tsx`
- Test: `packages/extension/tests/tips.test.tsx`
- Modify: `packages/extension/package.json` only if the existing test environment needs an already-installed DOM test helper exposed.

**Interfaces:**
- Produces: `TipsBanner` and pure `nextTipIndex(current: number, count: number): number` behavior.
- Consumes: localized message keys through `useI18n` and canonical external URL constants.

- [ ] **Step 1: Write failing rotation and rendering tests**

Cover wraparound sequencing, random initial selection through an injected/testable initializer, 10-second advancement with fake timers, hidden-document pausing, timer cleanup, and secure external-link attributes.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run packages/extension/tests/tips.test.tsx`
Expected: FAIL because `tips.tsx` does not exist.

- [ ] **Step 3: Implement the minimal helper and component**

Define the static tip descriptors at module scope, lazily initialize the random index, use one visibility-aware effect for the interval, clear it during cleanup, and render the existing info-banner styling with `AnimatePresence`/`motion` and reduced-motion-safe transitions.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm vitest run packages/extension/tests/tips.test.tsx`
Expected: PASS with no timer or React warnings.

### Task 3: Integrate settings, popup, URLs, and translations

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/constants.ts`
- Modify: `packages/locales/messages/{en,es,fr,it,ru,de,zh_CN,hi,pt_BR,ar}.json`
- Modify: `packages/extension/tests/settings.test.ts`
- Test: `packages/extension/tests/tips.test.tsx`

**Interfaces:**
- Consumes: `TipsBanner`, `ExtensionSettings.showTips`, `SettingsPatch.showTips`.
- Produces: localized `hideTipsTitle`, `hideTipsDescription`, tip-copy keys, and optional link-label keys.

- [ ] **Step 1: Extend failing integration assertions**

Assert that the popup source gates `TipsBanner` on `settings.showTips`, General settings updates `{ showTips: !hideTips }`, all locale catalogs contain the required keys, and canonical CLI/GitHub issue URLs are exported once.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run packages/extension/tests/settings.test.ts packages/extension/tests/tips.test.tsx`
Expected: FAIL on missing integration and locale keys.

- [ ] **Step 3: Wire the UI and localize all catalogs**

Replace the inline fixed hint with `<TipsBanner />` when `showTips` is true, add the inverse `Hide tips` toggle to General settings, centralize external destinations, and add concise translations for all required messages.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run packages/extension/tests/settings.test.ts packages/extension/tests/tips.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run repository verification**

Run: `pnpm test && pnpm typecheck && pnpm build:site`
Expected: all commands exit 0.
