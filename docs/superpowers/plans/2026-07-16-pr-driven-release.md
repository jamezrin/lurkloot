# PR-Driven Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manually dispatched releases with an administrator-authorized, label-driven PR reconciler that prepares draft candidates, submits ready PRs to CWS, and promotes merged staged candidates.

**Architecture:** Pure JavaScript modules derive release policy and reconciliation actions from snapshots of PR, candidate, and CWS state. Thin GitHub Actions workflows gather live state, call those modules, and invoke reusable prepare, cancel, submit, monitor, and promotion phases under protected environments and concurrency locks. Candidate metadata and idempotent PR comments provide durable provenance and operator visibility.

**Tech Stack:** GitHub Actions, Node.js 24 ES modules and `node:test`, GitHub CLI/API, pnpm 11.9.0, WXT builds, CWS API tooling, Docker Buildx/GHCR, Cloudflare Pages.

## Global Constraints

- Release automation applies only to same-repository pull requests targeting `main`; fork PRs are always ineligible.
- Exactly one of `release/patch`, `release/minor`, `release/major`, or `release/hotfix` activates a release.
- Versions are calculated from the stable version on `main`; `release/hotfix` always means a patch.
- Branch names never grant release eligibility or authority.
- Only repository administrators may apply or change an activating release label.
- Authorization and protected-environment approval are bound to the current PR head SHA; a push invalidates approval.
- Candidate code must never replace trusted release tooling or execute with release credentials.
- CWS mutations remain serialized by `cws-mutation`; stable releases and tags are immutable.
- Normal operation has no manual prepare, submit, or version-entry workflow.
- Preserve strict TypeScript/ES module repository style and existing two-space indentation.

---

## File map

- Create `scripts/release/policy.mjs`: label cardinality, SemVer bumping, eligibility, authorization, and ancestry-policy model.
- Create `scripts/release/policy.test.mjs`: exhaustive policy table.
- Create `scripts/release/reconcile.mjs`: pure desired-state/action derivation.
- Create `scripts/release/reconcile.test.mjs`: event-order and lifecycle transition table.
- Modify `scripts/release/model.mjs`: candidate metadata schema v2 and compatibility rules.
- Modify `scripts/release/metadata.mjs`: build schema v2 provenance.
- Modify `scripts/release/github.mjs`: sticky status and milestone notification rendering.
- Modify `scripts/release/cli.mjs`: policy, reconcile, status-rendering, and metadata command adapters.
- Create `.github/workflows/reconcile-release-pr.yml`: trusted `pull_request_target` controller.
- Modify `.github/workflows/prepare-prerelease.yml`: reusable existing-PR preparation phase plus recovery dispatch.
- Modify `.github/workflows/cancel-candidate.yml`: reusable cancellation/retirement phase plus recovery dispatch.
- Modify `.github/workflows/submit-candidate.yml`: reusable submission phase triggered by the controller.
- Modify `.github/workflows/monitor-cws.yml`: sticky notifications and schema v2 finalization.
- Modify `.github/workflows/promote-release.yml`: metadata/policy-based merged-PR promotion.
- Modify `.github/workflows/pr-validation.yml`: fast release-policy result without trusting branch prefixes.
- Modify `.github/workflows/site-deploy.yml`, `.github/workflows/build-extension.yml`, and `.github/workflows/build-docker.yml`: explicit candidate SHA/trusted-tooling boundaries and environment-compatible artifact handoff.
- Modify `RELEASING.md`: PR-driven operator lifecycle and recovery.
- Modify `AGENTS.md`: release instructions consistent with the new lifecycle.

### Task 1: Release policy and version derivation

**Files:**
- Create: `scripts/release/policy.mjs`
- Create: `scripts/release/policy.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `RELEASE_LABELS: readonly string[]`
- Produces: `deriveVersion(stableVersion: string, label: string): string`
- Produces: `deriveReleasePolicy(input: PolicyInput): PolicyResult`
- `PolicyInput` shape: `{ baseRef, sameRepository, labels, labelActorPermission, headSha, mainSha, developSha, mainAncestor, developAncestor, leakedDevelopCommit }`
- `PolicyResult` shape: `{ state: "inactive"|"blocked"|"active", kind?: "normal"|"hotfix", label?: string, version?: string, authorizedSha?: string, reason: string }`

- [ ] **Step 1: Add failing version and policy tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveReleasePolicy, deriveVersion } from "./policy.mjs";

test("derives all release versions from stable main", () => {
  assert.equal(deriveVersion("1.4.9", "release/patch"), "1.4.10");
  assert.equal(deriveVersion("1.4.9", "release/minor"), "1.5.0");
  assert.equal(deriveVersion("1.4.9", "release/major"), "2.0.0");
  assert.equal(deriveVersion("1.4.9", "release/hotfix"), "1.4.10");
});

const normal = {
  baseRef: "main", sameRepository: true, labels: ["release/minor"],
  labelActorPermission: "admin", headSha: "a".repeat(40), mainSha: "b".repeat(40),
  developSha: "c".repeat(40), mainAncestor: true, developAncestor: true,
  leakedDevelopCommit: "", stableVersion: "1.4.9",
};

test("requires exactly one recognized label", () => {
  assert.equal(deriveReleasePolicy({ ...normal, labels: [] }).state, "inactive");
  const result = deriveReleasePolicy({ ...normal, labels: ["release/patch", "release/minor"] });
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /exactly one/);
});

test("requires admin label authorization", () => {
  const result = deriveReleasePolicy({ ...normal, labelActorPermission: "write" });
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /administrator/);
});

test("classifies normal and hotfix history", () => {
  assert.deepEqual(deriveReleasePolicy(normal), {
    state: "active", kind: "normal", label: "release/minor", version: "1.5.0",
    authorizedSha: normal.headSha, reason: "normal release candidate",
  });
  const hotfix = deriveReleasePolicy({
    ...normal, labels: ["release/hotfix"], developAncestor: false,
  });
  assert.equal(hotfix.kind, "hotfix");
  assert.equal(hotfix.version, "1.4.10");
});

test("rejects forks, non-main bases, invalid ancestry, and develop leakage", () => {
  for (const input of [
    { ...normal, sameRepository: false },
    { ...normal, baseRef: "develop" },
    { ...normal, developAncestor: false },
    { ...normal, labels: ["release/hotfix"], mainAncestor: false },
    { ...normal, labels: ["release/hotfix"], leakedDevelopCommit: "d".repeat(40) },
  ]) assert.equal(deriveReleasePolicy(input).state, "blocked");
});
```

- [ ] **Step 2: Run the policy test and confirm the missing-module failure**

Run: `node --test scripts/release/policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `policy.mjs`.

- [ ] **Step 3: Implement the pure policy module**

```js
import { parseVersion } from "./model.mjs";

export const RELEASE_LABELS = Object.freeze([
  "release/patch", "release/minor", "release/major", "release/hotfix",
]);

export function deriveVersion(stableVersion, label) {
  const [major, minor, patch] = parseVersion(stableVersion);
  if (label === "release/major") return `${major + 1}.0.0`;
  if (label === "release/minor") return `${major}.${minor + 1}.0`;
  if (label === "release/patch" || label === "release/hotfix") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported release label ${label}`);
}

export function deriveReleasePolicy(input) {
  const selected = input.labels.filter((label) => RELEASE_LABELS.includes(label));
  if (selected.length === 0) return { state: "inactive", reason: "no release label" };
  const blocked = (reason) => ({ state: "blocked", reason });
  if (selected.length !== 1) return blocked("exactly one release label is required");
  if (input.baseRef !== "main" || !input.sameRepository) return blocked("release PR must be a same-repository PR to main");
  if (input.labelActorPermission !== "admin") return blocked("release label must be authorized by a repository administrator");
  const label = selected[0];
  const kind = label === "release/hotfix" ? "hotfix" : "normal";
  if (!input.mainAncestor) return blocked(`${kind} candidate must descend from main`);
  if (kind === "normal" && !input.developAncestor) return blocked("normal candidate must derive from develop");
  if (kind === "hotfix" && input.leakedDevelopCommit) return blocked(`hotfix contains unreleased develop commit ${input.leakedDevelopCommit}`);
  return {
    state: "active", kind, label, version: deriveVersion(input.stableVersion, label),
    authorizedSha: input.headSha, reason: `${kind} release candidate`,
  };
}
```

- [ ] **Step 4: Add policy tests to the release test command and run them**

Change `release:test` to `node --test scripts/release.test.mjs scripts/release/*.test.mjs`; the glob already includes the new test, so verify no explicit list is introduced.

Run: `pnpm release:test`

Expected: all release tests PASS.

- [ ] **Step 5: Commit the policy model**

```bash
git add scripts/release/policy.mjs scripts/release/policy.test.mjs package.json
git commit -m "feat(release): derive PR release policy"
```

### Task 2: Reconciliation state machine

**Files:**
- Create: `scripts/release/reconcile.mjs`
- Create: `scripts/release/reconcile.test.mjs`

**Interfaces:**
- Consumes: `PolicyResult` from Task 1.
- Produces: `deriveReconciliation(input): ReconciliationResult`
- Input shape: `{ policy, draft, merged, closed, headSha, candidate?: { version, label, sourceSha, state }, cwsState }`
- Result shape: `{ action: "none"|"prepare"|"submit"|"cancel"|"cancel-and-prepare"|"retire"|"promote"|"block", convertToDraft: boolean, reason: string }`

- [ ] **Step 1: Write a table-driven failing state-machine test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveReconciliation } from "./reconcile.mjs";

const active = { state: "active", kind: "normal", label: "release/minor", version: "1.5.0", authorizedSha: "a".repeat(40) };
const candidate = { version: "1.5.0", label: "release/minor", sourceSha: "a".repeat(40), state: "DRAFT" };

const cases = [
  ["inactive untouched PR", { policy: { state: "inactive" }, draft: true }, "none"],
  ["new draft", { policy: active, draft: true }, "prepare"],
  ["matching mutable draft", { policy: active, draft: true, candidate }, "none"],
  ["changed mutable head", { policy: { ...active, authorizedSha: "b".repeat(40) }, draft: true, candidate }, "prepare"],
  ["ready candidate", { policy: active, draft: false, candidate }, "submit"],
  ["remove label", { policy: { state: "inactive" }, draft: true, candidate }, "retire"],
  ["replace frozen label", { policy: { ...active, label: "release/major", version: "2.0.0" }, draft: false, candidate: { ...candidate, state: "PENDING_REVIEW" } }, "cancel-and-prepare"],
  ["close submitted", { policy: active, closed: true, candidate: { ...candidate, state: "PENDING_REVIEW" } }, "cancel"],
  ["merge staged", { policy: active, merged: true, candidate: { ...candidate, state: "STAGED" } }, "promote"],
  ["merge without candidate", { policy: { state: "inactive" }, merged: true }, "none"],
  ["policy block", { policy: { state: "blocked", reason: "bad labels" }, draft: true, candidate }, "retire"],
];

for (const [name, input, action] of cases) test(name, () => {
  assert.equal(deriveReconciliation({ closed: false, merged: false, candidate: undefined, cwsState: "none", ...input }).action, action);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test scripts/release/reconcile.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement ordered, side-effect-free reconciliation rules**

```js
const frozen = new Set(["PENDING_REVIEW", "STAGED"]);

export function deriveReconciliation(input) {
  const result = (action, reason, convertToDraft = false) => ({ action, reason, convertToDraft });
  const candidate = input.candidate;
  if (input.merged) {
    if (input.policy.state === "active" && candidate?.state === "STAGED") return result("promote", "staged candidate merged");
    return result("none", "merged PR has no matching staged release");
  }
  if (input.closed) return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", "release PR closed")
    : result("none", "closed PR has no candidate");
  if (input.policy.state !== "active") return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", input.policy.reason, frozen.has(candidate.state))
    : result(input.policy.state === "blocked" ? "block" : "none", input.policy.reason);
  const matches = candidate
    && candidate.version === input.policy.version
    && candidate.label === input.policy.label
    && candidate.sourceSha === input.policy.authorizedSha;
  if (!candidate) return result("prepare", "active PR has no candidate");
  if (!matches) return frozen.has(candidate.state)
    ? result("cancel-and-prepare", "frozen candidate differs from desired candidate", true)
    : result("prepare", "mutable candidate differs from desired candidate");
  if (input.draft) return result("none", "mutable candidate is current");
  if (candidate.state === "DRAFT") return result("submit", "ready PR has a current mutable candidate");
  return result("none", "submitted candidate is current");
}
```

- [ ] **Step 4: Add cases for duplicate events, unexpected published state, and blocked cancellation**

Add assertions that repeated matching events return `none`, `PUBLISHED` never returns `prepare`, and an input `cwsState: "VERSION_MISMATCH"` returns `block`. Update the implementation before its normal rules with:

```js
if (["VERSION_MISMATCH", "POLICY_BLOCKED"].includes(input.cwsState)) {
  return result("block", `CWS reconciliation blocked by ${input.cwsState}`);
}
if (candidate?.state === "PUBLISHED" && !input.merged) {
  return result("block", "published candidate cannot be mutated");
}
```

Run: `pnpm release:test`

Expected: all release tests PASS.

- [ ] **Step 5: Commit the state machine**

```bash
git add scripts/release/reconcile.mjs scripts/release/reconcile.test.mjs
git commit -m "feat(release): model PR reconciliation"
```

### Task 3: Candidate metadata v2 provenance

**Files:**
- Modify: `scripts/release/model.mjs`
- Modify: `scripts/release/model.test.mjs`
- Modify: `scripts/release/metadata.mjs`
- Modify: `scripts/release/metadata.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Extends candidate metadata with `stableVersion`, `stableSha`, `developSha`, `label`, `authorizedBy`, `authorizedSha`, `trustedToolsSha`, `createdAt`, and `reconciledAt`.
- `developSha` is a SHA for normal releases and `null` for hotfixes.
- Stable promotion accepts schema v2 only after migration; read-only cancellation may parse schema v1 for recovery.

- [ ] **Step 1: Replace the metadata fixture with an exact schema v2 fixture and failing validation tests**

```js
const provenance = {
  schemaVersion: 2,
  version: "1.5.0", kind: "normal", label: "release/minor",
  stableVersion: "1.4.0", stableSha: "1".repeat(40), developSha: "2".repeat(40),
  sourceSha: "3".repeat(40), authorizedSha: "3".repeat(40),
  releasePr: 42, initiator: "jamezrin", authorizedBy: "release-admin",
  trustedToolsSha: "4".repeat(40), createdAt: "2026-07-16T18:00:00.000Z",
  reconciledAt: "2026-07-16T18:00:00.000Z",
};
```

Assert schema v2 round-trips, hotfix `developSha: null` passes, mismatched `sourceSha`/`authorizedSha` fails, an incorrect label-kind pair fails, and an unknown field fails.

- [ ] **Step 2: Run metadata/model tests and confirm schema failures**

Run: `node --test scripts/release/model.test.mjs scripts/release/metadata.test.mjs`

Expected: FAIL because schema version 2 and provenance fields are unsupported.

- [ ] **Step 3: Implement exact schema v2 validation and construction**

Update `metadataFields`, require `schemaVersion === 2`, validate timestamps with `Number.isNaN(Date.parse(value)) === false`, enforce normal/hotfix label pairs, and require `sourceSha === authorizedSha` at candidate creation. Extend `buildCandidateMetadata(input)` and `createMetadata()` to consume environment variables:

```js
stableVersion: required("STABLE_VERSION"),
stableSha: required("STABLE_SHA"),
developSha: process.env.DEVELOP_SHA || null,
label: required("RELEASE_LABEL"),
authorizedBy: required("AUTHORIZED_BY"),
authorizedSha: required("AUTHORIZED_SHA"),
trustedToolsSha: required("TRUSTED_TOOLS_SHA"),
createdAt: required("CREATED_AT"),
reconciledAt: required("RECONCILED_AT"),
```

Keep a `parseLegacyCandidateMetadata` recovery-only function that validates schema v1 but never returns data accepted by prepare, submit, or promote.

- [ ] **Step 4: Run release tests**

Run: `pnpm release:test`

Expected: all release tests PASS.

- [ ] **Step 5: Commit metadata provenance**

```bash
git add scripts/release/model.mjs scripts/release/model.test.mjs scripts/release/metadata.mjs scripts/release/metadata.test.mjs scripts/release/cli.mjs
git commit -m "feat(release): record candidate authorization"
```

### Task 4: PR status and milestone notifications

**Files:**
- Modify: `scripts/release/github.mjs`
- Modify: `scripts/release/github.test.mjs`
- Modify: `scripts/release/cli.mjs`

**Interfaces:**
- Produces: `statusMarker(pr: number): string`
- Produces: `renderReleaseStatus(status): string`
- Produces: `milestoneMarker(version: string, milestone: string): string`
- Produces: `renderMilestone({ metadata, milestone, guidance }): string`
- CLI command: `render-status --input STATUS_JSON --output FILE`

- [ ] **Step 1: Write failing exact-output notification tests**

```js
test("renders one sticky actionable status", () => {
  assert.equal(renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "normal", state: "awaiting-approval",
    sourceSha: "a".repeat(40), action: "Approve the prereleases environment for this SHA.",
    releaseUrl: "https://github.test/releases/v1.5.0", previewUrl: "https://next.test",
    cwsUrl: "https://cws.test", checksum: "b".repeat(64), dockerTag: "ghcr.io/test/lurkloot-cli:next",
  }), `<!-- lurkloot-release-pr:42:status -->
## Release status: awaiting approval

- Candidate: \`v1.5.0\` (normal)
- Source: \`${"a".repeat(40)}\`
- Chrome ZIP: \`${"b".repeat(64)}\`
- Docker: \`ghcr.io/test/lurkloot-cli:next\`
- Links: [GitHub release](https://github.test/releases/v1.5.0) · [Preview](https://next.test) · [CWS](https://cws.test)

**Next action:** Approve the prereleases environment for this SHA.`);
});

test("milestone marker deduplicates by version and state", () => {
  assert.equal(milestoneMarker("1.5.0", "cws-staged"), "<!-- lurkloot-release:1.5.0:milestone:cws-staged -->");
});
```

- [ ] **Step 2: Run notification tests and confirm missing exports**

Run: `node --test scripts/release/github.test.mjs`

Expected: FAIL because the new renderers are not exported.

- [ ] **Step 3: Implement pure renderers and CLI file output**

Implement exact rendering with URL validation, login validation for mentions, and optional fields omitted rather than rendered as `undefined`. `render-status` reads JSON, calls the renderer, and writes the supplied output path. Keep current CWS-state renderers as wrappers until workflows migrate.

- [ ] **Step 4: Add blocked, cancelled, staged, and stable snapshots and run tests**

Run: `pnpm release:test`

Expected: all release tests PASS; each milestone contains one stable marker and mentions only a validated GitHub login.

- [ ] **Step 5: Commit notification rendering**

```bash
git add scripts/release/github.mjs scripts/release/github.test.mjs scripts/release/cli.mjs
git commit -m "feat(release): render PR lifecycle notifications"
```

### Task 5: Controller CLI adapter and live-state contract

**Files:**
- Modify: `scripts/release/cli.mjs`
- Create: `scripts/release/cli.test.mjs`
- Create: `scripts/release/fixtures/policy-active.json`
- Create: `scripts/release/fixtures/reconcile-prepare.json`

**Interfaces:**
- CLI `policy --input INPUT_JSON` emits `state`, `kind`, `label`, `version`, `authorized_sha`, and `reason` to `$GITHUB_OUTPUT`.
- CLI `reconcile --input INPUT_JSON` emits `action`, `convert_to_draft`, and `reason`.
- CLI `metadata read` emits every controller-relevant schema v2 field.

- [ ] **Step 1: Write CLI subprocess tests using temporary `$GITHUB_OUTPUT` files**

```js
test("policy command emits workflow outputs", async () => {
  const output = await runCli(["policy", "--input", fixture("policy-active.json")]);
  assert.match(output, /^state=active$/m);
  assert.match(output, /^version=1\.5\.0$/m);
  assert.match(output, /^authorized_sha=[0-9a-f]{40}$/m);
});

test("reconcile command emits prepare", async () => {
  const output = await runCli(["reconcile", "--input", fixture("reconcile-prepare.json")]);
  assert.match(output, /^action=prepare$/m);
  assert.match(output, /^convert_to_draft=false$/m);
});
```

Use `spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, GITHUB_OUTPUT: outputPath } })` and assert exit code and output-file contents.

- [ ] **Step 2: Run CLI tests and confirm unknown-command failures**

Run: `node --test scripts/release/cli.test.mjs`

Expected: FAIL with CLI usage errors for `policy` and `reconcile`.

- [ ] **Step 3: Add commands that delegate only to the pure modules**

```js
"policy": {
  usage: "policy --input INPUT_JSON",
  options: { input: { type: "string" } }, requires: ["input"],
  run: async ({ values }) => emitOutputs(deriveReleasePolicy(JSON.parse(await readFile(values.input, "utf8")))),
},
"reconcile": {
  usage: "reconcile --input INPUT_JSON",
  options: { input: { type: "string" } }, requires: ["input"],
  run: async ({ values }) => emitOutputs(deriveReconciliation(JSON.parse(await readFile(values.input, "utf8")))),
},
```

Normalize missing optional outputs to empty strings in `emitOutputs`; reject line breaks in output values to prevent workflow-command injection.

- [ ] **Step 4: Run CLI and all release tests**

Run: `pnpm release:test`

Expected: all release tests PASS.

- [ ] **Step 5: Commit the controller contract**

```bash
git add scripts/release/cli.mjs scripts/release/cli.test.mjs scripts/release/fixtures
git commit -m "feat(release): expose reconciliation CLI"
```

### Task 6: Trusted PR controller and policy check

**Files:**
- Create: `.github/workflows/reconcile-release-pr.yml`
- Modify: `.github/workflows/pr-validation.yml`

**Interfaces:**
- Consumes Task 5 CLI outputs.
- Calls reusable workflows with `pr_number`, `expected_head_sha`, `version`, `kind`, `release_label`, `authorized_by`, `stable_sha`, `develop_sha`, and `trusted_tools_ref`.

- [ ] **Step 1: Add a failing static workflow contract test**

Create `scripts/release/workflows.test.mjs` that loads workflow text and asserts:

```js
test("controller uses trusted pull_request_target events", async () => {
  const workflow = await readFile(".github/workflows/reconcile-release-pr.yml", "utf8");
  assert.match(workflow, /pull_request_target:/);
  for (const type of ["opened", "reopened", "synchronize", "labeled", "unlabeled", "converted_to_draft", "ready_for_review", "closed"]) {
    assert.match(workflow, new RegExp(`\\b${type}\\b`));
  }
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(workflow, /actions\/checkout[^\n]*\n(?:.*\n){0,5}.*ref:.*head\.sha/);
});
```

Also assert top-level `permissions: contents: read`, explicit per-job permissions, and a PR-number concurrency group.

- [ ] **Step 2: Run the workflow test and confirm the missing-file failure**

Run: `node --test scripts/release/workflows.test.mjs`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Create the controller's inspect job**

The workflow must:

```yaml
on:
  pull_request_target:
    branches: [main]
    types: [opened, reopened, synchronize, labeled, unlabeled, converted_to_draft, ready_for_review, closed]

permissions:
  contents: read

concurrency:
  group: release-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

Checkout `github.event.pull_request.base.sha`, fetch `main`, `develop`, and `pull/NUMBER/head` without persisting credentials, query live PR labels/head/draft/merged state with `gh api`, query the label event actor's collaborator permission, calculate ancestry files, download associated candidate metadata when present, and write `policy.json` and `reconcile.json`. Run the Task 5 commands and expose all outputs.

For non-label events, recover `authorizedBy`, label, and authorized SHA from schema v2 metadata. A changed SHA remains active for credential-free checks but must enter `awaiting-approval`; do not claim the prior SHA is authorized.

- [ ] **Step 4: Add thin conditional phase jobs and sticky blocker reporting**

Declare static reusable-workflow jobs with `if:` conditions for `prepare`, `cancel`, `submit`, and `promote`. Make `cancel-and-prepare` wait for successful cancellation before preparation. Add a final `notify` job with `if: always()` that upserts the sticky marker using `gh api`, and posts a milestone only when its marker is absent.

Do not put secrets in the inspect job. Do not use PR-head versions of scripts. Ensure unauthorized/multi-label policy results call no mutation workflow.

- [ ] **Step 5: Run release tests and actionlint**

Run: `pnpm release:test`

Expected: all tests PASS.

Run: `pnpm dlx actionlint@1.7.7`

Expected: exit 0 with no workflow diagnostics.

- [ ] **Step 6: Commit the controller**

```bash
git add .github/workflows/reconcile-release-pr.yml .github/workflows/pr-validation.yml scripts/release/workflows.test.mjs
git commit -m "feat(release): reconcile release PR events"
```

### Task 7: Reusable candidate preparation with credential isolation

**Files:**
- Modify: `.github/workflows/prepare-prerelease.yml`
- Modify: `.github/workflows/build-extension.yml`
- Modify: `.github/workflows/build-docker.yml`
- Modify: `.github/workflows/site-deploy.yml`

**Interfaces:**
- `prepare-prerelease.yml` exposes `workflow_call` with the controller inputs from Task 6.
- Produces `candidate_sha`, `release_url`, `preview_url`, `chrome_zip_sha256`, and `docker_tag`.
- Recovery `workflow_dispatch` accepts only `pr_number`; version and kind are derived.

- [ ] **Step 1: Extend workflow contract tests before editing YAML**

Assert that prepare has `workflow_call`, has no dispatch inputs named `version`, `source_ref`, `release_kind`, or `pr_number` except a single recovery PR number, never runs `gh pr create`, validates live head/label before and after builds, and passes immutable `trusted_tools_ref` into extension/Docker builders.

Assert candidate-code build jobs have no `contents: write`, `packages: write`, Cloudflare token, CWS secret, or CRX key. Assert credentialed signing/upload/deploy jobs have protected environments and consume checksummed artifacts rather than checking out the PR head.

- [ ] **Step 2: Run workflow tests and confirm current dispatch/create-PR assertions fail**

Run: `node --test scripts/release/workflows.test.mjs`

Expected: FAIL on current manual inputs and `gh pr create` behavior.

- [ ] **Step 3: Refactor prepare to operate on an existing PR and exact SHA**

Add typed `workflow_call` inputs, retain a PR-only recovery dispatch, and replace branch creation logic with:

```bash
live=$(gh pr view "$PR" --json state,isDraft,baseRefName,headRefOid,labels,isCrossRepository)
test "$(jq -r .state <<<"$live")" = OPEN
test "$(jq -r .baseRefName <<<"$live")" = main
test "$(jq -r .headRefOid <<<"$live")" = "$EXPECTED_HEAD_SHA"
test "$(jq -r .isCrossRepository <<<"$live")" = false
```

Build from `EXPECTED_HEAD_SHA`, overlay the derived version only in build workspaces, generate schema v2 metadata, update the candidate tag/release only after all artifacts verify, and never create or rename the PR branch.

- [ ] **Step 4: Split privileged publication from candidate-controlled builds**

Keep install/check/site/unsigned extension/Docker build contexts credential-free. Make signed packaging use prebuilt verified extension output so package scripts do not run with `CRX_PRIVATE_KEY`. Push Docker digests only in an environment-approved job whose build input is a verified OCI artifact, not a live PR checkout. Deploy the already-built static site artifact from a separate `prerelease-site` job.

Immediately before each external mutation, query live PR head and labels and exit stale without mutation if they differ from the inputs.

- [ ] **Step 5: Verify workflows and repository builds**

Run: `pnpm release:test && pnpm check`

Expected: all tests, workspace typechecks, extension tests, and site build PASS.

Run: `pnpm dlx actionlint@1.7.7`

Expected: exit 0.

- [ ] **Step 6: Commit reusable preparation**

```bash
git add .github/workflows/prepare-prerelease.yml .github/workflows/build-extension.yml .github/workflows/build-docker.yml .github/workflows/site-deploy.yml scripts/release/workflows.test.mjs
git commit -m "refactor(release): prepare candidates from PRs"
```

### Task 8: Automatic cancellation and ready-for-review submission

**Files:**
- Modify: `.github/workflows/cancel-candidate.yml`
- Modify: `.github/workflows/submit-candidate.yml`
- Modify: `scripts/release/github.mjs`
- Modify: `scripts/release/github.test.mjs`

**Interfaces:**
- Cancel call inputs: `pr_number`, `candidate_version`, `expected_candidate_sha`, `disposition` (`retire` or `replace`).
- Cancel outputs: `cancelled`, `safe_to_replace`, `reason`.
- Submit call inputs: `pr_number`, `version`, `expected_head_sha`, `trusted_tools_ref`.

- [ ] **Step 1: Add workflow and notification tests for automatic lifecycle behavior**

Assert cancel exposes `workflow_call`, automatically converts a submitted PR to draft, confirms CWS cancellation by reading status, and returns `safe_to_replace=false` for mismatched/published/unknown states. Assert submit exposes `workflow_call`, has `environment: cws-review`, does not call `gh pr ready`, and verifies live head plus candidate metadata before CWS mutation.

Add milestone snapshot tests for `candidate-rebuilding`, `environment-approval`, `cws-pending`, and `reconciliation-blocked`.

- [ ] **Step 2: Run targeted tests and confirm failures**

Run: `node --test scripts/release/workflows.test.mjs scripts/release/github.test.mjs`

Expected: FAIL against the dispatch-only workflows.

- [ ] **Step 3: Refactor cancellation into an idempotent reusable phase**

Validate exact candidate ownership, acquire `cws-mutation`, read CWS state, cancel only the recorded submitted version, read back a terminal cancelled/no-submission state, then convert the PR to draft with `gh pr ready "$PR" --undo`. Mark the old prerelease cancelled for both retirement and replacement; retain tag/assets as audit evidence. Delete Docker aliases only when uniquely attributable.

Set `safe_to_replace=true` only after cancellation confirmation. For `PUBLISHED`, version mismatch, policy block, or API uncertainty, return false, fail the candidate check, and render recovery guidance without preparing anything.

- [ ] **Step 4: Refactor submission into a ready-triggered reusable phase**

Remove the normal dispatch. Rebuild the unsigned Chrome ZIP, verify schema v2 provenance and checksum, require current PR `isDraft == false`, exact head SHA, exact label, and current GitHub prerelease/tag. Pause at `cws-review`, revalidate after approval, call `submit-staged`, and update the sticky status plus `cws-pending` milestone.

- [ ] **Step 5: Run release tests and actionlint**

Run: `pnpm release:test && pnpm dlx actionlint@1.7.7`

Expected: all tests PASS and actionlint exits 0.

- [ ] **Step 6: Commit automatic cancel/submit phases**

```bash
git add .github/workflows/cancel-candidate.yml .github/workflows/submit-candidate.yml scripts/release/github.mjs scripts/release/github.test.mjs scripts/release/workflows.test.mjs
git commit -m "feat(release): automate CWS candidate transitions"
```

### Task 9: CWS monitor and stable promotion hardening

**Files:**
- Modify: `.github/workflows/monitor-cws.yml`
- Modify: `.github/workflows/promote-release.yml`
- Modify: `.github/workflows/forward-hotfix.yml`
- Modify: `scripts/release/cli.mjs`
- Modify: `scripts/release/monitor.test.mjs`
- Modify: `scripts/release/workflows.test.mjs`

**Interfaces:**
- Monitor consumes schema v2 candidate metadata and current PR status.
- Promotion is selected by matching metadata/checks, never `startsWith(head.ref, ...)`.
- Recovery promotion accepts only `pr_number` and derives the exact version.

- [ ] **Step 1: Add failing promotion and monitor contract tests**

Assert promotion contains no `startsWith(...release/)` or `startsWith(...hotfix/)`, verifies `label`, `authorizedSha`, `releasePr`, source/tag/checksums, metadata-only finalization, and CWS state, and ignores an unlabeled/never-authorized merged PR. Assert monitor uses sticky/milestone renderers and does not tell users to run Prepare/Submit dispatches.

- [ ] **Step 2: Run tests and confirm branch-prefix/old-guidance failures**

Run: `node --test scripts/release/monitor.test.mjs scripts/release/workflows.test.mjs`

Expected: FAIL on current branch-prefix promotion and dispatch guidance.

- [ ] **Step 3: Update monitoring and finalization**

Before finalizing metadata, verify current head is the frozen source SHA, PR label matches schema v2, and PR is ready. Push only `chore(release): finalize VERSION metadata`, then record head evidence without changing `sourceSha`. Upsert sticky status and post one `cws-staged` milestone. If the PR changed, report `CANDIDATE_CHANGED` so the controller cancels rather than finalizing.

- [ ] **Step 4: Harden merged-PR promotion**

Replace branch-prefix gating with a candidate lookup by merged PR number. Verify the merged PR still has exactly the recorded label, all candidate provenance, the permitted metadata-only commit, successful required checks, and `STAGED`. Keep CWS publish first, stored-digest Docker alias promotion, immutable GitHub release promotion, production site deployment, and forward merge.

Retain an idempotent recovery dispatch that accepts only PR number. A PR with no matching schema v2 staged candidate exits successfully with a summary saying no release action was performed.

- [ ] **Step 5: Run complete release and workflow validation**

Run: `pnpm release:test && pnpm dlx actionlint@1.7.7`

Expected: all tests PASS and no actionlint diagnostics.

- [ ] **Step 6: Commit monitor and promotion changes**

```bash
git add .github/workflows/monitor-cws.yml .github/workflows/promote-release.yml .github/workflows/forward-hotfix.yml scripts/release/cli.mjs scripts/release/monitor.test.mjs scripts/release/workflows.test.mjs
git commit -m "refactor(release): promote authorized PR candidates"
```

### Task 10: Documentation, migration checks, and full verification

**Files:**
- Modify: `RELEASING.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-16-pr-driven-release-design.md` only if implementation uncovered an approved design correction.

**Interfaces:**
- Documents exact label, draft, ready, merge, cancellation, recovery, environment, and repository-rules configuration.

- [ ] **Step 1: Replace the dispatch-driven release instructions**

Document this operator path exactly:

```text
1. Create a branch from develop (normal) or main (hotfix) and open a draft PR to main.
2. Have an administrator apply exactly one release label.
3. Approve the protected candidate environments for the displayed head SHA.
4. Inspect the mutable GitHub prerelease, next site, CWS draft, and Docker candidate.
5. Mark the PR ready; approve cws-review when requested.
6. Wait for the bot's CWS STAGED notification and passing cws-release-ready check.
7. Merge; approve stable environments and verify promotion plus main-to-develop synchronization.
```

Describe automatic reconciliation for pushes and label changes, why approvals reset on SHA changes, unauthorized-label behavior, and the PR-number-only recovery commands.

- [ ] **Step 2: Document required GitHub configuration**

List required labels, required checks, environment reviewers, prevent-self-review settings, SHA approval invalidation, secrets/variables, main/develop protection, and the absence of branch-name trust. State that old prepare/submit dispatches are disabled after migration.

- [ ] **Step 3: Run placeholder and stale-guidance scans**

Run:

```bash
rg -n "Actions → Prepare|Run Submit candidate|source_ref|release_kind|startsWith.*(release|hotfix)" RELEASING.md AGENTS.md .github/workflows scripts/release
```

Expected: no stale operator instructions, branch-prefix authorization, or placeholders; recovery-only matches are explicitly documented and reviewed.

- [ ] **Step 4: Run full repository verification**

Run: `pnpm verify`

Expected: CWS tests, release tests, all workspace typechecks, extension tests, site build, Chromium build, and Firefox build PASS.

Run: `pnpm dlx actionlint@1.7.7`

Expected: exit 0 with no diagnostics.

- [ ] **Step 5: Review the final diff for security boundaries**

Run:

```bash
git diff origin/develop...HEAD -- .github/workflows scripts/release RELEASING.md AGENTS.md
```

Confirm that no PR-head script runs with secrets, no arbitrary version input remains, every external mutation revalidates live SHA/labels after its lock or approval, and merged unlabeled PRs are inert.

- [ ] **Step 6: Commit documentation and verification updates**

```bash
git add RELEASING.md AGENTS.md
git commit -m "docs(release): document PR-driven releases"
```

- [ ] **Step 7: Prepare repository configuration checklist for the PR**

Include in the PR body:

```markdown
## Repository configuration

- [ ] Create `release/patch`, `release/minor`, `release/major`, and `release/hotfix` labels.
- [ ] Require `release-policy`, `release-candidate`, `cws-release-ready`, and normal validation on `main` release PRs.
- [ ] Restrict protected-environment reviewers to repository administrators/release managers.
- [ ] Enable prevent-self-review and candidate-SHA approval invalidation.
- [ ] Confirm `prereleases`, `cws-review`, `prerelease-site`, `stable-releases`, and `production-site` secrets and variables.
- [ ] Complete or cancel every active legacy candidate before enabling the controller.
- [ ] Synchronize the automation commit to both `main` and `develop`.
```
