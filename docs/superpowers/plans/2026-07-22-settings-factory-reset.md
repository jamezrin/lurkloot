# Settings Factory Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmed Settings action that stops Lurkloot, closes its managed tabs, removes all extension-owned data, restores defaults, and preserves Twitch/Kick login cookies.

**Architecture:** The extension background owns a new `resetExtension` runtime action and coordinates a browser-free controller shutdown with browser-storage deletion. The controller exposes a host-reset lifecycle method that force-cleans managed resources; the popup exposes reset only when its adapter advertises the capability and replaces its snapshot from the background response.

**Tech Stack:** TypeScript, React, WXT browser APIs, Vitest, pnpm workspaces, JSON locale catalogs.

## Global Constraints

- Work only in `.worktrees/settings-factory-reset` on `feat/settings-factory-reset`.
- Preserve Twitch and Kick cookies; the reset flow must not call `browser.cookies`.
- Clear all extension-owned `browser.storage.local` values and IndexedDB activity/diagnostic history.
- Restore `withSchemaVersion(DEFAULT_SETTINGS)` and `DEFAULT_STATE` after the clear.
- Close extension-managed watch and page-context tabs even when `autoCloseFinishedDrops` is `false`.
- Keep browser deletion out of `@lurkloot/core`; the CLI must not gain a factory-reset command.
- Hide reset in demo and store-screenshot modes.
- Add every new message to every catalog in `packages/locales/messages/*.json`.
- Follow two-space indentation, double quotes, semicolons, and explicit type imports.

---

### Task 1: Controller Host-Reset Lifecycle

**Files:**
- Modify: `packages/core/src/background/controller.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: existing `BackgroundControllerDeps`, scheduler state, adapter `stopWatchTab`, `stopPageContextTabs`, `closeManagedTabs`, claim-handoff aborts, and managed-page-context registration.
- Produces: `prepareForHostReset(): Promise<void>` on the object returned by `createBackgroundController()`.

- [ ] **Step 1: Write failing controller tests**

Add focused tests beside the existing `setRunning(false)` coverage. Build active Twitch and Kick watch sessions, a managed page-context tab, a tabless watcher where supported by the harness, and set `autoCloseFinishedDrops: false`. Assert the new lifecycle is unconditional and idempotent:

```ts
it("prepares a host reset by stopping live work and force-closing managed tabs", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: true, autoCloseFinishedDrops: false });
  await env.controller.tick();
  env.state.managedPageContextTabs = {
    twitch: {
      platform: "twitch",
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true,
    },
  };

  await env.controller.prepareForHostReset();

  expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 10 }),
    expect.objectContaining({ closeManagedTabs: true }),
  );
  expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 20 }),
    expect.objectContaining({ closeManagedTabs: true }),
  );
  expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
    expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
    expect.objectContaining({ platforms: ["twitch", "kick"] }),
  );
});

it("allows host-reset cleanup to be retried", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: true });
  await env.controller.tick();

  await env.controller.prepareForHostReset();
  await expect(env.controller.prepareForHostReset()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: FAIL because `prepareForHostReset` does not exist.

- [ ] **Step 3: Implement the lifecycle method**

In `createBackgroundController`, add a method that aborts handoffs, executes under `withStateLock`, loads settings/state, stops each in-memory tabless watcher, force-stops watch sessions using `{ closeManagedTabs: true }`, stops all registered page contexts, unregisters page contexts, clears the watcher map, resets cached integrity, and does not persist replacement settings/state (the extension storage coordinator owns that write). Reuse existing scoped event-collector and best-effort event reporting patterns.

The public shape must be:

```ts
async function prepareForHostReset(): Promise<void> {
  abortClaimHandoffs();
  await withStateLock(() => withEventCollector(async (emit, events) => {
    const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
    const adapters = createAdapters(settings, emit);
    for (const platform of PLATFORMS) {
      const watcher = tablessWatchers.get(platform);
      if (watcher) await watcher.stop();
      await adapters[platform].stopWatchTab(state.sessions[platform], { closeManagedTabs: true }, emit);
    }
    if (deps.stopPageContextTabs) {
      await deps.stopPageContextTabs(state.managedPageContextTabs ?? {}, {
        platforms: PLATFORMS,
        reason: "automation_disabled",
        emit,
      });
    }
    tablessWatchers.clear();
    registerManagedPageContextTabs({});
    lastIntegrityToken = undefined;
    setTwitchIntegrity(undefined);
    await reportBestEffort(events);
  }));
}
```

Adapt calls to the exact existing `TablessWatchController.stop`, adapter `stopWatchTab`, and `setTwitchIntegrity` signatures rather than adding duplicate cleanup APIs. Export `prepareForHostReset` in the returned controller object.

- [ ] **Step 4: Run controller tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: focused tests PASS and core typecheck exits 0.

- [ ] **Step 5: Commit the lifecycle boundary**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(core): add host reset cleanup lifecycle"
```

### Task 2: Extension Storage and Runtime Coordinator

**Files:**
- Modify: `packages/shared/src/messages.ts`
- Modify: `packages/extension/src/core/storage.ts`
- Modify: `packages/extension/src/core/activityMessages.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Test: `packages/extension/tests/storageMigration.test.ts`
- Test: `packages/extension/tests/storageSettingsMigration.test.ts`
- Test: `packages/extension/tests/activityMessages.test.ts`

**Interfaces:**
- Consumes: `controller.prepareForHostReset(): Promise<void>`, `resetStorage(): Promise<void>`, and `controller.handleMessage({ type: "getSnapshot" })`.
- Produces: `{ type: "resetExtension" }` in `RuntimeMessage`; `resetExtension(): Promise<RuntimeSnapshot>` dispatcher dependency; a reset response containing canonical defaults.

- [ ] **Step 1: Write failing storage reset tests**

Extend storage mocks with `clear` and make it delete every mocked key. Replace the existing best-effort activity failure expectation with strict, retryable failure behavior:

```ts
it("clears every local key before restoring canonical defaults", async () => {
  mocks.values.settings = { running: true };
  mocks.values.schedulerState = { ...DEFAULT_STATE, lastTickAt: "2026-07-22T12:00:00.000Z" };
  mocks.values.twitchIntegrity = { integrity: "secret" };
  mocks.values["popup:selectedPlatform"] = "kick";
  mocks.values["future:extension-owned-key"] = true;

  await resetStorage();

  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(Object.keys(mocks.values).sort()).toEqual(["schedulerState", "settings"]);
  expect(mocks.values.schedulerState).toEqual(DEFAULT_STATE);
  expect(mocks.values.settings).toEqual(withSchemaVersion(DEFAULT_SETTINGS));
});

it("reports activity reset failure and succeeds when retried", async () => {
  mocks.clearActivityEvents
    .mockRejectedValueOnce(new Error("IDB unavailable"))
    .mockResolvedValueOnce(undefined);

  await expect(resetStorage()).rejects.toThrow("IDB unavailable");
  await expect(resetStorage()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run storage tests and confirm failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- storageMigration.test.ts storageSettingsMigration.test.ts
```

Expected: FAIL because storage is not cleared wholesale and activity failures are swallowed.

- [ ] **Step 3: Make resetStorage authoritative and serialized**

Update the WXT storage mock shape in both test files. Change `resetStorage` so it holds both existing locks, calls `browser.storage.local.clear()`, then writes both canonical documents in one `set`. Call `clearActivityEvents()` without swallowing rejection:

```ts
export async function resetStorage(): Promise<void> {
  await withSettingsStorageLock(async () => {
    await withStateStorageLock(async () => {
      await browser.storage.local.clear();
      await browser.storage.local.set({
        [SETTINGS_KEY]: withSchemaVersion(DEFAULT_SETTINGS),
        [STATE_KEY]: DEFAULT_STATE,
      });
    });
  });
  await clearActivityEvents();
}
```

- [ ] **Step 4: Write failing dispatcher tests**

Extend the dispatcher harness with `resetExtension: vi.fn()` and assert exact routing:

```ts
it("routes factory reset to the extension coordinator", async () => {
  const resetExtension = vi.fn(async () => ({ settings: DEFAULT_SETTINGS, state: DEFAULT_STATE }));
  const dispatch = createRuntimeMessageDispatcher({
    exportCliCredentials: vi.fn(),
    resetExtension,
    handleActivityMessage: vi.fn(),
    handleCoreMessage: vi.fn(),
  });

  await dispatch({ type: "resetExtension" });

  expect(resetExtension).toHaveBeenCalledOnce();
});
```

- [ ] **Step 5: Add the runtime action and coordinator**

Add `{ type: "resetExtension" }` to `RuntimeMessage`, not `CoreRuntimeMessage`. Extend `RuntimeMessageDispatcherDeps` and route it before activity/core messages:

```ts
interface RuntimeMessageDispatcherDeps {
  exportCliCredentials(): Promise<unknown>;
  resetExtension(): Promise<unknown>;
  handleActivityMessage(message: RuntimeMessage): Promise<unknown>;
  handleCoreMessage(message: CoreRuntimeMessage, sender?: RuntimeMessageSender): Promise<unknown>;
}

if (message.type === "resetExtension") return deps.resetExtension();
```

In `background.ts`, import `resetStorage` and provide a serialized coordinator:

```ts
let resetMutation: Promise<RuntimeSnapshot<ExtensionSettings>> | undefined;

function resetExtension(): Promise<RuntimeSnapshot<ExtensionSettings>> {
  if (resetMutation) return resetMutation;
  resetMutation = (async () => {
    await controller.prepareForHostReset();
    await resetStorage();
    return controller.handleMessage({ type: "getSnapshot" }) as Promise<RuntimeSnapshot<ExtensionSettings>>;
  })().finally(() => {
    resetMutation = undefined;
  });
  return resetMutation;
}
```

Use a typed helper instead of an unsafe cast if controller inference permits it. Pass `resetExtension` into `createRuntimeMessageDispatcher`. Do not touch `browser.cookies`.

- [ ] **Step 6: Run storage, dispatcher, boundary, and type tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- storageMigration.test.ts storageSettingsMigration.test.ts activityMessages.test.ts coreBoundary.test.ts
pnpm typecheck
```

Expected: all selected tests PASS and all workspace typechecks exit 0.

- [ ] **Step 7: Commit background reset coordination**

```bash
git add packages/shared/src/messages.ts packages/extension/src/core/storage.ts packages/extension/src/core/activityMessages.ts packages/extension/entrypoints/background.ts packages/extension/tests/storageMigration.test.ts packages/extension/tests/storageSettingsMigration.test.ts packages/extension/tests/activityMessages.test.ts
git commit -m "feat(extension): coordinate factory reset"
```

### Task 3: Confirmed Settings Action and Localization

**Files:**
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/extension/entrypoints/popup/app.tsx`
- Modify: `packages/locales/messages/*.json`
- Test: `packages/extension/tests/settingsFactoryReset.test.tsx`
- Test: `packages/extension/tests/settingsView.test.tsx`

**Interfaces:**
- Consumes: adapter `send<RuntimeSnapshot>({ type: "resetExtension" })` and the snapshot returned by Task 2.
- Produces: optional `PopupAdapter.resetExtension(): Promise<RuntimeSnapshot>` capability; `SettingsView` props `onReset?: () => Promise<void>` and `resetConfirmationResetKey: number`.

- [ ] **Step 1: Write failing Settings action tests**

Create `settingsFactoryReset.test.tsx` using the existing LinkeDOM/React test setup from `settingsCredentialExport.test.tsx`. Cover hidden capability, arm/cancel, one in-flight request, success, and failure:

```tsx
it("requires confirmation and blocks duplicate reset requests", async () => {
  let finish!: () => void;
  const onReset = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = renderSettings({ onReset });

  click(view.getByText("Reset Lurkloot"));
  expect(onReset).not.toHaveBeenCalled();
  click(view.getByText("Reset everything"));
  click(view.getByText("Resetting…"));
  expect(onReset).toHaveBeenCalledOnce();

  finish();
  await act(async () => undefined);
});

it("shows a retryable alert when reset fails", async () => {
  const onReset = vi.fn()
    .mockRejectedValueOnce(new Error("reset failed"))
    .mockResolvedValueOnce(undefined);
  const view = renderSettings({ onReset });

  click(view.getByText("Reset Lurkloot"));
  click(view.getByText("Reset everything"));
  await act(async () => undefined);

  expect(view.getByRole("alert").textContent).toContain("couldn't reset");
  click(view.getByText("Try reset again"));
  await act(async () => undefined);
  expect(onReset).toHaveBeenCalledTimes(2);
});
```

Add a popup-level test using a capable adapter. Assert the reset response replaces settings, Settings closes, and a second click while pending sends only one runtime request.

- [ ] **Step 2: Run popup tests and confirm failure**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsFactoryReset.test.tsx settingsView.test.tsx
```

Expected: FAIL because reset capability and UI do not exist.

- [ ] **Step 3: Add adapter capability and popup state transition**

In `PopupAdapter`, add:

```ts
resetExtension?(): Promise<RuntimeSnapshot>;
```

In the live extension adapter, implement it using runtime messaging:

```ts
resetExtension: () => browser.runtime.sendMessage({ type: "resetExtension" }),
```

In `Popup`, create the handler only when capability exists:

```ts
const resetExtension = adapter.resetExtension
  ? async () => {
      await settingsSaveQueue.current.catch(() => undefined);
      const nextSnapshot = await adapter.resetExtension!();
      settingsRef.current = mergeSettings(nextSnapshot.settings);
      invalidateActivityRequests("twitch");
      setActivityStream(createActivityStream());
      setDiagnosticStream(createActivityStream());
      setPlatform("twitch");
      setTab("drops");
      setPendingChangelogVersion(undefined);
      setSnapshot(snapshotWithMergedSettings(nextSnapshot));
      setSettingsOpen(false);
    }
  : undefined;
```

Pass it to `SettingsView`. Do not add it to `createDemoPopupAdapter`.

- [ ] **Step 4: Implement the inline danger area**

Add `resetArmed`, `resetting`, and `resetFailed` state to `SettingsView`, reset them when `resetConfirmationResetKey` changes, and render the action only when `onReset` exists and search is inactive. Follow the credential-export visual pattern, but use red styling only for the final destructive button:

```tsx
{onReset && !searching ? (
  <div className="pt-2">
    <div className="mb-1 flex items-center gap-1.5 px-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500">{t("factoryResetTitle")}</span>
      <span className="h-px flex-1 bg-red-100 dark:bg-red-950" />
    </div>
    {resetArmed ? (
      <div className="space-y-2 px-1 py-1">
        <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{t("factoryResetConfirm")}</p>
        {resetFailed ? <p role="alert" className="text-xs text-red-600">{t("factoryResetFailed")}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={resetting} onClick={() => setResetArmed(false)}>{t("factoryResetCancel")}</button>
          <button type="button" disabled={resetting} onClick={() => void confirmReset()}>
            {t(resetting ? "factoryResetProgress" : resetFailed ? "factoryResetRetry" : "factoryResetConfirmButton")}
          </button>
        </div>
      </div>
    ) : (
      <div className="space-y-2 px-1 pb-1">
        <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("factoryResetHint")}</p>
        <div className="flex justify-end">
          <button type="button" onClick={() => setResetArmed(true)}>{t("factoryResetButton")}</button>
        </div>
      </div>
    )}
  </div>
) : null}
```

Apply the repository's complete existing button classes and add a `RotateCcw` icon; the abbreviated markup above defines behavior and copy keys, not permission to omit accessibility or focus styles.

- [ ] **Step 5: Add English copy and propagate all locale keys**

Add these keys to `packages/locales/messages/en.json` with complete descriptions:

```json
"factoryResetTitle": { "message": "Reset Lurkloot", "description": "Heading for the destructive factory reset action" },
"factoryResetHint": { "message": "Erase all Lurkloot settings, farming progress, and activity history. Your Twitch and Kick accounts stay signed in.", "description": "Factory reset scope explanation" },
"factoryResetButton": { "message": "Reset Lurkloot", "description": "Button that opens factory reset confirmation" },
"factoryResetConfirm": { "message": "This stops farming, closes tabs opened by Lurkloot, and permanently erases all Lurkloot data. Twitch and Kick stay signed in.", "description": "Factory reset confirmation warning" },
"factoryResetCancel": { "message": "Cancel", "description": "Cancels factory reset confirmation" },
"factoryResetConfirmButton": { "message": "Reset everything", "description": "Final factory reset confirmation button" },
"factoryResetProgress": { "message": "Resetting…", "description": "Factory reset in-progress label" },
"factoryResetFailed": { "message": "Lurkloot couldn't reset completely. Try again.", "description": "Factory reset failure alert" },
"factoryResetRetry": { "message": "Try reset again", "description": "Retries a failed factory reset" }
```

Add accurate translations for the same keys to every other JSON catalog, preserving valid JSON and each catalog's ordering convention.

- [ ] **Step 6: Run popup and locale validation tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsFactoryReset.test.tsx settingsView.test.tsx locales.test.ts
pnpm --filter @lurkloot/popup-ui typecheck
pnpm --filter @lurkloot/extension typecheck
```

Expected: all selected tests PASS and both typechecks exit 0.

- [ ] **Step 7: Commit the Settings experience**

```bash
git add packages/popup-ui/src/types.ts packages/popup-ui/src/settings.tsx packages/popup-ui/src/Popup.tsx packages/extension/entrypoints/popup/app.tsx packages/locales/messages packages/extension/tests/settingsFactoryReset.test.tsx packages/extension/tests/settingsView.test.tsx
git commit -m "feat(settings): add factory reset action"
```

### Task 4: Full Verification and Documentation Check

**Files:**
- Verify: `docs/superpowers/specs/2026-07-22-settings-factory-reset-design.md`
- Verify: all files changed by Tasks 1–3

**Interfaces:**
- Consumes: complete reset lifecycle, storage coordinator, runtime route, popup capability, and localized UI.
- Produces: a verified issue #208 implementation ready for code review.

- [ ] **Step 1: Inspect scope and forbidden cookie access**

Run:

```bash
git diff origin/develop...HEAD --stat
git diff origin/develop...HEAD -- packages/extension packages/core packages/popup-ui packages/shared | rg "browser\.cookies|cookies\.remove|cookies\.set" || true
git diff --check origin/develop...HEAD
```

Expected: only planned files plus specs/plans are changed; the cookie search prints no reset-path additions; diff check exits 0.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all CLI, extension, and site tests PASS.

- [ ] **Step 3: Run release-grade verification**

Run:

```bash
pnpm verify
```

Expected: script tests, all workspace typechecks, extension tests, site build, Chromium build, and Firefox build all exit 0.

- [ ] **Step 4: Review the final diff and commit any verification-only corrections**

Run:

```bash
git status --short
git log --oneline origin/develop..HEAD
git diff origin/develop...HEAD --check
```

If verification required a correction, commit only that focused correction:

```bash
git add -u
git commit -m "fix(settings): harden factory reset"
```

Expected: clean worktree and a small Conventional Commit history containing the design, controller lifecycle, background coordinator, and Settings UI changes.
