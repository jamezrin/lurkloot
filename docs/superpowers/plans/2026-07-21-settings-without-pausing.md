# Settings Without Pausing Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening, editing, and closing Settings leave active farming untouched while reconciling scheduling changes promptly at global or platform scope.

**Architecture:** Delete the Settings-specific pause connection across popup, extension shell, shared messages, and controller. Keep the existing serialized `saveSettings` path, and annotate scheduling controls with the existing `tickAfterSave` and `tickAfterSavePlatforms` options so the controller stays browser-free and schema-agnostic.

**Tech Stack:** TypeScript 7, React 19, WXT WebExtension APIs, Vitest, pnpm monorepo.

## Global Constraints

- Work only in `.worktrees/settings-without-pausing` on `fix/settings-without-pausing`.
- Keep `@lurkloot/core` free of WXT and browser globals.
- Do not change the settings schema, storage format, scheduler algorithm, CLI behavior, or Settings layout.
- Global scheduling changes refresh all enabled platforms; platform-specific scheduling changes refresh only that platform.
- Explicit automation/provider disabling must continue to stop work immediately.
- Use two-space indentation, double quotes, semicolons, explicit imports, and `type` imports for types.

---

### Task 1: Remove the controller pause lifecycle

**Files:**
- Modify: `packages/extension/tests/backgroundController.test.ts`
- Modify: `packages/core/src/background/controller.ts`

**Interfaces:**
- Consumes: existing `tick(platforms?: Platform[])`, `runWatchHeartbeat()`, and `handleMessage(message)` controller operations.
- Produces: a controller with no `settingsPauseCount`, `beginSettingsSession()`, `endSettingsSession()`, or `tick(..., { forcePaused: true })` API.

- [ ] **Step 1: Replace pause-specific controller tests with the retained automation guarantees**

Delete the tests named `temporarily pauses active sessions while a settings session is open without persisting running=false`, `does not run tickAfterSave automation while settings are temporarily paused`, and `aborts running handoffs when a settings session begins`.

Add this regression beside the existing `saveSettings` tests to prove an ordinary save cannot stop an active session:

```ts
it("keeps active farming untouched when saving a non-scheduling setting", async () => {
  const env = harness({ ...DEFAULT_SETTINGS, running: true });
  env.state.sessions.twitch = {
    platform: "twitch",
    status: "watching",
    channel: channel("twitch"),
    tabId: 10,
    tabManagedByExtension: true,
    offlineChecks: 0,
  };

  const snapshot = asSnapshot(await env.controller.handleMessage({
    type: "saveSettings",
    settingsPatch: { notifyRewardEarned: false },
  }));

  expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
  expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  expect(snapshot.state.sessions.twitch.status).toBe("watching");
});
```

Add a handoff regression beside the post-claim handoff tests. Start a handoff, wait until its manual timer is parked, save a non-scheduling setting, and assert the timer remains parked before flushing the loop to its deadline. This proves an ordinary save does not abort the active handoff while the existing `setRunning(false)` test continues to prove explicit shutdown does.

- [ ] **Step 2: Run the focused test and confirm the old lifecycle still exists**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
```

Expected: the new regression passes, while TypeScript/source inspection still shows `settingsPauseCount`, `beginSettingsSession`, and `endSettingsSession`; this establishes behavior before deleting the obsolete API.

- [ ] **Step 3: Delete controller pause state and branches**

In `packages/core/src/background/controller.ts`:

- delete `let settingsPauseCount = 0;`;
- change `tick(platforms?: Platform[], options?: { forcePaused?: boolean })` to `tick(platforms?: Platform[])`;
- replace the forced settings selection with `const settings = await deps.loadSettings();`;
- delete the `if (settingsPauseCount > 0) return;` guard from `runWatchHeartbeat()`;
- delete `beginSettingsSession()` and `endSettingsSession()`;
- simplify the `saveSettings` condition to:

```ts
if (message.tickAfterSave && settings.running && hasEnabledPlatform(settings)) {
  await tickAndHandOff(message.tickAfterSavePlatforms);
}
```

- remove `beginSettingsSession` and `endSettingsSession` from the returned controller object.

- [ ] **Step 4: Run controller tests and typecheck**

Run:

```bash
pnpm --filter @lurkloot/extension test -- backgroundController.test.ts
pnpm --filter @lurkloot/core typecheck
```

Expected: the controller tests pass and core typecheck reports no errors.

- [ ] **Step 5: Commit the controller change**

```bash
git add packages/core/src/background/controller.ts packages/extension/tests/backgroundController.test.ts
git commit -m "fix(core): remove settings pause lifecycle"
```

---

### Task 2: Remove the extension and popup session connection

**Files:**
- Create: `packages/extension/tests/popupSettingsLifecycle.test.tsx`
- Modify: `packages/shared/src/messages.ts`
- Modify: `packages/extension/entrypoints/background.ts`
- Modify: `packages/extension/entrypoints/popup/app.tsx`
- Modify: `packages/popup-ui/src/types.ts`
- Modify: `packages/popup-ui/src/Popup.tsx`

**Interfaces:**
- Consumes: `PopupAdapter.send`, `PopupAdapter.getStorage`, and the existing Settings/Back buttons.
- Produces: a popup adapter without `connectSettingsSession`, and UI navigation with no pause/resume side channel or close-time resume polling.

- [ ] **Step 1: Add a popup lifecycle regression test**

Create `packages/extension/tests/popupSettingsLifecycle.test.tsx` using the same `linkedom`, `createRoot`, and global stubs as `settingsCredentialExport.test.tsx`. Start from `createDemoPopupAdapter()`, override `send` with a spy that delegates to the demo adapter, render the popup in preview mode, click Back and Open settings, and assert navigation sends no runtime message:

```ts
it("opens and closes settings without runtime lifecycle messages", async () => {
  const demo = createDemoPopupAdapter();
  const send = vi.fn(demo.send);
  const adapter: PopupAdapter = {
    ...demo,
    send,
    getMessage: (key) => ({ openSettings: "Open settings", back: "Back" })[key] ?? demo.getMessage(key),
  };

  await act(async () => {
    root = createRoot(container);
    root.render(<Popup adapter={adapter} initialState={{ preview: true, variant: screenshotVariant("settings") }} />);
    await Promise.resolve();
  });
  send.mockClear();

  act(() => byLabel(container, "Back").click());
  act(() => byLabel(container, "Open settings").click());

  expect(send).not.toHaveBeenCalled();
});
```

Include local `byLabel`, DOM setup, animation-frame stubs, unmount cleanup, and `vi.unstubAllGlobals()` so the file runs independently.

- [ ] **Step 2: Run the lifecycle test**

Run:

```bash
pnpm --filter @lurkloot/extension test -- popupSettingsLifecycle.test.tsx
```

Expected: PASS for preview navigation. The production-only port remains detectable by the subsequent type/source removals.

- [ ] **Step 3: Delete the Settings port contract and extension wiring**

- Delete `SETTINGS_SESSION_PORT` from `packages/shared/src/messages.ts`.
- Remove its import and the `browser.runtime.onConnect` Settings listener from `packages/extension/entrypoints/background.ts`.
- Remove its import and `connectSettingsSession` implementation from `packages/extension/entrypoints/popup/app.tsx`.
- Remove `connectSettingsSession?(): () => void;` from `PopupAdapter` in `packages/popup-ui/src/types.ts`.

- [ ] **Step 4: Delete popup resume state and effects**

In `packages/popup-ui/src/Popup.tsx`, delete:

- `resumingAutomation` state;
- `wasSettingsOpen` and `resumeRefreshRun` refs;
- `hasTemporaryDisabledSession()`;
- the effect that calls `adapter.connectSettingsSession()`;
- the effect that polls after Settings closes;
- the unmount effect that increments `resumeRefreshRun`.

Pass only the real session message to the hero:

```tsx
<AutomationHero
  platformLabel={PLATFORMS[platform].label}
  enabled={enabled}
  pending={automationPending}
  farmingTitle={activeCampaign?.title}
  farmingChannel={farmingChannel}
  onFarmingTitleClick={onFarmingTitleClick}
  statusMessage={session.message}
  onChange={setAutomation}
/>
```

Remove the `resumingAutomation` header branch so the normal active/paused title is always derived from persisted settings.

- [ ] **Step 5: Prove the removed symbols are gone and run focused checks**

Run:

```bash
rg "SETTINGS_SESSION_PORT|connectSettingsSession|settingsPauseCount|beginSettingsSession|endSettingsSession|resumingAutomation|hasTemporaryDisabledSession" packages
pnpm --filter @lurkloot/extension test -- popupSettingsLifecycle.test.tsx backgroundController.test.ts
pnpm typecheck
```

Expected: `rg` exits 1 with no matches; focused tests and workspace typecheck pass.

- [ ] **Step 6: Commit the extension lifecycle removal**

```bash
git add packages/shared/src/messages.ts packages/extension/entrypoints/background.ts packages/extension/entrypoints/popup/app.tsx packages/popup-ui/src/types.ts packages/popup-ui/src/Popup.tsx packages/extension/tests/popupSettingsLifecycle.test.tsx
git commit -m "fix(popup): keep automation running in settings"
```

---

### Task 3: Classify global and platform scheduling controls

**Files:**
- Modify: `packages/extension/tests/settingsView.test.tsx`
- Modify: `packages/popup-ui/src/settingsRegistry.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`

**Interfaces:**
- Consumes: `SettingsView`'s `onSettingsChange(patch, options?)` callback and `updateSettings(patch, options?)`.
- Produces: global scheduling calls with `{ tickAfterSave: true }` and platform scheduling calls with `{ tickAfterSave: true, tickAfterSavePlatforms: [platform] }`.

- [ ] **Step 1: Add failing assertions for missing global refresh classifications**

Extend `settingsView.test.tsx` with focused interactions asserting:

```ts
expect(onSettingsChange).toHaveBeenCalledWith(
  { campaignVisibility: expect.any(Object) },
  { tickAfterSave: true },
);
```

Keep the existing deadline assertion. Add an assertion that a save-only control such as `notifyRewardEarned` calls `onSettingsChange({ notifyRewardEarned: false })` with no second argument. Existing platform category/excluded-channel tests should continue expecting:

```ts
{ tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] }
```

- [ ] **Step 2: Run settings tests and verify the campaign-visibility test fails**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsView.test.tsx
```

Expected: FAIL because campaign visibility currently omits `{ tickAfterSave: true }`.

- [ ] **Step 3: Add global refresh intent in the settings registry**

Change campaign visibility to:

```tsx
<CampaignFilterSettingRow
  value={settings.campaignVisibility}
  onChange={(campaignVisibility) => void onSettingsChange(
    { campaignVisibility },
    { tickAfterSave: true },
  )}
/>
```

Retain the existing global tick options for priority mode, excluded-campaign reset, tabless mode, skip-unfinishable rewards, and deadline margin. Add the same global tick option to Idle Watchlist fallback policy because it changes scheduler selection for both platforms. Retain `platformPatch()` for category and excluded-channel targeting.

- [ ] **Step 4: Make drag priority changes request global reconciliation**

In `packages/popup-ui/src/Popup.tsx`, change the Drops panel callback to:

```tsx
onReorder={(ordered) => updateSettings(
  { campaignPriorities: prioritiesFromOrder(ordered) },
  { tickAfterSave: true },
)}
```

Retain global reconciliation for excluded campaigns and targeted reconciliation for idle-watchlist ordering.

- [ ] **Step 5: Run focused settings and popup tests**

Run:

```bash
pnpm --filter @lurkloot/extension test -- settingsView.test.tsx dropsView.test.tsx popupSettingsLifecycle.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 5a: Cover rapid serialized reconciliation**

Add a controller test that blocks the first targeted Twitch discovery, sends a second scheduling save while the first reconciliation is active, then releases the first call. Assert both setting patches are present, Twitch discovery ran twice, and an active-discovery counter never exceeded one. Run `backgroundController.test.ts` and expect it to pass.

- [ ] **Step 6: Commit refresh classification**

```bash
git add packages/popup-ui/src/settingsRegistry.tsx packages/popup-ui/src/Popup.tsx packages/extension/tests/settingsView.test.tsx
git commit -m "fix(settings): reconcile scheduling changes by scope"
```

---

### Task 4: Verify the complete change

**Files:**
- Modify only if verification exposes an issue in files already listed above.

**Interfaces:**
- Consumes: all behavior produced by Tasks 1-3.
- Produces: evidence that issue #192 acceptance criteria pass across tests, typechecks, site build, and browser builds.

- [ ] **Step 1: Run the full extension suite**

```bash
pnpm test
```

Expected: all extension, CLI, and site tests pass with zero failures.

- [ ] **Step 2: Run repository verification**

```bash
pnpm verify
```

Expected: script tests, workspace typechecks, extension tests, Astro site build, Chromium build, and Firefox build all pass.

- [ ] **Step 3: Inspect the final diff and repository state**

```bash
git diff --check origin/develop...HEAD
git status --short --branch
git log --oneline origin/develop..HEAD
```

Expected: no whitespace errors, no uncommitted files, and only the design, plan, lifecycle-removal, refresh-classification, and any focused repair commits appear.

- [ ] **Step 4: Commit any verification-only repair**

If Step 1 or Step 2 required a focused repair, stage only the repaired files and commit with a specific Conventional Commit subject, then rerun both verification commands. If no repair was required, do not create an empty commit.
