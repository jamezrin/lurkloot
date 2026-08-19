# Store Screenshot Dashboard Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Playwright operator command that regenerates, validates, replaces, orders, and saves all localized Chrome Web Store screenshots — plus the shared global set, filled from the English artwork — without persisting authentication or submitting the listing.

**Architecture:** A shared screenshot manifest feeds capture and upload. Pure file validation and replacement coordination are isolated from a narrow Playwright dashboard adapter, allowing deterministic tests without authenticated dashboard access. The command starts an ordinary headed Chrome with no automation switches and attaches over CDP, because Google rejects interactive sign-in in a Playwright-launched browser; it reuses that browser's existing context and fails closed when dashboard controls are missing or ambiguous.

**Tech Stack:** Node.js ES modules, Playwright, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-19-store-screenshot-dashboard-automation-design.md`

## Global Constraints

- Work only in `.worktrees/store-screenshot-rework` on `feat/store-screenshot-rework`.
- Never print Google authentication state, and never place it inside the repository. The signed-in Chrome profile persists deliberately, in the operator's own state directory, so a sync does not require a fresh login each time; it is local-only and never distributed.
- Never expose a submit, publish, review-cancellation, package, privacy, or distribution operation.
- Use role, label, and visible-text locators; fail on zero or multiple matches.
- Preserve two-space indentation, double quotes, semicolons, and ES modules.
- Use pnpm for all commands.

---

### Task 1: Shared manifest and screenshot-file validation

**Files:**
- Create: `packages/extension/scripts/store-screenshot-config.mjs`
- Create: `packages/extension/scripts/store-screenshot-files.mjs`
- Modify: `packages/extension/scripts/capture-store-screenshot.mjs`
- Create: `packages/extension/tests/storeScreenshotFiles.test.ts`

**Interfaces:**
- Produces `STORE_SCREENSHOT_VARIANTS`, `STORE_SCREENSHOT_LOCALES`, `parseRequestedLocales(args)`, `screenshotFilename(variant)`, and `validateStoreScreenshotFiles({ root, locales })`.
- The validator returns `Map<string, Array<{ variant: object; path: string }>>` in manifest order.

- [ ] **Step 1: Write failing manifest and validator tests**

Use literal expectations for 11 locale codes and five filenames. Create real temporary directories and minimal PNG buffers with a valid signature and IHDR dimensions. Assert successful ordered resolution plus rejection of unknown/duplicate locales, missing files, unexpected PNGs, invalid signatures, and wrong dimensions.

```ts
expect(parseRequestedLocales(["--locales", "ar", "tr"])).toEqual(["ar", "tr"]);
expect(() => parseRequestedLocales(["--locales", "ar", "ar"])).toThrow(/duplicate locale ar/i);
expect(files.get("en")?.map(({ path }) => basename(path))).toEqual([
  "lurkloot-01-drops-1280x800.png",
  "lurkloot-02-extras-1280x800.png",
  "lurkloot-03-easy-1280x800.png",
  "lurkloot-04-settings-1280x800.png",
  "lurkloot-05-updated-1280x800.png",
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotFiles.test.ts`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the minimal manifest and validator**

Parse PNG width/height directly from bytes 16–23 after verifying the eight-byte PNG signature and `IHDR` chunk. Reject any `.png` basename not in the expected set for a requested locale. Keep dashboard labels beside locale codes in the manifest.

- [ ] **Step 4: Move capture to the shared manifest**

Import the locale and variant arrays in `capture-store-screenshot.mjs`; preserve existing CLI behavior and output paths.

- [ ] **Step 5: Run focused tests and existing capture/i18n tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotFiles.test.ts tests/storeScreenshot.test.tsx tests/i18n.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/scripts/store-screenshot-config.mjs packages/extension/scripts/store-screenshot-files.mjs packages/extension/scripts/capture-store-screenshot.mjs packages/extension/tests/storeScreenshotFiles.test.ts
git commit -m "feat(store): validate screenshot upload assets"
```

---

### Task 2: Idempotent replacement coordinator

**Files:**
- Create: `packages/extension/scripts/store-screenshot-upload.mjs`
- Create: `packages/extension/tests/storeScreenshotUpload.test.ts`

**Interfaces:**
- Produces `replaceLocaleScreenshots({ locale, files, dashboard, onProgress })` and `uploadStoreScreenshots({ locales, filesByLocale, dashboard, onProgress })`.
- Consumes a dashboard adapter with `selectLocale`, `preflight`, `removeFirstScreenshot`, `waitForScreenshotCount`, `uploadScreenshot`, and `saveDraft`.

- [ ] **Step 1: Write failing coordinator tests**

Use an in-memory dashboard that models real listing state. Assert the final literal order `01` through `05`, four/five count waits, idempotence, recovery from each partial rotation state, one save after completion, no save after an upload error, and locale/phase context in errors.

```ts
expect(dashboard.images).toEqual(["01", "02", "03", "04", "05"]);
expect(dashboard.observedCounts).toEqual([4, 5, 4, 5, 4, 5, 4, 5, 4, 5]);
expect(dashboard.savedLocales).toEqual(["ar"]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotUpload.test.ts`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Run preflight once before mutation, then for each locale select, remove first, observe four, upload the next ordered file, observe five, and save. Wrap failures with locale, variant, and phase without retrying mutation.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotUpload.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/scripts/store-screenshot-upload.mjs packages/extension/tests/storeScreenshotUpload.test.ts
git commit -m "feat(store): coordinate screenshot replacement"
```

---

### Task 3: Fail-closed Playwright adapter, CLI, scripts, and docs

**Files:**
- Create: `packages/extension/scripts/store-screenshot-dashboard.mjs`
- Create: `packages/extension/scripts/upload-store-screenshots.mjs`
- Create: `packages/extension/tests/storeScreenshotDashboard.test.ts`
- Modify: `packages/extension/package.json`
- Modify: `package.json`
- Modify: `docs/chrome-web-store-submission.md`

**Interfaces:**
- Produces `ChromeWebStoreDashboard` with only navigation, preflight, locale selection, screenshot removal/upload/count, and draft-save methods.
- Produces `main(args, env, dependencies)` for testable CLI composition.

- [ ] **Step 1: Write failing adapter and CLI tests**

Serve a local HTML fixture with accessible item, locale selector, screenshot list, remove buttons, PNG input, save button, and saved status. Assert unique locator enforcement, first-thumbnail removal, file upload, saved-state waiting, and rejection of ambiguous controls. Test CLI validation happens before the browser starts, that the existing context is reused rather than a new one created, and that the session is finished on success and abandoned after a mutation failure. Inspect the public adapter prototype to assert there is no submit/publish method.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotDashboard.test.ts`

Expected: FAIL because the adapter and CLI modules do not exist.

- [ ] **Step 3: Implement the dashboard adapter**

Centralize English accessible labels, use `locator.count()` to enforce uniqueness before every mutation, and wait on counts/status rather than sleeps. Keep the base dashboard URL configurable for the fixture and default it to the configured Chrome Web Store item URL with `hl=en`.

- [ ] **Step 4: Implement the CLI and root commands**

Add package scripts:

```json
"screenshot:store:upload": "node scripts/upload-store-screenshots.mjs",
"screenshot:store:sync": "pnpm screenshot:store && pnpm screenshot:store:upload"
```

The root delegates both commands to `@lurkloot/extension`. The CLI resolves a Chrome binary (`CWS_CHROME_BINARY`, else a PATH scan preferring Chrome channels over Chromium), spawns it detached with only `--user-data-dir` and `--remote-debugging-port`, polls the endpoint for readiness, then `chromium.connectOverCDP(...)` and uses `browser.contexts()[0]` — a new context would carry no cookies. An endpoint that already answers is attached to and never closed.

- [ ] **Step 5: Document operation and recovery**

Explain configuration, fresh sign-in, draft-only behavior, full sync, upload-only locale retries, and unsupported-dashboard fail-closed behavior in `docs/chrome-web-store-submission.md`.

- [ ] **Step 6: Run focused tests and dry validation**

Run:

```bash
pnpm --filter @lurkloot/extension exec vitest run tests/storeScreenshotFiles.test.ts tests/storeScreenshotUpload.test.ts tests/storeScreenshotDashboard.test.ts tests/storeScreenshot.test.tsx tests/i18n.test.ts
CWS_EXTENSION_ID=aobaackpofkghaejdnnmpmeaiaoibhdn pnpm screenshot:store:upload -- --locales en --validate-only
```

Expected: tests PASS; validation reports five valid English files and launches no browser.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/scripts/store-screenshot-dashboard.mjs packages/extension/scripts/upload-store-screenshots.mjs packages/extension/tests/storeScreenshotDashboard.test.ts packages/extension/package.json package.json docs/chrome-web-store-submission.md
git commit -m "feat(store): automate screenshot draft uploads"
```

---

### Task 4: Repository verification

**Files:**
- Verify only.

- [ ] **Step 1: Run formatting and diff checks**

Run: `git diff --check origin/develop...HEAD`

- [ ] **Step 2: Run the repository check suite**

Run: `pnpm check`

- [ ] **Step 3: Run the extension production build**

Run: `pnpm build`

- [ ] **Step 4: Inspect tracked scope and ignored artifacts**

Run: `git status --short && git log --oneline origin/feat/store-screenshot-rework..HEAD`

Expected: only the pre-existing untracked `.superpowers/` and `docs/superpowers/plans/2026-08-16-store-screenshot-rework.md` remain; generated screenshots stay ignored.
