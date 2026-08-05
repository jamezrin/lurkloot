# Renovate-Only Auto-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict automatic pull-request merging to eligible Renovate updates while preserving squash-only history for ordinary `develop` PRs.

**Architecture:** The repository configuration reconciliation API explicitly disables GitHub's global auto-merge setting. Renovate merges eligible non-major PRs itself with the squash strategy, avoiding the global GitHub feature. Existing `main` and `develop` rulesets are unchanged.

**Tech Stack:** Node.js built-in test runner, GitHub REST repository settings API, Renovate JSON configuration.

## Global Constraints

- Ordinary PRs into `develop` use squash merge only.
- Release and hotfix PRs into `main` use merge commits only.
- GitHub repository-wide auto-merge must be disabled.
- Only Renovate may automatically merge eligible non-major dependency updates, using squash commits after checks pass.
- Do not add bypass actors or alter required status checks.

---

### Task 1: Disable GitHub-Wide Auto-Merge in Reconciliation

**Files:**
- Modify: `scripts/release/repository-config.test.mjs:24-37`
- Modify: `scripts/release/repository-config.mjs:7-17`

**Interfaces:**
- Consumes: `repositoryPatch(): Record<string, boolean | string>` used by `applyRepositoryConfig()` to PATCH `/repos/{owner}/{repo}`.
- Produces: a repository patch containing `allow_auto_merge: false` alongside existing merge-method settings.

- [ ] **Step 1: Write the failing test**

Extend the expected object in the `enables merge and squash while disabling repository-wide rebase` test:

```js
assert.deepEqual(repositoryPatch(), {
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_auto_merge: false,
  merge_commit_title: "PR_TITLE",
  merge_commit_message: "PR_BODY",
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/release/repository-config.test.mjs`

Expected: FAIL because `repositoryPatch()` lacks `allow_auto_merge`.

- [ ] **Step 3: Write the minimal implementation**

Add this property to `repositoryPatch()`:

```js
allow_auto_merge: false,
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test scripts/release/repository-config.test.mjs`

Expected: PASS with all repository configuration tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/repository-config.mjs scripts/release/repository-config.test.mjs
git commit -m "ci: disable repository-wide automerge"
```

### Task 2: Make Renovate Own Eligible Auto-Merges

**Files:**
- Modify: `renovate.json:1-9`

**Interfaces:**
- Consumes: Renovate's `packageRules` configuration schema.
- Produces: a rule that excludes major updates and uses Renovate-managed PR squash auto-merge.

- [ ] **Step 1: Validate the existing configuration**

Run: `pnpm exec renovate-config-validator renovate.json`

Expected: PASS for the current syntactically valid configuration; this records the validator used for the change.

- [ ] **Step 2: Add the Renovate-only auto-merge rule**

Add this `packageRules` entry after `extends`:

```json
"packageRules": [
  {
    "description": "Automerge non-major dependency updates after CI passes",
    "matchUpdateTypes": ["minor", "patch", "pin", "digest", "lockFileMaintenance"],
    "automerge": true,
    "automergeType": "pr",
    "platformAutomerge": false,
    "automergeStrategy": "squash"
  }
]
```

- [ ] **Step 3: Validate the changed configuration**

Run: `pnpm exec renovate-config-validator renovate.json`

Expected: PASS and report that `renovate.json` is valid.

- [ ] **Step 4: Commit**

```bash
git add renovate.json
git commit -m "ci: let Renovate manage dependency automerge"
```

### Task 3: Apply and Read Back the Live Repository Setting

**Files:**
- Modify: no further tracked files.

**Interfaces:**
- Consumes: authenticated `gh` CLI access with repository administration permission.
- Produces: the `allow_auto_merge` repository setting set to `false`.

- [ ] **Step 1: Confirm the current live setting**

Run: `gh api repos/jamezrin/lurkloot --jq '.allow_auto_merge'`

Expected: `true` before the update.

- [ ] **Step 2: Disable the setting**

Run: `gh api --method PATCH repos/jamezrin/lurkloot -f allow_auto_merge=false --jq '.allow_auto_merge'`

Expected: `false` in the response.

- [ ] **Step 3: Read back the setting**

Run: `gh api repos/jamezrin/lurkloot --jq '.allow_auto_merge'`

Expected: `false`.

### Task 4: Verify the Complete Change

**Files:**
- Modify: no further tracked files.

**Interfaces:**
- Consumes: the changed repository configuration code and `renovate.json`.
- Produces: evidence that repository configuration tests and workspace tests pass.

- [ ] **Step 1: Run release configuration tests**

Run: `pnpm release:test`

Expected: PASS with no failing release-script tests.

- [ ] **Step 2: Run the workspace test suite**

Run: `pnpm test`

Expected: PASS across CLI, extension, and site packages.

- [ ] **Step 3: Inspect the final diff and live setting**

Run:
```bash
git diff origin/develop...HEAD -- scripts/release/repository-config.mjs scripts/release/repository-config.test.mjs renovate.json
gh api repos/jamezrin/lurkloot --jq '.allow_auto_merge'
```

Expected: the diff disables global auto-merge and makes Renovate use `platformAutomerge: false`; the live setting is `false`.

- [ ] **Step 4: Commit any remaining tracked changes**

Run:
```bash
git status --short
git add renovate.json scripts/release/repository-config.mjs scripts/release/repository-config.test.mjs
git commit -m "ci: restrict automerge to Renovate"
```

Expected: no tracked implementation changes remain uncommitted. Do not create an empty commit if Tasks 1 and 2 already committed all implementation changes.
