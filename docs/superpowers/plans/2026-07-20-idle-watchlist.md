# Idle Watchlist Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Watch Queue to Idle Watchlist across Lurkloot while preserving legacy extension storage and CLI configuration without changing scheduling behavior.

**Architecture:** Normalize legacy `watchQueue*` inputs to the new `idleWatchlist*` shared model at extension/shared and CLI parsing boundaries. All runtime packages, generated output, UI/locales, current documentation, and promotional copy use only the new terminology; historical changelogs remain unchanged.

**Tech Stack:** TypeScript 7, pnpm workspaces, Vitest, React, WXT, Astro, JSON locale catalogs.

## Global Constraints

- Eligible drops remain the priority; the Idle Watchlist is an ordered fallback source.
- New keys win when both new and legacy keys are present, including empty arrays and `false`.
- Legacy extension storage and CLI config keys remain accepted indefinitely but are never emitted by current writers.
- Historical changelog entries remain unchanged.
- No permissions, credentials, host access, dependencies, or network behavior changes.
- Current copy uses “Idle Watchlist,” “watchlist,” and “channels,” not queue terminology.

---

### Task 1: Shared settings model and extension-storage compatibility

**Files:**
- Modify: `packages/shared/src/models.ts`
- Modify: `packages/shared/src/settings.ts`
- Test: `packages/extension/tests/settings.test.ts`

**Interfaces:**
- Consumes: arbitrary persisted objects passed to `mergeEngineSettings(value)` and `mergeSettings(value)`.
- Produces: `EngineSettings.idleWatchlistFallbackOnly: boolean` and `PlatformSettings.idleWatchlistChannels: string[]`.

- [ ] **Step 1: Write failing migration and precedence tests**

Add tests that pass legacy-only settings through `mergeSettings` and expect the new fields, then pass both forms and expect the new values:

```ts
it("migrates legacy Watch Queue settings to Idle Watchlist settings", () => {
  const settings = mergeSettings({
    watchQueueFallbackOnly: false,
    platform: {
      twitch: { watchQueueChannels: [" LegacyOne ", "legacyone", "Second"] },
      kick: { watchQueueChannels: ["KickLegacy"] },
    },
  } as never);

  expect(settings.idleWatchlistFallbackOnly).toBe(false);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacyone", "second"]);
  expect(settings.platform.kick.idleWatchlistChannels).toEqual(["kicklegacy"]);
  expect(settings).not.toHaveProperty("watchQueueFallbackOnly");
});

it("prefers new Idle Watchlist keys over legacy aliases", () => {
  const settings = mergeSettings({
    idleWatchlistFallbackOnly: false,
    watchQueueFallbackOnly: true,
    platform: {
      twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"] },
      kick: { idleWatchlistChannels: ["new"], watchQueueChannels: ["legacy"] },
    },
  } as never);

  expect(settings.idleWatchlistFallbackOnly).toBe(false);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual([]);
  expect(settings.platform.kick.idleWatchlistChannels).toEqual(["new"]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/settings.test.ts`

Expected: Type/runtime assertion failures because normalized settings do not expose `idleWatchlist*`.

- [ ] **Step 3: Rename shared types/defaults and add read aliases**

Rename the model properties and defaults. In `mergeEngineSettings`, use input-only legacy intersections and property-presence selection so falsy/empty new values win:

```ts
type LegacyEngineSettings = {
  watchQueueFallbackOnly?: boolean;
  platform?: {
    twitch?: { watchQueueChannels?: unknown };
    kick?: { watchQueueChannels?: unknown };
  };
};

function currentOrLegacy<T>(current: T | undefined, legacy: T | undefined, owner: object | undefined, key: string): T | undefined {
  return owner && Object.prototype.hasOwnProperty.call(owner, key) ? current : legacy;
}
```

Use it to normalize `idleWatchlistFallbackOnly` and each platform's `idleWatchlistChannels`. Return only the new model.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @lurkloot/extension test -- tests/settings.test.ts && pnpm --filter @lurkloot/shared typecheck`

Expected: migration tests pass; typecheck failures enumerate remaining runtime consumers for Task 2 but shared package itself passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/settings.ts packages/extension/tests/settings.test.ts
git commit -m "refactor(settings): migrate idle watchlist fields"
```

### Task 2: Core scheduler, events, and extension runtime

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/core/src/core/scheduler.ts`
- Modify: `packages/core/src/background/controller.ts`
- Modify: extension runtime files returned by `rg -l 'watchQueue|watch_queue|Watch Queue' packages/extension packages/core packages/shared`
- Test: `packages/extension/tests/scheduler.test.ts`
- Test: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**
- Consumes: the new shared settings fields from Task 1.
- Produces: reason codes `idle_watchlist_selected`, `higher_priority_idle_watchlist`, and `keeping_idle_watchlist`; event reason `higher_priority_idle_watchlist`.

- [ ] **Step 1: Rename behavioral test fixtures and expected reason codes**

Mechanically rename test input fields and test descriptions, then update representative assertions:

```ts
expect(decision).toMatchObject({
  action: "watch",
  username: "fallback",
  reasonCode: "idle_watchlist_selected",
});
```

Keep every existing behavioral expectation (ordering, liveness, exclusions, fallback-only policy) otherwise unchanged.

- [ ] **Step 2: Run scheduler/controller tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts tests/backgroundController.test.ts`

Expected: compile/assertion failures on the old runtime names and reason codes.

- [ ] **Step 3: Rename runtime identifiers and copy**

Replace shared event/model unions, controller dedupe entries, scheduler helpers, reason strings, comments, and extension consumers with the new names. For example:

```ts
function hasIdleWatchlistChannels(settings: EngineSettings, platform: Platform): boolean {
  return settings.platform[platform].idleWatchlistChannels.some((username) => username.trim());
}
```

Do not alter selection order or branching conditions.

- [ ] **Step 4: Run focused tests and workspace typechecks**

Run: `pnpm --filter @lurkloot/extension test -- tests/scheduler.test.ts tests/backgroundController.test.ts && pnpm typecheck`

Expected: focused tests and all workspace typechecks pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/core packages/extension
git commit -m "refactor(core): rename idle watchlist domain"
```

### Task 3: CLI compatibility and generated configuration

**Files:**
- Modify: `packages/cli/src/settings.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/events.ts`
- Modify: `packages/cli/README.md`
- Test: `packages/cli/tests/settings.test.ts`
- Test: relevant config tests under `packages/cli/tests/`

**Interfaces:**
- Consumes: CLI JSON with either `idleWatchlist*` or legacy `watchQueue*` keys.
- Produces: `CliSettings` and generated JSON containing only `idleWatchlist*`.

- [ ] **Step 1: Add failing CLI alias, precedence, and output tests**

```ts
it("accepts legacy watch queue keys but normalizes to idle watchlist keys", () => {
  const settings = parseCliSettings({
    watchQueueFallbackOnly: false,
    platform: { twitch: { watchQueueChannels: ["Legacy"] } },
  });
  expect(settings.idleWatchlistFallbackOnly).toBe(false);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual(["legacy"]);
});

it("prefers idle watchlist keys when legacy aliases are also present", () => {
  const settings = parseCliSettings({
    idleWatchlistFallbackOnly: false,
    watchQueueFallbackOnly: true,
    platform: { twitch: { idleWatchlistChannels: [], watchQueueChannels: ["legacy"] } },
  });
  expect(settings.idleWatchlistFallbackOnly).toBe(false);
  expect(settings.platform.twitch.idleWatchlistChannels).toEqual([]);
});
```

Also assert generated config text contains `"idleWatchlistChannels"` and not `"watchQueueChannels"`.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `pnpm --filter @lurkloot/cli test -- tests/settings.test.ts`

Expected: assertions fail because the new keys are rejected or absent.

- [ ] **Step 3: Implement CLI boundary aliases**

Allow both forms in validation sets, type the raw object as a legacy-capable input, select new values by own-property presence, and normalize into new-only `CliSettings`. Rename config template keys and event display text to Idle Watchlist.

- [ ] **Step 4: Run the CLI suite**

Run: `pnpm --filter @lurkloot/cli test && pnpm --filter @lurkloot/cli typecheck`

Expected: all CLI tests and typechecking pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "refactor(cli): migrate idle watchlist config"
```

### Task 4: Popup, locales, and demo

**Files:**
- Rename: `packages/popup-ui/src/watchQueue.tsx` to `packages/popup-ui/src/idleWatchlist.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx`
- Modify: `packages/popup-ui/src/settings.tsx`
- Modify: `packages/popup-ui/src/settingsPlatform.tsx`
- Modify: `packages/popup-ui/src/tips.tsx`
- Modify: `packages/popup-ui/src/demo.ts`
- Modify: all `packages/locales/messages/*.json`
- Test: `packages/extension/tests/tips.test.ts`
- Test: `packages/extension/tests/settingsView.test.tsx`
- Test: locale contract tests under `packages/extension/tests/`

**Interfaces:**
- Consumes: new settings fields and localization keys.
- Produces: current popup/demo copy consistently explaining the fallback relationship.

- [ ] **Step 1: Rename expected locale keys and UI test copy**

Rename keys such as `watchQueueTab`, `tipWatchQueue`, and `watchQueueFallbackOnlyTitle` to `idleWatchlistTab`, `tipIdleWatchlist`, and `idleWatchlistFallbackOnlyTitle`. Add an English-copy assertion that explains drops have priority and the list is used when no eligible drops are available.

- [ ] **Step 2: Run popup-related tests and verify RED**

Run: `pnpm --filter @lurkloot/extension test -- tests/tips.test.ts tests/settingsView.test.tsx`

Expected: missing translation keys and old-copy assertion failures.

- [ ] **Step 3: Rename popup components and locale catalogs**

Rename component exports, IDs, variables, handlers, and all catalog keys. Translate the feature name and fallback explanation naturally in every supported locale, preserving placeholders and catalog key parity. English canonical copy includes:

```json
"idleWatchlistTab": { "message": "Idle Watchlist" },
"tipIdleWatchlist": { "message": "Drops stay first priority. The Idle Watchlist watches your selected channels when no eligible drops are available." },
"idleWatchlistSettingsDescription": { "message": "Fallback channels used when no eligible drops are available." }
```

- [ ] **Step 4: Run popup tests, locale contracts, and typechecks**

Run: `pnpm --filter @lurkloot/extension test && pnpm --filter @lurkloot/popup-ui typecheck && pnpm --filter @lurkloot/locales typecheck`

Expected: all extension tests and both package typechecks pass.

- [ ] **Step 5: Commit**

```bash
git add packages/popup-ui packages/locales packages/extension/tests
git commit -m "refactor(popup): rename idle watchlist interface"
```

### Task 5: Current documentation, marketing, and stale-reference guard

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`
- Modify: `docs/store-descriptions.md`
- Modify: `docs/store-readiness.md`
- Modify: other current docs returned by the repository search
- Modify: `packages/site/src/faq.ts`
- Modify: `packages/site/src/components/Features.astro`
- Modify: other current site/promotional files returned by the repository search
- Test: create or extend a script test under `scripts/tests/` if an established repository-text-check pattern exists; otherwise use the explicit audit command below.

**Interfaces:**
- Consumes: the finalized product terminology.
- Produces: current documentation/marketing with no stale queue language.

- [ ] **Step 1: Audit stale references and record the failing result**

Run:

```bash
rg -n -i --glob '!packages/site/src/changelog.json' --glob '!docs/superpowers/**' 'watch queue|watchqueue|watch_queue|watchQueue'
```

Expected: matches in current docs/site/package code before cleanup.

- [ ] **Step 2: Update current documentation and promotional copy**

Replace current-feature references with Idle Watchlist terminology and explicitly state it is used only when no eligible drops are available under the default fallback setting. Do not edit `packages/site/src/changelog.json` or historical specs/plans.

- [ ] **Step 3: Verify the stale-reference allowlist**

Run the audit again.

Expected: matches only in input-boundary legacy type/key aliases and migration tests. Inspect each remaining line individually; no current user-visible English copy or runtime identifier may remain.

- [ ] **Step 4: Build and test the site**

Run: `pnpm --filter @lurkloot/site test`

Expected: Astro build and site tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md docs packages/site
git commit -m "docs: rename idle watchlist copy"
```

### Task 6: Full verification and publication

**Files:**
- Verify: all changed files

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: a reviewed branch and draft PR targeting `develop`.

- [ ] **Step 1: Run formatting/diff checks and terminology audit**

Run: `git diff --check origin/develop...HEAD && rg -n -i --glob '!packages/site/src/changelog.json' --glob '!docs/superpowers/**' 'watch queue|watchqueue|watch_queue|watchQueue'`

Expected: no diff errors; only intentional compatibility aliases/tests remain.

- [ ] **Step 2: Run full repository verification**

Run: `pnpm verify`

Expected: script tests, typechecks, extension/CLI/site tests, and Chromium/Firefox builds all exit 0.

- [ ] **Step 3: Review scope**

Run: `git status -sb && git diff --stat origin/develop...HEAD && git log --oneline origin/develop..HEAD`

Expected: only issue 176 files and focused conventional commits.

- [ ] **Step 4: Push and open draft PR**

```bash
git push -u origin refactor/idle-watchlist
gh pr create --draft --base develop --head refactor/idle-watchlist \
  --title "refactor: rename Watch Queue to Idle Watchlist" \
  --body-file <prepared-pr-body>
```

The PR body summarizes the rename, compatibility precedence, unchanged behavior, verification, and includes `Closes #176`.
