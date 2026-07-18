# Merge-First Release Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a `release/*` label from closing the pull request it is applied to; instead merge that pull request normally and cut the version-bump pull request from the resulting merge commit on `main`.

**Architecture:** `prepare-release.yml` splits into a `validate` job (on `labeled`/`unlabeled`, keeps policy checks and the preview candidate) and a `cut` job (on `closed` + merged, creates the release branch and its pull request). The supersede-and-close step is deleted. The `preview` environment gains `develop` and `hotfix/*` deployment branch policies so label-time builds stop being rejected, and the release branch gains a `push`-triggered candidate build so it no longer depends on a `GITHUB_TOKEN`-created pull request event that never fires.

**Tech Stack:** GitHub Actions (`pull_request_target`, reusable workflows, environments), Node 24 ESM tooling under `scripts/release/`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-19-merge-first-release-flow-design.md`

**Run all script tests with:** `pnpm release:test`

---

## Sequencing note (read before starting)

`pull_request_target` executes the workflow definition from the **base** branch. The new
`prepare-release.yml` therefore has no effect until it is merged to `main`. The order is:

1. Tasks 1–6 on a branch, merged to `main` **without** a release label.
2. Task 7 rolls back the failed 1.6.0 attempt.
3. Task 8 re-runs the release by hand through the new flow.

Do not apply a `release/*` label to the implementation pull request itself.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `scripts/release/pipeline.mjs` | Pure release-lifecycle predicates | Add `expectedReleaseAssets` / `assertReleaseAssets` |
| `scripts/release/pipeline.test.mjs` | Tests for the above | Add cases |
| `scripts/release/cli.mjs` | Command surface | Assert assets in `publish-candidate` |
| `scripts/release/repository-config.mjs` | Declarative repo config | Add `preview` environment branch policies |
| `scripts/release/repository-config.test.mjs` | Tests for the above | Add cases |
| `scripts/release/workflows.test.mjs` | Workflow-shape assertions | Cover split + push trigger |
| `.github/workflows/prepare-release.yml` | Label lifecycle | Split into `validate` + `cut`; delete supersede |
| `.github/workflows/release-candidate.yml` | Candidate controller | Add `push` trigger on `release/**` |
| `.github/workflows/release.yml` | Stable publication | Assert assets before upload |
| `CLAUDE.md`, `RELEASING.md` | Documented process | Describe merge-first flow |

---

## Task 1: Release asset allowlist

Prevents a stray file in `release-assets/` from becoming a published asset, which is how
`candidate.json` reached the `v1.5.0` release under the previous workflow generation.

**Files:**
- Modify: `scripts/release/pipeline.mjs`
- Test: `scripts/release/pipeline.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/release/pipeline.test.mjs`:

```javascript
test("expected release assets are the four builds plus checksums", () => {
  assert.deepEqual(expectedReleaseAssets("1.6.0"), [
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-1.6.0-chrome.zip",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-1.6.0-firefox.zip",
  ]);
});

test("asset assertion accepts the exact expected set in any order", () => {
  const names = [
    "lurkloot-1.6.0-firefox.zip",
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-1.6.0-chrome.zip",
  ];
  assert.deepEqual(assertReleaseAssets({ names, version: "1.6.0" }), expectedReleaseAssets("1.6.0"));
});

test("asset assertion rejects an unexpected file", () => {
  const names = [...expectedReleaseAssets("1.6.0"), "candidate.json"];
  assert.throws(() => assertReleaseAssets({ names, version: "1.6.0" }), /unexpected release asset: candidate\.json/);
});

test("asset assertion rejects a missing file", () => {
  const names = expectedReleaseAssets("1.6.0").filter((name) => name !== "SHA256SUMS");
  assert.throws(() => assertReleaseAssets({ names, version: "1.6.0" }), /missing release asset: SHA256SUMS/);
});

test("asset assertion rejects a version mismatch", () => {
  assert.throws(
    () => assertReleaseAssets({ names: expectedReleaseAssets("1.5.0"), version: "1.6.0" }),
    /unexpected release asset: lurkloot-1\.5\.0-chrome\.crx/,
  );
});
```

Add the two names to that file's existing import from `./pipeline.mjs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm release:test`
Expected: FAIL — `expectedReleaseAssets is not a function` (or an import error naming it).

- [ ] **Step 3: Implement in `scripts/release/pipeline.mjs`**

Append:

```javascript
// The upload steps glob their assets directory, so anything a build step leaves behind would be
// published. Both the candidate prerelease and the stable release must carry exactly this set.
export function expectedReleaseAssets(version) {
  return [
    "SHA256SUMS",
    `lurkloot-${version}-chrome.crx`,
    `lurkloot-${version}-chrome.zip`,
    `lurkloot-${version}-firefox-sources.zip`,
    `lurkloot-${version}-firefox.zip`,
  ];
}

export function assertReleaseAssets({ names, version }) {
  const expected = expectedReleaseAssets(version);
  const actual = [...names].sort();
  for (const name of actual) {
    if (!expected.includes(name)) throw new Error(`unexpected release asset: ${name}`);
  }
  for (const name of expected) {
    if (!actual.includes(name)) throw new Error(`missing release asset: ${name}`);
  }
  return expected;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/pipeline.mjs scripts/release/pipeline.test.mjs
git commit -m "feat(release): assert the published asset set"
```

---

## Task 2: Enforce the allowlist in `publish-candidate`

**Files:**
- Modify: `scripts/release/cli.mjs:101-117`

- [ ] **Step 1: Wire the assertion in**

In `scripts/release/cli.mjs`, extend the existing `./pipeline.mjs` import to include
`assertReleaseAssets`, then replace the body of `"publish-candidate"`:

```javascript
  async "publish-candidate"(values) {
    const entries = await readdir(values.assets, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    assertReleaseAssets({ names: files.map((entry) => basename(entry.name)), version: values.version });
    const assets = await Promise.all(files.map(async (entry) => ({
      name: basename(entry.name),
      bytes: await readFile(join(values.assets, entry.name)),
    })));
    await reconcilePrerelease({
      client: githubClient(),
      pr: Number(values.pr),
      version: values.version,
      sha: values.sha,
      notes: await readFile(values.notes, "utf8"),
      assets,
    });
  },
```

- [ ] **Step 2: Verify nothing regressed**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/release/cli.mjs
git commit -m "feat(release): reject unexpected candidate assets"
```

---

## Task 3: Enforce the allowlist in `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml:178-186`
- Test: `scripts/release/workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/release/workflows.test.mjs`:

```javascript
test("stable publication verifies its asset set before uploading", async () => {
  const text = await workflow("release.yml");
  assert.match(text, /assert-assets/);
  assert.match(text, /gh release upload "v\$VERSION" release-assets\/\* --clobber/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm release:test`
Expected: FAIL on the `assert-assets` match.

- [ ] **Step 3: Add the CLI command**

In `scripts/release/cli.mjs`, add alongside the other commands:

```javascript
  async "assert-assets"(values) {
    const entries = await readdir(values.assets, { withFileTypes: true });
    assertReleaseAssets({
      names: entries.filter((entry) => entry.isFile()).map((entry) => basename(entry.name)),
      version: values.version,
    });
  },
```

- [ ] **Step 4: Call it from the workflow**

In `.github/workflows/release.yml`, insert immediately before the
`Create or update the stable GitHub release` step:

```yaml
      - name: Verify the release asset set
        run: node scripts/release/cli.mjs assert-assets --assets release-assets --version "$VERSION"
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/cli.mjs .github/workflows/release.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): verify stable assets before upload"
```

---

## Task 4: Split `prepare-release.yml` into `validate` and `cut`

This is the core change. The supersede step is deleted here.

**Files:**
- Modify: `.github/workflows/prepare-release.yml`
- Test: `scripts/release/workflows.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/release/workflows.test.mjs`:

```javascript
test("labelling a pull request never closes it", async () => {
  const text = await workflow("prepare-release.yml");
  assert.doesNotMatch(text, /gh pr close/);
  assert.doesNotMatch(text, /Superseded by/);
});

test("the release branch is cut from the merge commit after the pull request lands", async () => {
  const text = await workflow("prepare-release.yml");
  assert.match(text, /types: \[closed\]/);
  assert.match(text, /github\.event\.pull_request\.merged/);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
  assert.match(text, /git switch -C "release\/\$VERSION"/);
  assert.match(text, /gh pr create --base main --head "release\/\$VERSION"/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm release:test`
Expected: FAIL — `gh pr close` is still present and `types: [closed]` is absent.

- [ ] **Step 3: Rewrite the workflow**

Replace the whole of `.github/workflows/prepare-release.yml` with:

```yaml
name: Prepare release

on:
  pull_request_target:
    types: [labeled, unlabeled, closed]
    branches: [main]

permissions:
  contents: read

concurrency:
  group: prepare-release
  cancel-in-progress: false

jobs:
  validate:
    if: >-
      (github.event.action == 'labeled' || github.event.action == 'unlabeled') &&
      startsWith(github.event.label.name, 'release/') &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      !startsWith(github.event.pull_request.head.ref, 'release/')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    env:
      GH_REPO: ${{ github.repository }}
    outputs:
      action: ${{ steps.policy.outputs.action }}
      version: ${{ steps.policy.outputs.version }}
    steps:
      # pull_request_target supplies a write token, so only trusted base-branch tooling is executed.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          path: trusted
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - id: policy
        name: Resolve the live release policy
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
        run: |
          labels=$(jq -r '[.pull_request.labels[].name] | join(",")' "$GITHUB_EVENT_PATH")
          tags=$(git -C trusted tag --list 'v*' | tr '\n' ' ')
          if ! node trusted/scripts/release/cli.mjs policy --labels "$labels" --head "$HEAD_REF" --tags "$tags"; then
            gh pr comment "$PR" --body "Release preparation is blocked: only one of \`release/patch\`, \`release/minor\`, or \`release/major\` may be applied."
            exit 1
          fi
      - name: Report a removed release label
        if: steps.policy.outputs.action == 'orphan'
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
        run: gh pr comment "$PR" --body "All release labels were removed. Merging this pull request will no longer cut a release."

  preview:
    needs: validate
    if: needs.validate.outputs.action == 'prepare'
    permissions:
      contents: write
      packages: write
      pull-requests: write
      statuses: write
    uses: ./.github/workflows/build-release-candidate.yml
    with:
      ref: ${{ github.event.pull_request.head.sha }}
      trusted_ref: ${{ github.event.pull_request.base.sha }}
      version: ${{ needs.validate.outputs.version }}
      pr_number: ${{ github.event.pull_request.number }}
    secrets:
      CRX_PRIVATE_KEY: ${{ secrets.CRX_PRIVATE_KEY }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  cut:
    if: >-
      github.event.action == 'closed' &&
      github.event.pull_request.merged &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      !startsWith(github.event.pull_request.head.ref, 'release/') &&
      contains(join(github.event.pull_request.labels.*.name, ','), 'release/')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    env:
      GH_REPO: ${{ github.repository }}
    outputs:
      version: ${{ steps.policy.outputs.version }}
      release_pr: ${{ steps.open.outputs.release_pr }}
      release_sha: ${{ steps.open.outputs.release_sha }}
    steps:
      # The merge commit is already on main, so there is no untrusted tree here and a single
      # checkout serves as both the tooling source and the branch point.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.merge_commit_sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - id: policy
        name: Resolve the live release policy
        env:
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
        run: |
          labels=$(jq -r '[.pull_request.labels[].name] | join(",")' "$GITHUB_EVENT_PATH")
          tags=$(git tag --list 'v*' | tr '\n' ' ')
          node scripts/release/cli.mjs policy --labels "$labels" --head "$HEAD_REF" --tags "$tags"
      - name: Refuse to overwrite another pull request's release branch
        env:
          VERSION: ${{ steps.policy.outputs.version }}
          TRIGGER: ${{ github.event.pull_request.number }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          body=$(gh pr list --head "release/$VERSION" --state open --json body --jq '.[0].body // ""')
          if [ -n "$body" ] && ! printf '%s' "$body" | grep -qF "via #$TRIGGER."; then
            gh pr comment "$TRIGGER" --body "Release \`$VERSION\` is already owned by another pull request. Release or close that candidate first."
            exit 1
          fi
      - name: Bump the workspace
        env:
          VERSION: ${{ steps.policy.outputs.version }}
        run: node scripts/release/cli.mjs prepare-workspace --version "$VERSION" --date "$(date -u +%F)"
      - id: open
        name: Push the release branch and open its pull request
        env:
          VERSION: ${{ steps.policy.outputs.version }}
          LABEL: ${{ steps.policy.outputs.label }}
          HEAD_REF: ${{ github.event.pull_request.head.ref }}
          TRIGGER: ${{ github.event.pull_request.number }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -C "release/$VERSION"
          git add package.json packages/*/package.json packages/site/src/changelog.json
          git diff --cached --quiet || git commit -m "chore(release): bump version to $VERSION"
          git push --force "https://x-access-token:$GITHUB_TOKEN@github.com/$GITHUB_REPOSITORY" \
            "HEAD:refs/heads/release/$VERSION"
          gh pr create --base main --head "release/$VERSION" \
            --title "chore(release): bump version to $VERSION" \
            --label "$LABEL" \
            --body "Version bump and changelog date for $VERSION, cut from \`$HEAD_REF\` via #$TRIGGER. Merge with a merge commit to publish." \
            || gh pr edit "release/$VERSION" --title "chore(release): bump version to $VERSION" --add-label "$LABEL"
          release_pr=$(gh pr view "release/$VERSION" --json number --jq .number)
          echo "release_pr=$release_pr" >> "$GITHUB_OUTPUT"
          echo "release_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"

  candidate:
    needs: cut
    permissions:
      contents: write
      packages: write
      pull-requests: write
      statuses: write
    uses: ./.github/workflows/build-release-candidate.yml
    with:
      ref: ${{ needs.cut.outputs.release_sha }}
      trusted_ref: ${{ github.event.pull_request.merge_commit_sha }}
      version: ${{ needs.cut.outputs.version }}
      pr_number: ${{ fromJSON(needs.cut.outputs.release_pr) }}
    secrets:
      CRX_PRIVATE_KEY: ${{ secrets.CRX_PRIVATE_KEY }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm release:test`
Expected: PASS, including the pre-existing
`release preparation uses trusted base tooling for label lifecycle events` test — the `validate`
job retains `path: trusted`, `prepare-workspace`, `--add-label "$LABEL"`, and the
`build-release-candidate.yml` reference. If that test fails on `path: candidate`, update it to
assert `path: candidate` only within the preview path, since `cut` now uses a single checkout.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/prepare-release.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): cut the release branch after the pull request merges"
```

---

## Task 5: `push` trigger for the release branch candidate

Covers pushes to `release/**` after the initial cut, without depending on a
`GITHUB_TOKEN`-created pull request event.

**Files:**
- Modify: `.github/workflows/release-candidate.yml`
- Test: `scripts/release/workflows.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("the release branch rebuilds its candidate on push", async () => {
  const text = await workflow("release-candidate.yml");
  assert.match(text, /push:\n\s+branches: \['release\/\*\*'\]/);
  assert.match(text, /github\.event_name == 'push'/);
  assert.match(text, /release_pr=\$\(gh pr list --head "\$REF_NAME" --base main --state open/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm release:test`
Expected: FAIL — no `push:` trigger.

- [ ] **Step 3: Add the trigger and a push-resolution job**

In `.github/workflows/release-candidate.yml`, extend the trigger block:

```yaml
on:
  pull_request_target:
    types: [opened, reopened, synchronize]
    branches: [main]
  push:
    branches: ['release/**']
```

Change the concurrency group so it is defined for both events:

```yaml
concurrency:
  group: release-candidate-controller-${{ github.event.pull_request.number || github.ref_name }}
  cancel-in-progress: true
```

Gate the existing `non-release` and `resolve` jobs on the pull request event by prefixing both
`if:` expressions with `github.event_name == 'pull_request_target' &&`.

Add a push-side resolution job:

```yaml
  resolve-push:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      version: ${{ steps.identity.outputs.version }}
      pr_number: ${{ steps.identity.outputs.pr_number }}
      trusted_ref: ${{ steps.identity.outputs.trusted_ref }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - id: identity
        env:
          GITHUB_TOKEN: ${{ github.token }}
          REF_NAME: ${{ github.ref_name }}
        run: |
          version=${REF_NAME#release/}
          test "$(node -p "require('./package.json').version")" = "$version"
          release_pr=$(gh pr list --head "$REF_NAME" --base main --state open --limit 1 --json number --jq '.[0].number // ""')
          test -n "$release_pr"
          git fetch --no-tags origin main
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "pr_number=$release_pr" >> "$GITHUB_OUTPUT"
          echo "trusted_ref=$(git rev-parse FETCH_HEAD)" >> "$GITHUB_OUTPUT"

  preview-push:
    needs: resolve-push
    permissions:
      contents: write
      packages: write
      pull-requests: write
      statuses: write
    uses: ./.github/workflows/build-release-candidate.yml
    with:
      ref: ${{ github.sha }}
      trusted_ref: ${{ needs.resolve-push.outputs.trusted_ref }}
      version: ${{ needs.resolve-push.outputs.version }}
      pr_number: ${{ fromJSON(needs.resolve-push.outputs.pr_number) }}
    secrets:
      CRX_PRIVATE_KEY: ${{ secrets.CRX_PRIVATE_KEY }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

The `test -n "$release_pr"` guard makes the very first push — from `cut`, before `gh pr create`
returns — fail fast rather than build with an empty pull request number. That initial build is
owned by the `candidate` job in Task 4, so this failure is expected and harmless; it is why the
initial build does not rely on this path.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-candidate.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): rebuild candidates on release branch pushes"
```

---

## Task 6: Declare the `preview` deployment branch policies

**Files:**
- Modify: `scripts/release/repository-config.mjs:113-136`
- Test: `scripts/release/repository-config.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("preview admits the branches that build candidates", () => {
  assert.deepEqual(previewBranchPolicies(), ["main", "release/*", "develop", "hotfix/*"]);
});
```

Add `previewBranchPolicies` to the existing import from `./repository-config.mjs`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm release:test`
Expected: FAIL — `previewBranchPolicies is not a function`.

- [ ] **Step 3: Implement**

In `scripts/release/repository-config.mjs`:

```javascript
// prepare-release runs on pull_request_target, so the deployment ref is the head branch name.
// develop covers the normal flow and hotfix/* the urgent one; both are same-repository only.
export function previewBranchPolicies() {
  return ["main", "release/*", "develop", "hotfix/*"];
}

async function reconcilePreviewPolicies(client) {
  const path = "/environments/preview/deployment-branch-policies";
  const current = await client.request(client.repoPath(path));
  const existing = current.branch_policies ?? [];
  for (const name of previewBranchPolicies()) {
    if (existing.some((policy) => policy.name === name)) continue;
    await client.request(client.repoPath(path), { method: "POST", body: { name, type: "branch" } });
  }
  const actual = await client.request(client.repoPath(path));
  for (const name of previewBranchPolicies()) {
    if (!(actual.branch_policies ?? []).some((policy) => policy.name === name)) {
      throw new Error(`preview is missing the ${name} deployment branch policy`);
    }
  }
}
```

Call `await reconcilePreviewPolicies(client);` from `applyRepositoryConfig` immediately before its
`return`, and include `previewBranchPolicies()` in the object returned by both
`applyRepositoryConfig` and `repositoryConfiguration` under a `previewBranchPolicies` key.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/repository-config.mjs scripts/release/repository-config.test.mjs
git commit -m "feat(release): declare preview deployment branch policies"
```

- [ ] **Step 6: Apply the policies to the live repository**

The reconciler only runs when repository configuration is applied. Add the two missing policies
directly so the retry in Task 8 is not blocked:

```bash
gh api repos/jamezrin/lurkloot/environments/preview/deployment-branch-policies \
  -X POST -f name=develop -f type=branch
gh api repos/jamezrin/lurkloot/environments/preview/deployment-branch-policies \
  -X POST -f name='hotfix/*' -f type=branch
```

Verify all four are present:

```bash
gh api repos/jamezrin/lurkloot/environments/preview/deployment-branch-policies \
  --jq '.branch_policies[].name'
```

Expected output: `main`, `release/*`, `develop`, `hotfix/*`.

---

## Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` ("Cutting a Release" section)
- Modify: `RELEASING.md`

- [ ] **Step 1: Rewrite the `CLAUDE.md` section**

Replace the "Cutting a Release" body with:

```markdown
Label a pull request into `main` with `release/patch`, `release/minor` or `release/major`. The label
validates the version and publishes a preview candidate; it does not modify the pull request. Merge
that pull request normally with a merge commit. Prepare release then cuts `release/X.Y.Z` from the
resulting merge commit, commits the version bump, and opens its own pull request into `main`.

Merge the generated release pull request with a merge commit; **Release** starts automatically,
publishes the GitHub release, GHCR aliases, Chrome Web Store submission and production site after one
approval, then merges `main` directly into `develop` with the dedicated sync App. A hotfix is the same
flow with `release/patch` on a pull request branched from `main`. Use manual **Release** dispatch only
for idempotent recovery. Do not create or move tags by hand.
```

- [ ] **Step 2: Update `RELEASING.md`**

Read `RELEASING.md` and update every passage describing the labeled pull request being closed or
superseded so it describes the merge-first order instead. Preserve the existing sections on the
`preview` and `production` environments, the single release approval, credentials, and Chrome Web
Store timing.

- [ ] **Step 3: Verify the full check suite**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md RELEASING.md
git commit -m "docs(release): describe the merge-first release flow"
```

---

## Task 8: Roll back the failed 1.6.0 attempt

Run only after Tasks 1–7 are merged to `main`.

**Current state:** `release/1.6.0` exists at `0b0bd0c`, pull request #148 is open, #146 is closed
unmerged. No `candidate-v1.6.0` prerelease and no `v1.6.0` tag were ever created, because the publish
job was rejected by the environment before it ran.

- [ ] **Step 1: Confirm nothing else needs cleaning**

```bash
gh release list --limit 10
git ls-remote --tags origin | grep 1.6.0 || echo "no 1.6.0 tags"
```

Expected: releases are `v1.5.0`, `v1.4.0`, `v1.3.0`; no `1.6.0` tags.

- [ ] **Step 2: Close the superseding pull request**

```bash
gh pr close 148 --comment "Closing the candidate produced by the old label-triggered flow. 1.6.0 will be re-cut through the merge-first flow."
```

- [ ] **Step 3: Delete the release branch**

```bash
git push origin --delete release/1.6.0
```

- [ ] **Step 4: Verify the rollback**

```bash
gh pr list --state open --base main
git ls-remote --heads origin 'refs/heads/release/*'
```

Expected: no open release pull request; only the pre-existing `release/1.4.0-stable` remains.
Leave `release/1.4.0-stable` alone — it predates this work.

---

## Task 9: Re-run the 1.6.0 release through the new flow

Manual verification. There is no automated substitute for a real release cycle.

- [ ] **Step 1: Open the pull request**

```bash
gh pr create --base main --head develop --title "Merge to main" --body ""
```

- [ ] **Step 2: Apply the label**

```bash
gh pr edit <number> --add-label release/minor
```

- [ ] **Step 3: Verify the preview candidate**

Confirm the `Prepare release` run succeeds with no rejected jobs, and that a `candidate-v1.6.0`
prerelease exists carrying exactly five assets:

```bash
gh release view candidate-v1.6.0 --json assets --jq '.assets[].name'
```

Expected: `SHA256SUMS`, `lurkloot-1.6.0-chrome.crx`, `lurkloot-1.6.0-chrome.zip`,
`lurkloot-1.6.0-firefox-sources.zip`, `lurkloot-1.6.0-firefox.zip`. No `candidate.json`.

- [ ] **Step 4: Confirm the pull request is still open**

```bash
gh pr view <number> --json state --jq .state
```

Expected: `OPEN`. This is the regression the whole change exists to prevent.

- [ ] **Step 5: Merge it with a merge commit, then verify the cut**

```bash
gh pr merge <number> --merge
```

Expected: the pull request reports `MERGED`, a `release/1.6.0` branch appears, and a
`chore(release): bump version to 1.6.0` pull request opens against `main` whose diff is only the
version bump and changelog date.

- [ ] **Step 6: Merge the release pull request and approve production**

Merge with a merge commit, approve the single `production` gate, then confirm the `v1.6.0` release,
its five assets, the GHCR aliases, the production site, and the Chrome Web Store submission.

- [ ] **Step 7: Delete the stale asset from v1.5.0**

```bash
gh release delete-asset v1.5.0 candidate.json
```

---

## Self-Review

**Spec coverage:** merge-first cut (Task 4), preview branch policies (Task 6), push-triggered
candidate build (Task 5), asset allowlist (Tasks 1–3), documentation (Task 7), migration — which the
spec left open and the user has since decided (Tasks 8–9). All covered.

**Known deviation from the spec:** the spec's `release-candidate.yml` substitution table proposed
reusing `resolve`/`preview` for both events. The plan instead adds separate `resolve-push` /
`preview-push` jobs, because a single job cannot express both `github.event.pull_request.head.sha`
and `github.sha` in one `uses:` block without unevaluated context on the inactive event.

**Type consistency:** `expectedReleaseAssets` and `assertReleaseAssets` are used with the same
signatures in Tasks 1, 2, and 3. `previewBranchPolicies` is consistent across Task 6.
