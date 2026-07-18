# Automatic Release Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add committed release candidates with automatic previews, automatic stable publication on merge, merge-method rulesets, and protected direct `main` to `develop` synchronization.

**Architecture:** Trusted Node ESM helpers decide label, version, candidate ownership, GitHub App authentication, and repository configuration. Reusable workflows keep candidate builds credential-free until isolated signing/publishing jobs, while the stable workflow rebuilds from merged `main`, publishes behind one production approval, and synchronizes `develop` with a dedicated App token.

**Tech Stack:** GitHub Actions, Node 22/24 ESM, `node:test`, pnpm 11, WXT, Docker Buildx/GHCR, Chrome Web Store API v2, Cloudflare Pages, GitHub REST API.

**Security hardening amendment:** Candidate signing tooling is prepared in a separate job from the
trusted base ref and integrity-pinned lockfile. Generated release PRs receive required contexts on
their head SHA from trusted orchestration. Stable Docker jobs export OCI archives before approval;
all GHCR stable writes occur in the single production job and refuse to move an existing version
digest. Candidate release creation recovers only an exact-SHA orphan tag.

## Global Constraints

- Release labels are exactly `release/patch`, `release/minor`, and `release/major`.
- Stable version tags are immutable `vX.Y.Z`; mutable candidate tags are `candidate-vX.Y.Z`.
- All seven workspace manifests and the changelog must agree before artifacts are built.
- Candidate source never executes with repository write credentials or publishing secrets.
- No inline JavaScript or TypeScript is permitted in workflow YAML.
- Ordinary pull requests into `develop` squash; pull requests into `main` merge with a merge commit.
- The general GitHub Actions App never bypasses branch protection.
- `main` to `develop` synchronization uses a repository-scoped GitHub App configured only as a `develop` ruleset bypass actor.
- The shared `next.lurkloot.pages.dev` deployment represents only the most recently completed candidate.

---

### Task 1: Release policy primitives

**Files:**
- Create: `scripts/release/pipeline.mjs`
- Create: `scripts/release/pipeline.test.mjs`
- Modify: `scripts/release/cli.mjs`
- Modify: `scripts/release/cli.test.mjs`

**Interfaces:**
- Consumes: `latestVersion(tags)` and `nextVersion(current, bump)` from `scripts/release/version.mjs`.
- Produces: `selectReleaseLabel(labels)`, `candidateTag(version)`, `candidateMarker(context)`, `parseCandidateMarker(body)`, and `validatePromotion(context)`.

- [ ] **Step 1: Write failing policy tests**

  Add tests proving zero labels select no release, one label selects its bump, multiple labels throw,
  generated `release/*` heads are ignored as preparation sources, markers round-trip PR/version/head
  identity, and promotion accepts `1.6.0` after either `1.5.0` or `1.5.1` but rejects `1.5.1` after
  `1.6.0`.

  ```javascript
  test("selects exactly one recognized release label", () => {
    assert.equal(selectReleaseLabel(["docs", "release/minor"]), "release/minor");
    assert.equal(selectReleaseLabel(["docs"]), undefined);
    assert.throws(
      () => selectReleaseLabel(["release/patch", "release/minor"]),
      /exactly one release label/,
    );
  });

  test("validates a concurrent minor candidate after a patch release", () => {
    assert.deepEqual(validatePromotion({ stableVersion: "1.5.1", version: "1.6.0", label: "release/minor" }), {
      bump: "minor",
      version: "1.6.0",
    });
    assert.throws(
      () => validatePromotion({ stableVersion: "1.6.0", version: "1.5.1", label: "release/patch" }),
      /expected 1\.6\.1/,
    );
  });
  ```

- [ ] **Step 2: Run the focused tests and confirm RED**

  Run: `node --test scripts/release/pipeline.test.mjs`

  Expected: failure because `scripts/release/pipeline.mjs` does not exist.

- [ ] **Step 3: Implement the minimal policy module**

  Implement stable SemVer validation through the existing version module, hidden candidate ownership
  markers of the form `<!-- lurkloot-release-candidate:{...} -->`, and exact bump revalidation.
  Expose a CLI command:

  ```text
  node scripts/release/cli.mjs policy --labels release/minor,docs --head develop --tags "v1.5.0"
  label=release/minor
  bump=minor
  version=1.6.0
  action=prepare
  ```

- [ ] **Step 4: Run policy and release tests and confirm GREEN**

  Run: `node --test scripts/release/pipeline.test.mjs scripts/release/cli.test.mjs scripts/release/version.test.mjs`

  Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the policy boundary**

  ```bash
  git add scripts/release/pipeline.mjs scripts/release/pipeline.test.mjs scripts/release/cli.mjs scripts/release/cli.test.mjs
  git commit -m "feat(release): add candidate policy primitives"
  ```

### Task 2: Idempotent GitHub candidate reconciliation

**Files:**
- Create: `scripts/release/github.mjs`
- Create: `scripts/release/github.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Consumes: candidate marker helpers from Task 1 and `releaseNotes()` from `scripts/release/notes.mjs`.
- Produces: `GitHubClient`, `reconcilePrerelease(options)`, `retirePrerelease(options)`, and `upsertComment(options)`.

- [ ] **Step 1: Write failing reconciliation tests**

  Use a recording `fetchImpl` to prove that reconciliation creates a missing candidate tag and
  prerelease, moves only an owned prerelease tag, clobbers named assets, updates one marked comment,
  and refuses to modify a stable release or a marker owned by another PR.

- [ ] **Step 2: Run the focused test and confirm RED**

  Run: `node --test scripts/release/github.test.mjs`

  Expected: module-not-found failure for `scripts/release/github.mjs`.

- [ ] **Step 3: Implement the REST client and CLI commands**

  Add these commands without adding GitHub API logic to YAML:

  ```text
  cli.mjs publish-candidate --pr 132 --version 1.6.0 --sha abc --assets release-assets --notes notes.md
  cli.mjs candidate-comment --pr 132 --version 1.6.0 --sha abc --state ready --url URL
  cli.mjs retire-candidate --pr 132 --version 1.6.0
  ```

  The client must check live release/tag ownership before every write and use `GITHUB_TOKEN` only
  from the environment.

- [ ] **Step 4: Run candidate reconciliation tests and confirm GREEN**

  Run: `node --test scripts/release/github.test.mjs scripts/release/pipeline.test.mjs scripts/release/cli.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit GitHub reconciliation**

  ```bash
  git add scripts/release/github.mjs scripts/release/github.test.mjs scripts/release/cli.mjs
  git commit -m "feat(release): reconcile candidate releases"
  ```

### Task 3: Trusted label preparation workflow

**Files:**
- Modify: `.github/workflows/prepare-release.yml`
- Create: `scripts/release/workflows.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Consumes: `policy` CLI output from Task 1.
- Produces: a generated `release/X.Y.Z` branch and pull request carrying the selected release label,
  plus outputs `version`, `release_pr`, and `release_sha` for candidate preparation.

- [ ] **Step 1: Write failing structural workflow tests**

  Assert that preparation uses `pull_request_target` for `labeled` and `unlabeled`, checks out base
  tooling separately from candidate source, rejects forks and multiple release labels, ignores
  generated release heads, never executes candidate scripts with a write token, and calls candidate
  preparation after a successful branch push.

- [ ] **Step 2: Run the workflow test and confirm RED**

  Run: `node --test scripts/release/workflows.test.mjs`

  Expected: assertions fail against the existing label-only `pull_request` workflow.

- [ ] **Step 3: Refactor preparation around trusted tooling**

  Use two checkout directories:

  ```yaml
  - uses: actions/checkout@v7
    with:
      ref: ${{ github.event.pull_request.base.sha }}
      path: trusted
      persist-credentials: false
  - uses: actions/checkout@v7
    with:
      repository: ${{ github.event.pull_request.head.repo.full_name }}
      ref: ${{ github.event.pull_request.head.sha }}
      path: candidate
      fetch-depth: 0
      persist-credentials: false
  ```

  Execute `node ../trusted/scripts/release/cli.mjs prepare-workspace` with `candidate` as the working
  directory. Apply the recognized label to the generated release PR. On final-label removal, update
  the sticky comment to `orphaned` without deleting anything.

- [ ] **Step 4: Run workflow, policy, and CLI tests and confirm GREEN**

  Run: `node --test scripts/release/workflows.test.mjs scripts/release/pipeline.test.mjs scripts/release/cli.test.mjs`

  Expected: all tests pass.

- [ ] **Step 5: Commit trusted preparation**

  ```bash
  git add .github/workflows/prepare-release.yml scripts/release/workflows.test.mjs scripts/release/cli.mjs
  git commit -m "refactor(release): trust base tooling for preparation"
  ```

### Task 4: Candidate build and preview deployment

**Files:**
- Create: `.github/workflows/release-candidate.yml`
- Create: `.github/workflows/build-release-candidate.yml`
- Modify: `.github/workflows/build-docker.yml`
- Modify: `.github/workflows/site-deploy.yml`
- Modify: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Consumes: committed `release/X.Y.Z` ref, PR number, selected release label, and candidate helpers.
- Produces: signed extension artifact `candidate-extension-X.Y.Z`, GHCR tag
  `candidate-X.Y.Z`, GitHub prerelease `candidate-vX.Y.Z`, shared preview site, and sticky status
  comment.

- [ ] **Step 1: Extend failing structural tests**

  Assert that candidate verification and builds use read-only repository tokens; the signing job has
  no candidate checkout; Docker receives separate `workspace_version` and `image_tag` inputs;
  candidate publication never writes `latest`, `X`, `X.Y`, or `X.Y.Z`; and preview deployment uses
  the candidate SHA while retaining the shared `prerelease` channel.

- [ ] **Step 2: Run tests and confirm RED**

  Run: `node --test scripts/release/workflows.test.mjs`

  Expected: missing candidate workflows and Docker tag separation failures.

- [ ] **Step 3: Add Docker tag separation**

  Add `image_tag` as an optional reusable-workflow input. Continue using `version` only for workspace
  overlay and use `${{ inputs.image_tag || inputs.version }}` for loaded and pushed image tags.

- [ ] **Step 4: Add reusable candidate preparation**

  `build-release-candidate.yml` must run `pnpm check`, call the existing extension builder with
  `sign_crx: true`, call Docker with `image_tag: candidate-X.Y.Z`, publish the owned GitHub
  prerelease only after verification/build success, and deploy the site preview. Concurrency is per
  version except the site workflow's existing shared-channel cancellation.

- [ ] **Step 5: Add the pull-request controller**

  `release-candidate.yml` uses trusted `pull_request_target` workflow code for generated release PR
  `opened`, `reopened`, and `synchronize` events, validates same-repository ownership and one release
  label, then calls the reusable builder at the exact head SHA.

- [ ] **Step 6: Run candidate and existing release tests and confirm GREEN**

  Run: `node --test scripts/release/workflows.test.mjs scripts/release/*.test.mjs scripts/cws.test.mjs`

  Expected: all tests pass.

- [ ] **Step 7: Commit candidate previews**

  ```bash
  git add .github/workflows/release-candidate.yml .github/workflows/build-release-candidate.yml .github/workflows/build-docker.yml .github/workflows/site-deploy.yml scripts/release/workflows.test.mjs
  git commit -m "feat(release): publish release candidate previews"
  ```

### Task 5: Dedicated App authentication and branch synchronization

**Files:**
- Create: `scripts/release/github-app.mjs`
- Create: `scripts/release/github-app.test.mjs`
- Create: `scripts/release/sync.mjs`
- Create: `scripts/release/sync.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Produces: `createAppJwt(options)`, `createRepositoryToken(options)`,
  `synchronizationMode(graph)`, and CLI commands `app-token` and `sync-branches`.

- [ ] **Step 1: Write failing App authentication tests**

  Verify JWT claims (`iss`, `iat`, `exp`), repository installation lookup, one-hour token creation
  with `contents: write`, explicit failure on missing App configuration, and masked GitHub output.

- [ ] **Step 2: Write failing synchronization decision tests**

  Cover `already-contained`, `fast-forward`, `merge`, and `conflict` outcomes using temporary Git
  repositories. Assert that no remote ref changes before the supplied verification command succeeds.

- [ ] **Step 3: Run focused tests and confirm RED**

  Run: `node --test scripts/release/github-app.test.mjs scripts/release/sync.test.mjs`

  Expected: module-not-found failures.

- [ ] **Step 4: Implement short-lived App authentication**

  Sign RS256 JWTs with Node's `crypto`, resolve `/repos/{owner}/{repo}/installation`, and request an
  installation token limited to the repository and `contents: write`. Never print the private key or
  unmasked token.

- [ ] **Step 5: Implement verified synchronization**

  Fetch fresh remote refs, create a temporary local integration branch from `origin/develop`, merge
  `origin/main` with fast-forward when possible or `--no-ff` otherwise, run the exact verification
  command supplied by the stable workflow, and push the verified commit to `refs/heads/develop`.
  A merge conflict aborts and leaves the remote unchanged.

- [ ] **Step 6: Run App, sync, and CLI tests and confirm GREEN**

  Run: `node --test scripts/release/github-app.test.mjs scripts/release/sync.test.mjs scripts/release/cli.test.mjs`

  Expected: all tests pass.

- [ ] **Step 7: Commit synchronization tooling**

  ```bash
  git add scripts/release/github-app.mjs scripts/release/github-app.test.mjs scripts/release/sync.mjs scripts/release/sync.test.mjs scripts/release/cli.mjs
  git commit -m "feat(release): add protected branch synchronization"
  ```

### Task 6: Automatic stable promotion with one production gate

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/site-deploy.yml`
- Create: `.github/actions/build-site/action.yml`
- Create: `.github/actions/deploy-site/action.yml`
- Modify: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Consumes: merged release PR event or manual recovery dispatch, stable build artifacts, App token,
  and production environment credentials.
- Produces: immutable stable tag/release, stable GHCR aliases, CWS submission, production deployment,
  candidate retirement, and synchronized `develop`.

- [ ] **Step 1: Extend structural tests for stable promotion**

  Require automatic `pull_request: closed` handling for merged `release/*` heads, retain
  `workflow_dispatch`, rebuild from `main`, use one job referencing `production`, refuse tag moves,
  deploy the site within that same production job, mint the dedicated App token, and never use the
  general `GITHUB_TOKEN` for the `develop` push.

- [ ] **Step 2: Run workflow tests and confirm RED**

  Run: `node --test scripts/release/workflows.test.mjs`

  Expected: existing dispatch-only workflow fails the new assertions.

- [ ] **Step 3: Extract shared site actions**

  Move the existing install/build/checksum operations into `build-site/action.yml` and the Wrangler
  deployment into `deploy-site/action.yml`. Keep `site-deploy.yml` as the preview wrapper and reuse
  both actions from stable promotion so production approval occurs once.

- [ ] **Step 4: Add automatic merged-PR trigger and validation**

  Resolve the version from `main`, validate the merged PR's one release label against the highest
  preceding stable tag, and require the generated `release/X.Y.Z` head. Manual recovery resolves the
  matching merged release PR through the GitHub API.

- [ ] **Step 5: Publish and synchronize idempotently**

  After stable GitHub/GHCR/CWS/site publication, retire only the matching owned candidate, mint the
  App installation token from `RELEASE_SYNC_APP_ID` and `RELEASE_SYNC_APP_PRIVATE_KEY`, and run:

  ```text
  node scripts/release/cli.mjs sync-branches --remote authenticated-origin --verify "pnpm verify"
  ```

- [ ] **Step 6: Run workflow and release tests and confirm GREEN**

  Run: `node --test scripts/release/workflows.test.mjs scripts/release/*.test.mjs scripts/cws.test.mjs`

  Expected: all tests pass.

- [ ] **Step 7: Commit automatic stable promotion**

  ```bash
  git add .github/workflows/release.yml .github/workflows/site-deploy.yml .github/actions/build-site/action.yml .github/actions/deploy-site/action.yml scripts/release/workflows.test.mjs
  git commit -m "feat(release): promote merged release candidates"
  ```

### Task 7: Repository ruleset reconciler

**Files:**
- Create: `scripts/release/repository-config.mjs`
- Create: `scripts/release/repository-config.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Produces: `repositoryPatch()`, `mainRuleset()`, `developRuleset(syncAppId)`, and CLI command
  `configure-repository --sync-app-id ID [--apply]`.

- [ ] **Step 1: Write failing configuration tests**

  Assert that repository merge methods enable merge+squash and disable rebase; `main` allows only
  merge PRs; `develop` allows only squash PRs; both retain the four existing Actions status checks;
  force pushes and deletions remain blocked; only the dedicated App bypasses `develop`; and the
  GitHub Actions App ID `15368` never appears in a bypass list.

- [ ] **Step 2: Run the test and confirm RED**

  Run: `node --test scripts/release/repository-config.test.mjs`

  Expected: module-not-found failure.

- [ ] **Step 3: Implement dry-run and apply reconciliation**

  Dry-run prints canonical JSON. Apply mode updates repository merge methods, creates or updates the
  two active branch rulesets, reads them back for equality, and only then removes the conflicting
  classic `main` and `develop` protections. It refuses `--apply` without a positive numeric App ID.

- [ ] **Step 4: Run configuration tests and inspect dry-run output**

  Run:

  ```bash
  node --test scripts/release/repository-config.test.mjs
  node scripts/release/cli.mjs configure-repository --sync-app-id 12345
  ```

  Expected: tests pass; dry-run JSON contains two active rulesets and no Actions bypass.

- [ ] **Step 5: Commit the repository reconciler**

  ```bash
  git add scripts/release/repository-config.mjs scripts/release/repository-config.test.mjs scripts/release/cli.mjs
  git commit -m "feat(release): reconcile merge policy rulesets"
  ```

### Task 8: Runbook, App manifest, and full verification

**Files:**
- Create: `docs/github-apps/release-sync-manifest.json`
- Modify: `RELEASING.md`
- Modify: `AGENTS.md`
- Modify: `docs/releases.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: every workflow, command, environment, and ruleset from Tasks 1-7.
- Produces: owner setup instructions and root test coverage for all release modules.

- [ ] **Step 1: Add the private App manifest**

  Record the exact registration values:

  ```json
  {
    "name": "Lurkloot Release Sync",
    "url": "https://github.com/jamezrin/lurkloot",
    "hook_attributes": { "active": false },
    "public": false,
    "default_permissions": { "contents": "write", "metadata": "read" },
    "default_events": []
  }
  ```

- [ ] **Step 2: Rewrite the release runbook**

  Document label preparation, candidate refresh, parallel hotfix rules, merge-commit promotion,
  automatic stable publication, candidate retirement, App creation/installation, production
  environment secrets, ruleset dry-run/apply, conflict recovery, and one-time rollout order.

- [ ] **Step 3: Include every release test in root verification**

  Change `release:test` to `node --test scripts/release.test.mjs scripts/release/*.test.mjs` if needed
  and ensure the new structural/configuration tests are included.

- [ ] **Step 4: Run fresh full verification**

  Run:

  ```bash
  pnpm check
  pnpm build
  pnpm build:firefox
  git diff --check
  ```

  Expected: every command exits zero; release, CWS, workspace, extension, CLI, and site tests pass;
  both production extension builds succeed; no whitespace errors are reported.

- [ ] **Step 5: Commit documentation and verification wiring**

  ```bash
  git add docs/github-apps/release-sync-manifest.json RELEASING.md AGENTS.md docs/releases.md package.json
  git commit -m "docs(release): document automatic promotion rollout"
  ```

### Task 9: Integrate and roll out safely

**Files:**
- No source changes unless verification identifies a defect.

**Interfaces:**
- Consumes: verified implementation branch and owner-provided GitHub App ID/private key.
- Produces: `develop` containing the implementation and live repository settings ready for the next release.

- [ ] **Step 1: Merge the implementation into local `develop`**

  Fast-forward local `develop` to `ci/automate-release-promotion` and run `pnpm verify` again on the
  integrated result.

- [ ] **Step 2: Push `develop` without weakening protection**

  Push through the currently permitted reviewed path if protection rejects a direct push. Do not
  disable branch protection and do not add GitHub Actions as a bypass actor.

- [ ] **Step 3: Register and install the dedicated App**

  Use `docs/github-apps/release-sync-manifest.json`, install it only on `jamezrin/lurkloot`, generate
  one private key, and record the numeric App ID.

- [ ] **Step 4: Configure production secrets**

  Store the App ID and complete PEM as `RELEASE_SYNC_APP_ID` and
  `RELEASE_SYNC_APP_PRIVATE_KEY` on the `production` environment. Never store the private key as a
  repository secret.

- [ ] **Step 5: Dry-run and apply repository configuration**

  ```bash
  node scripts/release/cli.mjs configure-repository --sync-app-id "$RELEASE_SYNC_APP_ID"
  node scripts/release/cli.mjs configure-repository --sync-app-id "$RELEASE_SYNC_APP_ID" --apply true
  ```

  Confirm the two rulesets through the GitHub API after apply.

- [ ] **Step 6: Perform a credential-free rehearsal**

  Apply and remove a release label on a test pull request, verify policy comments and candidate
  preparation, then close the generated candidate without merging. Confirm no stable tags, stable
  GHCR aliases, CWS revisions, or production deployments changed.
