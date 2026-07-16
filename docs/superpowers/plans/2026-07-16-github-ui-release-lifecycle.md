# GitHub-UI Release Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manifest-channel release toggle with GitHub-UI candidate preparation, CWS staged review monitoring, cancellation, immutable promotion, and isolated hotfix releases.

**Architecture:** Put deterministic release/version/state decisions in tested Node modules under `scripts/release/`; keep Actions YAML as thin orchestration. A GitHub prerelease and machine-readable metadata asset are the candidate record, `vVERSION` is mutable only before CWS submission, and promotion consumes stored artifacts without rebuilding. Draft release PRs provide the human-facing state and required CWS check.

**Tech Stack:** Node.js 24 ES modules and `node:test`, pnpm 11, GitHub Actions/CLI/API, Chrome Web Store API v2, Docker Buildx, Cloudflare Wrangler.

## Global Constraints

- Normal release candidates contain all commits on `develop` at the selected cut; they never select individual commits.
- Hotfix candidates originate from a PR into `main` and must not include unreleased `develop` history.
- Candidate assets may be replaced only while CWS has no active submitted revision.
- CWS submission must use `STAGED_PUBLISH`; stable promotion must consume the already-reviewed assets and never rebuild them.
- The stable `vVERSION` tag and release are immutable; no stable workflow may force-move a tag.
- Privileged workflows must fail closed on version, provenance, checksum, warning, takedown, or CWS-state mismatch.
- Use two-space indentation, double quotes, semicolons, strict TypeScript/ES-module conventions, and pnpm commands.

---

### Task 1: Pure release lifecycle and metadata model

**Files:**
- Create: `scripts/release/model.mjs`
- Create: `scripts/release/model.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseVersion(value)`, `compareVersions(left, right)`, `assertCandidateVersion(input)`, `candidateAction(input)`, `renderCandidateMetadata(metadata)`, and `parseCandidateMetadata(json)`.
- Metadata shape: `{ schemaVersion: 1, version, kind, sourceSha, releasePr, initiator, chromeZipSha256, artifactChecksums, dockerDigests, cwsState, previewUrl }`.

- [ ] **Step 1: Write failing model tests**

```js
test("orders stable semantic versions", () => {
  assert.equal(compareVersions("1.5.0", "1.4.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("rejects candidates at or below stable and conflicting active versions", () => {
  assert.throws(() => assertCandidateVersion({ version: "1.4.0", stableVersion: "1.4.0", activeVersions: [] }), /greater/);
  assert.throws(() => assertCandidateVersion({ version: "1.5.0", stableVersion: "1.4.0", activeVersions: ["1.5.0"] }), /active/);
});

test("allows replacement only before submission", () => {
  assert.equal(candidateAction({ stable: false, submittedState: undefined }), "replace");
  assert.equal(candidateAction({ stable: false, submittedState: "PENDING_REVIEW" }), "frozen");
  assert.equal(candidateAction({ stable: false, submittedState: "STAGED" }), "frozen");
  assert.equal(candidateAction({ stable: true }), "immutable");
});

test("round trips schema-versioned candidate metadata", () => {
  const encoded = renderCandidateMetadata(fixtureMetadata);
  assert.deepEqual(parseCandidateMetadata(encoded), fixtureMetadata);
});
```

- [ ] **Step 2: Run the focused tests and confirm the missing-module failure**

Run: `node --test scripts/release/model.test.mjs`
Expected: FAIL because `scripts/release/model.mjs` does not exist.

- [ ] **Step 3: Implement the pure model and strict metadata validation**

Implement stable three-part SemVer parsing without adding a dependency. Reject unknown keys, malformed SHA-256/SHA values, unsupported schema versions, unsafe PR numbers, and invalid URLs. Make `candidateAction` return only `create`, `replace`, `frozen`, or `immutable`.

- [ ] **Step 4: Register and run release tests**

Add `scripts/release/*.test.mjs` to `release:test`, run `pnpm release:test`, and expect all release tests to pass.

- [ ] **Step 5: Commit the model**

```bash
git add package.json scripts/release/model.mjs scripts/release/model.test.mjs
git commit -m "refactor(release): add candidate lifecycle model"
```

### Task 2: Release workspace preparation and provenance CLI

**Files:**
- Create: `scripts/release/cli.mjs`
- Create: `scripts/release/cli.test.mjs`
- Modify: `scripts/release.mjs`
- Modify: `scripts/release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 model functions.
- Produces CLI commands `version`, `prepare-workspace`, `metadata create`, `metadata verify`, and `verify-hotfix`.

- [ ] **Step 1: Add failing fixture tests**

Test that `prepare-workspace 1.5.0` synchronizes all seven package manifests and creates an undated changelog entry without writing `release.channel`; `metadata verify` rejects a changed Chrome ZIP; and `verify-hotfix` accepts a branch based on `main` but rejects a candidate containing a commit unique to `develop` before the hotfix base.

- [ ] **Step 2: Run the CLI tests and verify failures**

Run: `node --test scripts/release/cli.test.mjs scripts/release.test.mjs`
Expected: FAIL for missing commands and legacy channel assumptions.

- [ ] **Step 3: Extract reusable manifest preparation**

Move manifest/changelog mutation behind exported functions, remove `release.channel` from the required declaration, and retain a compatibility `scripts/release.mjs` wrapper until docs and workflows migrate. `prepare-workspace` must accept version and optional stable date, with no dependency on the checked-out branch.

- [ ] **Step 4: Implement checksum and ancestry verification**

Use `git merge-base`, `git rev-list`, and Node crypto through argument arrays rather than shell interpolation. Emit GitHub output fields only when `GITHUB_OUTPUT` exists. Return nonzero with actionable messages on mismatches.

- [ ] **Step 5: Run release tests**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 6: Commit the CLI**

```bash
git add package.json scripts/release.mjs scripts/release.test.mjs scripts/release/cli.mjs scripts/release/cli.test.mjs
git commit -m "refactor(release): add workflow release CLI"
```

### Task 3: Complete the Chrome Web Store lifecycle client

**Files:**
- Modify: `scripts/cws.mjs`
- Modify: `scripts/cws.test.mjs`

**Interfaces:**
- Produces commands `status`, `upload-candidate`, `submit-staged`, `cancel-submission`, and `publish-stable`.
- Produces pure decisions `uploadAction`, `submitAction`, `cancelAction`, `stableAction`, and normalized status output.

- [ ] **Step 1: Write failing state-transition tests**

```js
test("submits an uploaded draft with staged publishing", () => {
  assert.equal(submitAction(status(), "1.5.0"), "submit");
});

test("cancels only an active review", () => {
  assert.equal(cancelAction(status({ submitted: revision("PENDING_REVIEW", "1.5.0") }), "1.5.0"), "cancel");
  assert.equal(cancelAction(status(), "1.5.0"), "already-cancelled");
  assert.throws(() => cancelAction(status({ submitted: revision("STAGED", "1.5.0") }), "1.5.0"), /staged/i);
});
```

Also assert the publish request uses `{ publishType: "STAGED_PUBLISH", blockOnWarnings: true }` for submission and that cancellation calls `:cancelSubmission`.

- [ ] **Step 2: Run tests and confirm failures**

Run: `pnpm cws:test`
Expected: FAIL for missing submission and cancellation behavior.

- [ ] **Step 3: Implement CWS v2 operations and polling**

Separate submit-for-review from publish-approved-staged. Poll bounded asynchronous transitions, treat retries idempotently, and fail closed on warned/taken-down/mismatched versions.

- [ ] **Step 4: Run tests**

Run: `pnpm cws:test`
Expected: PASS.

- [ ] **Step 5: Commit CWS lifecycle support**

```bash
git add scripts/cws.mjs scripts/cws.test.mjs
git commit -m "feat(release): support staged CWS lifecycle"
```

### Task 4: Candidate preparation workflow

**Files:**
- Create: `.github/workflows/prepare-prerelease.yml`
- Modify: `.github/workflows/build-extension.yml`
- Modify: `.github/workflows/build-docker.yml`
- Modify: `.github/workflows/site-deploy.yml`
- Create: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Consumes Task 2 CLI and Task 3 `upload-candidate`.
- Produces a draft release PR, `vVERSION` prerelease, `candidate.json`, release assets, Docker candidate digests, preview deployment, and a tagged PR comment.

- [ ] **Step 1: Add failing static workflow contract tests**

Parse workflow YAML as text and assert explicit `workflow_dispatch` inputs (`version`, `source_ref`, `release_kind`, `pr_number`), job-scoped permissions, `prereleases` environment, per-version concurrency, `cancel-in-progress: true`, candidate metadata upload, and absence of stable publication commands.

- [ ] **Step 2: Run the workflow test and confirm failure**

Run: `node --test scripts/release/workflows.test.mjs`
Expected: FAIL because `prepare-prerelease.yml` is absent.

- [ ] **Step 3: Parameterize reusable build workflows**

Pass explicit version/ref/artifact names instead of reading `release.channel`. Preserve unsigned PR builds. Make site deployment accept an explicit `channel` input and map prerelease to Cloudflare `next`.

- [ ] **Step 4: Implement prepare/update orchestration**

Validate inputs before privileged checkout; resolve and record a full SHA; create/update `release/VERSION` only for normal releases; locate the hotfix PR for hotfixes; build and verify before mutating the previous candidate; upload CWS before atomically replacing prerelease assets/tag; attach `candidate.json`; and add/update one marker-delimited PR comment tagging the initiator.

- [ ] **Step 5: Run workflow contracts and repository checks**

Run: `node --test scripts/release/workflows.test.mjs && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit candidate preparation**

```bash
git add .github/workflows/prepare-prerelease.yml .github/workflows/build-extension.yml .github/workflows/build-docker.yml .github/workflows/site-deploy.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): prepare candidates from GitHub UI"
```

### Task 5: Submission, cancellation, and CWS readiness monitoring

**Files:**
- Create: `.github/workflows/submit-candidate.yml`
- Create: `.github/workflows/cancel-candidate.yml`
- Create: `.github/workflows/monitor-cws.yml`
- Create: `scripts/release/github.mjs`
- Create: `scripts/release/github.test.mjs`
- Modify: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Produces `renderReleaseComment(event)`, `commentMarker(version, event)`, and `checkConclusion(cwsState)`.
- Workflows maintain required check `cws-release-ready` on the recorded candidate SHA.

- [ ] **Step 1: Write failing notification and deduplication tests**

Cover `PENDING_REVIEW`, `STAGED`, `REJECTED`, `CANCELLED`, warning, takedown, mismatch, and recovery `PUBLISHED`. Assert each transition has a stable hidden marker, tags `metadata.initiator`, and never emits a second comment for an unchanged state.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test scripts/release/github.test.mjs scripts/release/workflows.test.mjs`
Expected: FAIL for missing helper/workflows.

- [ ] **Step 3: Implement GitHub rendering and check decisions**

Keep API-independent decisions pure. Escape user-controlled text, restrict mentions to the validated initiating login, and render exact recovery actions.

- [ ] **Step 4: Implement submit and cancel workflows**

Submit verifies candidate metadata/hash/tag/PR head then calls `submit-staged`, protects candidate mutation, marks the PR ready, and posts the transition. Cancel uses `cancelSubmission`, waits for a safe state, then either returns the PR to draft or closes it and marks the prerelease abandoned.

- [ ] **Step 5: Implement scheduled and manual monitoring**

Run every 30 minutes and by dispatch. Discover only open PRs carrying workflow-owned candidate metadata, fetch CWS once under the global mutation/read concurrency policy, update the required check, add the one release-metadata commit on first `STAGED`, and post only new transition comments.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test scripts/release/github.test.mjs scripts/release/workflows.test.mjs && pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit review lifecycle workflows**

```bash
git add .github/workflows/submit-candidate.yml .github/workflows/cancel-candidate.yml .github/workflows/monitor-cws.yml scripts/release/github.mjs scripts/release/github.test.mjs scripts/release/workflows.test.mjs
git commit -m "feat(release): coordinate CWS candidate review"
```

### Task 6: Immutable stable promotion and hotfix forward merge

**Files:**
- Create: `.github/workflows/promote-release.yml`
- Create: `.github/workflows/forward-hotfix.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Consumes frozen `candidate.json`, stored GitHub assets, CWS state, and merged release PR metadata.
- Produces stable CWS publication, Docker aliases, promoted GitHub release, production site deployment, and optional `main` to `develop` sync PR.

- [ ] **Step 1: Add failing promotion contract tests**

Assert promotion triggers only for merged workflow-owned release/hotfix PRs, uses `cancel-in-progress: false`, downloads and verifies stored assets, never calls extension/Docker build workflows, checks CWS before mutation, never force-pushes `vVERSION`, and orders CWS → Docker → GitHub release → production site.

- [ ] **Step 2: Run workflow tests and confirm failure**

Run: `node --test scripts/release/workflows.test.mjs`
Expected: FAIL until the promotion workflows exist and the old push-to-main publisher is disabled.

- [ ] **Step 3: Implement idempotent promotion**

Use the protected `stable-releases` environment. Verify release PR, source SHA, tag, checksums, CWS version/state, and stable-release absence before publication. Accept matching `PUBLISHED` only for recovery. Promote existing Docker digests and GitHub assets without rebuilding.

- [ ] **Step 4: Implement hotfix synchronization PR**

After successful hotfix promotion, create or update a `chore/forward-hotfix-VERSION` branch from `develop`, merge `main` into it without resolving conflicts automatically, and open a PR to `develop`. On conflict, open an issue/comment with exact manual instructions instead of pushing a partial merge.

- [ ] **Step 5: Disable and remove legacy publication behavior**

Retain `.github/workflows/release.yml` temporarily as a manual recovery shim that cannot publish new code, or delete it once equivalent recovery is present. Remove candidate-tag creation and manifest-channel dispatch logic.

- [ ] **Step 6: Run tests and verification**

Run: `node --test scripts/release/workflows.test.mjs && pnpm verify`
Expected: PASS.

- [ ] **Step 7: Commit promotion**

```bash
git add .github/workflows/promote-release.yml .github/workflows/forward-hotfix.yml .github/workflows/release.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): promote reviewed artifacts immutably"
```

### Task 7: Documentation, configuration checklist, and migration cleanup

**Files:**
- Create: `RELEASING.md`
- Create: `CLAUDE.md` as a symbolic link to `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/releases.md`
- Modify: `AGENTS.md` if present in the repository
- Modify: `package.json`
- Modify: `scripts/release.test.mjs`
- Modify: `docs/superpowers/specs/2026-07-16-github-ui-release-lifecycle-design.md`

**Interfaces:**
- Documents the exact GitHub UI operations and repository settings that cannot be provisioned safely from repository code.

- [ ] **Step 1: Add a failing legacy-state test**

Assert root `package.json` has no `release.channel`, no workflow references `cws-v*-candidate`, and release documentation no longer instructs users to run `pnpm release:prepare` for the normal path.

- [ ] **Step 2: Run release tests and confirm failure**

Run: `pnpm release:test`
Expected: FAIL while legacy declarations remain.

- [ ] **Step 3: Rewrite release operations documentation**

Make root `RELEASING.md` the canonical runbook and include a Mermaid normal-release/hotfix diagram. Document normal candidate update/freeze/monitor/merge, cancellation/replacement, higher-version abandonment, hotfix preparation and forward merge, partial failure recovery, AMO manual steps, required environments, required checks, branch protections, labels, secrets, variables, and the one-time creation of `develop` from `main`. Link it from `README.md`, `AGENTS.md`, and a compatibility pointer at `docs/releases.md`; link `CLAUDE.md` symbolically to the canonical `AGENTS.md`.

- [ ] **Step 4: Remove legacy declaration and commands**

Remove `release.channel` and obsolete local preparation commands after all workflows use explicit inputs. Preserve package version synchronization checks where useful for stable source state.

- [ ] **Step 5: Run complete verification**

Run: `pnpm verify`
Expected: all script tests, workspace typechecks, Vitest tests, site build, and browser builds pass.

- [ ] **Step 6: Commit documentation and cleanup**

```bash
git add RELEASING.md README.md AGENTS.md CLAUDE.md docs/releases.md package.json scripts/release.test.mjs docs/superpowers/specs/2026-07-16-github-ui-release-lifecycle-design.md
git commit -m "docs(release): document GitHub UI release operations"
```

### Task 8: Final review and publication

**Files:**
- Review all files changed by Tasks 1–7.

- [ ] **Step 1: Run formatting and diff checks**

Run: `git diff --check origin/main...HEAD`
Expected: no output.

- [ ] **Step 2: Run final verification**

Run: `pnpm verify`
Expected: exit 0.

- [ ] **Step 3: Audit workflow permissions and dangerous mutations**

Run: `rg -n 'permissions:|force|cancel-in-progress|pull_request_target|workflow_run|CWS_SERVICE_ACCOUNT_JSON' .github/workflows scripts/release scripts/cws.mjs`
Expected: every privileged mutation is scoped, stable promotion contains no force move, and no untrusted fork code receives secrets.

- [ ] **Step 4: Confirm repository-setting handoff**

List the settings that require GitHub UI/API administration: create/protect `develop`, required checks, environments/reviewers, labels, and optional auto-merge. Do not change branch protection until the new checks exist on the PR.

- [ ] **Step 5: Commit any review-only corrections**

If corrections were required, stage their explicit paths after inspecting `git status --short`, then commit them as `fix(release): address lifecycle review findings`. If no corrections were required, do not create an empty commit.

- [ ] **Step 6: Push and open a draft PR**

Push `feat/github-ui-release-lifecycle` and open a draft PR to `main` with summary, test evidence, migration checklist, and `Closes #113`.
