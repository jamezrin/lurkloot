# Simplified Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PR-driven release controller (~7,500 lines, 12 workflows) with a dispatch-triggered, idempotent release pipeline (~600 lines, 6 workflows) driven entirely from the GitHub UI that publishes to the Chrome Web Store without human follow-up.

**Architecture:** Two dispatchable workflows — *Prepare release* opens a version-bump PR into `main`; *Release* tags `main`, builds every artifact, and publishes to GitHub, GHCR, the Chrome Web Store and Cloudflare. Every step is idempotent and re-runnable, so partial failures are fixed by re-running rather than by rollback. No candidate record, no frozen SHA, no synthetic status check, no polling.

**Tech Stack:** GitHub Actions (`workflow_dispatch`, reusable workflows, environments), Node 22 ESM under `scripts/`, `node --test`, WXT, Docker Buildx/GHCR, Chrome Web Store API v2, Cloudflare Pages.

---

## Spec

### Why

The current controller models a distributed transaction across five systems that share no commit protocol (git tags, GitHub releases, GHCR, CWS, Cloudflare). Because that cannot be atomic, it compensates with staging releases, `backup.json`, rollback, ownership assertions and cross-field invariants. Shipping 1.5.0 required fixing **13 latent bugs**, every one in code that had never executed, and the stable-promotion stage still had to be completed by hand.

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | `workflow_dispatch` from the Actions tab | Pure GitHub UI. A UI-created Release would create the tag anyway, fire `published` before assets exist, and make the release an input instead of an output. |
| CWS publishing | `PUBLISH_IMMEDIATELY` | Google publishes on approval. Deletes the poller, the `cws-release-ready` check, the submit/promote split and the `PENDING_REVIEW` state machine. |
| Branch model | Keep `develop` then `main` | `develop` = in development, `main` = ready-to-release/released. Promotion is an ordinary PR. |
| Authorization | Merge the PR + dispatch + `production` environment reviewer | Replaces `authorization.mjs`, label records and base64 comment snapshots. |
| Version source | `package.json` on `main`, committed **before** the release runs | The 1.5.0 failures came from committing *after* freezing. Committing first means nothing is frozen, so nothing can be invalidated. |
| Failure handling | Idempotent re-run | Rollback code that has never run is a liability, not a safety net. |

### Release flow (3 UI actions)

```
1. Actions -> "Prepare release" -> patch|minor|major
      branches release/X.Y.Z from develop, bumps versions + stamps changelog date,
      opens a PR into main
2. Review + merge that PR                    (this is the develop -> main promotion)
3. Actions -> "Release" (on main) -> Run
      tag vX.Y.Z, build ext (signed) + docker (2 arch) + site,
      GitHub release w/ assets, GHCR X.Y.Z/X.Y/X/latest,
      CWS upload + publish (auto-publishes on approval),
      production site deploy, sync PR main -> develop
```

CI never pushes to a protected branch. It only creates tags, releases and PRs — all permitted without bypass, which the 1.5.0 attempt proved is otherwise blocked on this repository.

### Non-goals

- Making Google's review faster. Only the human follow-up is removed.
- Blocking the GitHub-side release until the store approves. GHCR/site/release publish immediately; the store trails by hours or days. This trade removes all waiting machinery.
- Hotfix orchestration (`forward-hotfix.yml`). A hotfix is a normal PR into `main` followed by *Release*.

### Environments

Collapse five to two: `preview` (no reviewer) and `production` (required reviewer). Applied manually in Task 12.

---

## File Structure

**Created**
- `scripts/release/version.mjs` — semver parsing + bump arithmetic
- `scripts/release/version.test.mjs`
- `scripts/release/notes.mjs` — release-note rendering from the changelog
- `scripts/release/notes.test.mjs`
- `.github/workflows/prepare-release.yml` — opens the bump PR
- `.github/workflows/release.yml` — tags, builds, publishes

**Modified**
- `scripts/cws.mjs` — `PUBLISH_IMMEDIATELY`; add `publishAction`
- `scripts/cws.test.mjs` — cover `publishAction`
- `scripts/release/cli.mjs` — replaced by a ~120-line CLI (`next-version`, `prepare-workspace`, `notes`, `cws-release`)
- `scripts/release/cli.test.mjs` — replaced
- `.github/workflows/build-extension.yml` — drop candidate revalidation/trusted-tools
- `.github/workflows/build-docker.yml` — drop candidate revalidation
- `.github/workflows/site-deploy.yml` — drop candidate revalidation
- `.github/workflows/pr-validation.yml` — drop the `release-policy` job
- `RELEASING.md`, `CLAUDE.md`

**Unchanged**
- `scripts/release.mjs` (`packagePaths`, `changelogPath`, `checkWorkspace`, `prepareWorkspace`)
- `.github/workflows/ghcr-retention.yml`

**Deleted** (Task 10)
- Workflows: `reconcile-release-pr`, `prepare-prerelease`, `submit-candidate`, `promote-release`, `cancel-candidate`, `monitor-cws`, `forward-hotfix`
- Modules + tests: `authorization`, `cancellation`, `candidates`, `comments`, `forward`, `github-api`, `github`, `inspect`, `metadata`, `model`, `monitor`, `monitor-run`, `policy`, `prepare`, `promotion`, `reconcile`, `submission`, `workflow-permissions.test.mjs`, `fixtures/`

---

## Task 1: Version arithmetic

**Files:**
- Create: `scripts/release/version.mjs`
- Test: `scripts/release/version.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/release/version.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { latestVersion, nextVersion, parseVersion } from "./version.mjs";

test("parses stable semver only", () => {
  assert.deepEqual(parseVersion("1.5.0"), { major: 1, minor: 5, patch: 0 });
  assert.deepEqual(parseVersion("v1.5.0"), { major: 1, minor: 5, patch: 0 });
  assert.throws(() => parseVersion("1.5"), /not stable SemVer/);
  assert.throws(() => parseVersion("1.5.0-rc.1"), /not stable SemVer/);
  assert.throws(() => parseVersion("01.5.0"), /not stable SemVer/);
});

test("bumps each component and resets the lower ones", () => {
  assert.equal(nextVersion("1.5.3", "patch"), "1.5.4");
  assert.equal(nextVersion("1.5.3", "minor"), "1.6.0");
  assert.equal(nextVersion("1.5.3", "major"), "2.0.0");
  assert.throws(() => nextVersion("1.5.3", "huge"), /bump must be/);
});

test("latestVersion ignores non-release tags and orders numerically", () => {
  const tags = ["v1.4.0", "v1.10.0", "v1.9.0", "candidate-9-1", "v2.0.0-rc.1"];
  assert.equal(latestVersion(tags), "1.10.0");
  assert.equal(latestVersion([]), "0.0.0");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release/version.test.mjs`
Expected: FAIL — `Cannot find module './version.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/release/version.mjs
const stable = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const bumps = new Set(["patch", "minor", "major"]);

export function parseVersion(value) {
  const match = stable.exec(value ?? "");
  if (!match) throw new Error(`${value} is not stable SemVer X.Y.Z`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function nextVersion(current, bump) {
  if (!bumps.has(bump)) throw new Error(`bump must be one of ${[...bumps].join(", ")}`);
  const { major, minor, patch } = parseVersion(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Staging candidates and prereleases must never influence the next version, so a leftover
// candidate tag cannot skew a bump.
export function latestVersion(tags) {
  const versions = tags.filter((tag) => stable.test(tag)).map(parseVersion);
  if (versions.length === 0) return "0.0.0";
  versions.sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch);
  const top = versions.at(-1);
  return `${top.major}.${top.minor}.${top.patch}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/release/version.test.mjs`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```
git add scripts/release/version.mjs scripts/release/version.test.mjs
git commit -m "feat(release): add version bump arithmetic"
```

---

## Task 2: Release notes from the changelog

**Files:**
- Create: `scripts/release/notes.mjs`
- Test: `scripts/release/notes.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/release/notes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "./notes.mjs";

const changelog = [
  { version: "1.6.0", date: "2026-08-01", changes: [
    { kind: "new", text: "Added rotating tips." },
    { kind: "fixed", text: "Fixed a crash." },
    { kind: "new", text: "Added profiles." },
  ] },
  { version: "1.5.0", date: "2026-07-18", changes: [{ kind: "new", text: "Older." }] },
];

test("renders the requested version grouped by kind", () => {
  assert.equal(releaseNotes(changelog, "1.6.0"), [
    "## New",
    "- Added rotating tips.",
    "- Added profiles.",
    "",
    "## Fixed",
    "- Fixed a crash.",
  ].join("\n"));
});

test("omits empty groups and rejects an unknown version", () => {
  assert.equal(releaseNotes(changelog, "1.5.0"), ["## New", "- Older."].join("\n"));
  assert.throws(() => releaseNotes(changelog, "9.9.9"), /no changelog entry for 9\.9\.9/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release/notes.test.mjs`
Expected: FAIL — `Cannot find module './notes.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/release/notes.mjs
const headings = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];

export function releaseNotes(changelog, version) {
  const entry = changelog.find((item) => item.version === version);
  if (!entry) throw new Error(`no changelog entry for ${version}`);
  const sections = [];
  for (const [kind, heading] of headings) {
    const lines = entry.changes
      .filter((change) => change.kind === kind)
      .map((change) => `- ${change.text}`);
    if (lines.length > 0) sections.push([`## ${heading}`, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/release/notes.test.mjs`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```
git add scripts/release/notes.mjs scripts/release/notes.test.mjs
git commit -m "feat(release): render release notes from the changelog"
```

---

## Task 3: Chrome Web Store auto-publish

**Files:**
- Modify: `scripts/cws.mjs` (replace `publishStaged` and `submitStaged`; add `publishAction`)
- Test: `scripts/cws.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `publishAction` and `ChromeWebStoreClient` to the existing import at the top of `scripts/cws.test.mjs`, then append:

```javascript
test("publishAction uploads, publishes, or skips based on live store state", () => {
  const healthy = { warned: false, takenDown: false };
  assert.equal(publishAction({ ...healthy, publishedItemRevisionStatus: { version: "1.4.0" } }, "1.5.0"), "upload");
  assert.equal(publishAction({ ...healthy, publishedItemRevisionStatus: { version: "1.5.0" } }, "1.5.0"), "already-published");
  assert.equal(publishAction({
    ...healthy,
    submittedItemRevisionStatus: { version: "1.5.0", state: "PENDING_REVIEW" },
  }, "1.5.0"), "in-review");
  assert.throws(() => publishAction({ warned: true }, "1.5.0"), /policy warning/);
});

test("publish requests immediate publication so approval goes live unattended", async () => {
  const calls = [];
  const client = new ChromeWebStoreClient({
    publisherId: "p",
    extensionId: "e",
    accessToken: "t",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    },
  });
  await client.publish();
  assert.equal(calls[0].body.publishType, "PUBLISH_IMMEDIATELY");
  assert.equal(calls[0].body.blockOnWarnings, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/cws.test.mjs`
Expected: FAIL — `publishAction is not a function`

- [ ] **Step 3: Write minimal implementation**

In `scripts/cws.mjs`, replace the `publishStaged()` and `submitStaged()` methods with one method:

```javascript
  // PUBLISH_IMMEDIATELY makes Google publish the item as soon as review passes, so no polling,
  // no deferred-publish gate and no second workflow are required.
  publish() {
    return this.request(`/v2/${this.item}:publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishType: "PUBLISH_IMMEDIATELY", blockOnWarnings: true }),
    });
  }
```

and add the action helper beside `uploadAction`:

```javascript
export function publishAction(status, version) {
  assertHealthy(status);
  if (revisionVersion(status.publishedItemRevisionStatus) === version) return "already-published";
  const submitted = status.submittedItemRevisionStatus;
  if (submitted && revisionVersion(submitted) === version
    && ["PENDING_REVIEW", "IN_REVIEW"].includes(submitted.state)) return "in-review";
  return "upload";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/cws.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add scripts/cws.mjs scripts/cws.test.mjs
git commit -m "feat(release): publish to the store immediately after review"
```

---

## Task 4: Minimal release CLI

**Files:**
- Modify: `scripts/release/cli.mjs` (full replacement)
- Test: `scripts/release/cli.test.mjs` (full replacement)

The token helper exported by `scripts/cws.mjs` is `serviceAccountToken(credentials, fetchImpl)`; the client class is `ChromeWebStoreClient` and the upload poller is `waitForUpload`. Those exact names are used below.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/release/cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveVersion } from "./cli.mjs";

test("parses flags into a map", () => {
  assert.deepEqual(parseArgs(["--bump", "minor", "--version", "1.5.0"]), { bump: "minor", version: "1.5.0" });
  assert.deepEqual(parseArgs([]), {});
});

test("an explicit version wins over the bump, otherwise the bump applies", () => {
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "" }), "1.5.0");
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "2.0.0" }), "2.0.0");
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "" }), /bump must be/);
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "nope" }), /not stable SemVer/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release/cli.test.mjs`
Expected: FAIL — `parseArgs is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/release/cli.mjs
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { changelogPath, checkWorkspace, prepareWorkspace } from "../release.mjs";
import { latestVersion, nextVersion, parseVersion } from "./version.mjs";
import { releaseNotes } from "./notes.mjs";
import { ChromeWebStoreClient, publishAction, serviceAccountToken, waitForUpload } from "../cws.mjs";

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--")) throw new Error(`expected a flag, received ${argv[index]}`);
    values[argv[index].slice(2)] = argv[index + 1] ?? "";
  }
  return values;
}

export function resolveVersion({ tags, bump, version }) {
  if (version) {
    parseVersion(version);
    return version;
  }
  return nextVersion(latestVersion(tags), bump);
}

async function emit(outputs) {
  const text = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${text}\n`);
  else process.stdout.write(`${text}\n`);
}

const commands = {
  async "next-version"(values) {
    const tags = (values.tags ?? "").split(/\s+/).filter(Boolean);
    await emit({ version: resolveVersion({ tags, bump: values.bump, version: values.version ?? "" }) });
  },
  async "prepare-workspace"(values) {
    await prepareWorkspace(values.version, values.date);
    await checkWorkspace();
  },
  async notes(values) {
    const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
    await writeFile(values.out, `${releaseNotes(changelog, values.version)}\n`);
  },
  async "cws-release"(values) {
    const client = new ChromeWebStoreClient({
      publisherId: process.env.CWS_PUBLISHER_ID,
      extensionId: process.env.CWS_EXTENSION_ID,
      accessToken: await serviceAccountToken(JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON)),
    });
    const action = publishAction(await client.status(), values.version);
    if (action !== "upload") {
      process.stdout.write(`chrome web store: ${action}, nothing to do\n`);
      return;
    }
    const bytes = await readFile(values.package);
    await waitForUpload(client, await client.upload(bytes, `lurkloot-${values.version}.zip`));
    await client.publish();
    process.stdout.write(`chrome web store: submitted ${values.version} with immediate publication\n`);
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, ...rest] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    process.stderr.write(`usage: cli.mjs <${Object.keys(commands).join(" | ")}>\n`);
    process.exit(1);
  }
  command(parseArgs(rest)).catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/release/cli.test.mjs`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```
git add scripts/release/cli.mjs scripts/release/cli.test.mjs
git commit -m "refactor(release): replace the controller CLI with release primitives"
```

---

## Task 5: Prepare-release workflow

**Files:**
- Create: `.github/workflows/prepare-release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Prepare release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: Which component to bump
        type: choice
        options: [patch, minor, major]
        required: true
      version:
        description: Optional explicit version (X.Y.Z), overrides the bump
        type: string
        default: ""

permissions:
  contents: read

concurrency:
  group: prepare-release
  cancel-in-progress: false

jobs:
  prepare:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: develop
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - id: version
        env:
          BUMP: ${{ inputs.bump }}
          VERSION: ${{ inputs.version }}
        run: |
          tags=$(git tag --list 'v*' | tr '\n' ' ')
          node scripts/release/cli.mjs next-version --tags "$tags" --bump "$BUMP" --version "$VERSION"
      - name: Bump the workspace
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: node scripts/release/cli.mjs prepare-workspace --version "$VERSION" --date "$(date -u +%F)"
      - name: Open the release PR
        env:
          VERSION: ${{ steps.version.outputs.version }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -c "release/$VERSION"
          git commit -am "chore(release): $VERSION"
          git push --force origin "release/$VERSION"
          gh pr create --base main --head "release/$VERSION" \
            --title "Release $VERSION" \
            --body "Version bump and changelog date for $VERSION. Merge this, then run **Release** on main." \
            || gh pr edit "release/$VERSION" --title "Release $VERSION"
```

- [ ] **Step 2: Validate the workflow parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/prepare-release.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```
git add .github/workflows/prepare-release.yml
git commit -m "feat(ci): add the prepare-release dispatch"
```

---

## Task 6: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Release

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  resolve:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v7
      - name: Refuse to release from anywhere but main
        run: test "$GITHUB_REF" = "refs/heads/main"
      - id: version
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

  extension:
    needs: resolve
    permissions:
      contents: read
    uses: ./.github/workflows/build-extension.yml
    with:
      version: ${{ needs.resolve.outputs.version }}
      sign_crx: true
    secrets: inherit

  docker:
    needs: resolve
    permissions:
      contents: read
      packages: write
    uses: ./.github/workflows/build-docker.yml
    with:
      version: ${{ needs.resolve.outputs.version }}
      push: true
    secrets: inherit

  publish:
    needs: [resolve, extension, docker]
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: write
      packages: write
    env:
      VERSION: ${{ needs.resolve.outputs.version }}
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: actions/download-artifact@v8
        with:
          name: extension-release-assets
          path: release-assets
      - name: Tag the released commit
        run: |
          gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" \
            -f ref="refs/tags/v$VERSION" -f sha="$GITHUB_SHA" \
            || gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/v$VERSION" \
                 -f sha="$GITHUB_SHA" -F force=true
      - name: Render release notes
        run: node scripts/release/cli.mjs notes --version "$VERSION" --out notes.md
      - name: Create or update the GitHub release
        run: |
          if gh release view "v$VERSION" >/dev/null 2>&1; then
            gh release edit "v$VERSION" --notes-file notes.md --latest
          else
            gh release create "v$VERSION" --title "v$VERSION" --notes-file notes.md --latest
          fi
          gh release upload "v$VERSION" release-assets/* --clobber
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Promote the image aliases
        env:
          IMAGE: ghcr.io/${{ github.repository_owner }}/lurkloot-cli
        run: |
          major="${VERSION%%.*}"
          minor="${VERSION%.*}"
          docker buildx imagetools create \
            --tag "$IMAGE:$VERSION" --tag "$IMAGE:$minor" --tag "$IMAGE:$major" --tag "$IMAGE:latest" \
            "$IMAGE:$VERSION"
      - name: Publish to the Chrome Web Store
        env:
          CWS_SERVICE_ACCOUNT_JSON: ${{ secrets.CWS_SERVICE_ACCOUNT_JSON }}
          CWS_PUBLISHER_ID: ${{ vars.CWS_PUBLISHER_ID }}
          CWS_EXTENSION_ID: ${{ vars.CWS_EXTENSION_ID }}
        run: |
          node scripts/release/cli.mjs cws-release \
            --version "$VERSION" --package "release-assets/lurkloot-$VERSION-chrome.zip"

  site:
    needs: [resolve, publish]
    permissions:
      contents: read
    uses: ./.github/workflows/site-deploy.yml
    with:
      channel: production
      ref: main
    secrets: inherit

  sync:
    needs: [resolve, publish]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
      - env:
          GITHUB_TOKEN: ${{ github.token }}
          VERSION: ${{ needs.resolve.outputs.version }}
        run: |
          gh pr create --base develop --head main \
            --title "Sync main into develop after $VERSION" \
            --body "Brings the $VERSION release commit back into develop." \
            || echo "sync PR already open"
```

- [ ] **Step 2: Validate the workflow parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```
git add .github/workflows/release.yml
git commit -m "feat(ci): add the release dispatch"
```

---

## Task 7: Strip candidate machinery from build-extension

**Files:**
- Modify: `.github/workflows/build-extension.yml`

- [ ] **Step 1: Remove candidate inputs and revalidation**

Delete the `trusted_tools_ref`, `pr_number`, `expected_head_sha` and `release_label` inputs, every step named `Revalidate candidate …`, and the `trusted-release-tools` checkout. Replace the signer install so it runs from the repository checkout:

```yaml
      - name: Install and verify the pinned signer
        if: inputs.sign_crx && inputs.version != ''
        run: |
          pnpm install --frozen-lockfile --ignore-scripts
          mkdir -p signer
          printf '{"private":true,"dependencies":{"crx3":"2.0.0"}}\n' > signer/package.json
          pnpm --dir signer install --offline --ignore-scripts --prod --lockfile=false --ignore-workspace
          test "$(node -p "require('$GITHUB_WORKSPACE/signer/node_modules/crx3/package.json').version")" = 2.0.0
```

Replace the version step so it uses the repository's own CLI:

```yaml
      - name: Set the release version
        if: inputs.version != ''
        env:
          RELEASE_VERSION: ${{ inputs.version }}
        run: node scripts/release/cli.mjs prepare-workspace --version "$RELEASE_VERSION" --date "$(date -u +%F)"
```

Change the signing job's gate to `environment: ${{ inputs.sign_crx && 'production' || '' }}`.

- [ ] **Step 2: Validate**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-extension.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```
git add .github/workflows/build-extension.yml
git commit -m "refactor(ci): drop candidate revalidation from the extension build"
```

---

## Task 8: Strip candidate machinery from build-docker

**Files:**
- Modify: `.github/workflows/build-docker.yml`

- [ ] **Step 1: Remove candidate inputs, revalidation and the digest artifact**

Delete the `pr_number`, `expected_head_sha`, `release_label` and `trusted_tools_ref` inputs, every `Revalidate candidate …` step, and the `digests/` directory plus its upload. In the publish job push the version tags directly:

```yaml
        run: |
          docker load --input images/image-amd64.tar
          docker push "$IMAGE_NAME:$VERSION-amd64"
          docker load --input images/image-arm64.tar
          docker push "$IMAGE_NAME:$VERSION-arm64"
          docker buildx imagetools create --tag "$IMAGE_NAME:$VERSION" \
            "$IMAGE_NAME:$VERSION-amd64" "$IMAGE_NAME:$VERSION-arm64"
```

Keep the three fixes landed for 1.5.0: `outputs: type=docker`, `cache-to: type=gha,...,ignore-error=true`, and the relative-path checksum (`cd /tmp && sha256sum image-…`). Change the publish job's gate to `environment: production`.

- [ ] **Step 2: Validate**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-docker.yml')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```
git add .github/workflows/build-docker.yml
git commit -m "refactor(ci): drop candidate revalidation from the docker build"
```

---

## Task 9: Simplify site-deploy and pr-validation

**Files:**
- Modify: `.github/workflows/site-deploy.yml`, `.github/workflows/pr-validation.yml`

- [ ] **Step 1: Trim site-deploy**

Remove the `pr_number`, `expected_head_sha`, `release_label`, `trusted_tools_ref` and `promote` inputs and every `Revalidate candidate …` step. Keep `channel`/`ref` and the checksum step with the 1.5.0 fix (`find . -type f ! -name SITE_SHA256SUMS …`). Set:

```yaml
    environment:
      name: ${{ inputs.channel == 'production' && 'production' || 'preview' }}
      url: ${{ inputs.channel == 'production' && 'https://lurkloot.jamezrin.com' || 'https://next.lurkloot.pages.dev' }}
```

- [ ] **Step 2: Trim pr-validation**

Delete the entire `release-policy` job. Leave `verify`, `extension` and `docker` untouched so the required check contexts (`verify`, `extension / build`, `docker / build (…)`) keep their exact names.

- [ ] **Step 3: Validate both**

Run: `python3 -c "import yaml; [yaml.safe_load(open('.github/workflows/'+n+'.yml')) for n in ['site-deploy','pr-validation']]; print('valid')"`
Expected: `valid`

- [ ] **Step 4: Commit**

```
git add .github/workflows/site-deploy.yml .github/workflows/pr-validation.yml
git commit -m "refactor(ci): remove candidate gating from site and PR validation"
```

---

## Task 10: Delete the controller

**Files:**
- Delete: 7 workflows and the controller modules/tests

- [ ] **Step 1: Delete the workflows and modules**

```
git rm .github/workflows/reconcile-release-pr.yml .github/workflows/prepare-prerelease.yml \
       .github/workflows/submit-candidate.yml .github/workflows/promote-release.yml \
       .github/workflows/cancel-candidate.yml .github/workflows/monitor-cws.yml \
       .github/workflows/forward-hotfix.yml
git rm scripts/release/authorization.mjs scripts/release/cancellation.mjs \
       scripts/release/candidates.mjs scripts/release/comments.mjs scripts/release/forward.mjs \
       scripts/release/github-api.mjs scripts/release/github.mjs scripts/release/inspect.mjs \
       scripts/release/metadata.mjs scripts/release/model.mjs scripts/release/monitor.mjs \
       scripts/release/monitor-run.mjs scripts/release/policy.mjs scripts/release/prepare.mjs \
       scripts/release/promotion.mjs scripts/release/reconcile.mjs scripts/release/submission.mjs
git rm scripts/release/authorization.test.mjs scripts/release/cancellation.test.mjs \
       scripts/release/candidates.test.mjs scripts/release/forward.test.mjs \
       scripts/release/github-api.test.mjs scripts/release/github.test.mjs \
       scripts/release/inspect.test.mjs scripts/release/metadata.test.mjs \
       scripts/release/model.test.mjs scripts/release/monitor.test.mjs \
       scripts/release/monitor-run.test.mjs scripts/release/policy.test.mjs \
       scripts/release/prepare.test.mjs scripts/release/promotion.test.mjs \
       scripts/release/reconcile.test.mjs scripts/release/submission.test.mjs \
       scripts/release/workflow-permissions.test.mjs
git rm -r scripts/release/fixtures
```

- [ ] **Step 2: Verify nothing still imports a deleted module**

Run: `grep -rnE "\./(authorization|cancellation|candidates|comments|forward|github-api|github|inspect|metadata|model|monitor|monitor-run|policy|prepare|promotion|reconcile|submission)\.mjs" scripts/ || echo "no dangling imports"`
Expected: `no dangling imports`

- [ ] **Step 3: Run the whole suite**

Run: `node --test scripts/release/*.test.mjs scripts/*.test.mjs`
Expected: PASS, no failures

- [ ] **Step 4: Confirm the remaining size**

Run: `find scripts -name '*.mjs' | xargs wc -l | tail -1 && ls .github/workflows | wc -l`
Expected: well under 1,000 lines and 6 workflows

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "refactor(release): remove the PR-driven release controller"
```

---

## Task 11: Documentation

**Files:**
- Modify: `RELEASING.md` (full rewrite), `CLAUDE.md` ("Cutting a Release")

- [ ] **Step 1: Rewrite RELEASING.md**

Replace the entire document with: the three-step flow from the Spec; the two environments (`preview`, `production`); the required secrets (`CRX_PRIVATE_KEY`, `CWS_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and variables (`CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`); and a recovery section stating that every step is idempotent, so a failure is fixed by correcting the cause and re-running **Release**. State explicitly that the store trails the GitHub release by the review duration and publishes itself on approval.

- [ ] **Step 2: Update CLAUDE.md**

Replace the "Cutting a Release" section with:

```markdown
## Cutting a Release

Releases run from the Actions tab. Run **Prepare release** (choose patch/minor/major) to open the
version-bump PR into `main`, merge it, then run **Release** on `main`. Release tags the commit,
builds every artifact, publishes the GitHub release, GHCR aliases, the Chrome Web Store submission
and the production site, then opens the `main` to `develop` sync PR. Every step is idempotent: if
one fails, fix the cause and run **Release** again. Do not push tags by hand.
```

- [ ] **Step 3: Commit**

```
git add RELEASING.md CLAUDE.md
git commit -m "docs(release): document the dispatch-driven pipeline"
```

---

## Task 12: Repository configuration (manual, administrator)

Not code — perform in the GitHub UI/API, then tick.

- [ ] Create environments `preview` (no reviewer) and `production` (required reviewer: repository admins).
- [ ] Move `CRX_PRIVATE_KEY`, `CWS_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from repository secrets into those environments, so the environments become real credential boundaries instead of prompts.
- [ ] Delete environments `prereleases`, `cws-review`, `prerelease-site`, `production-site`, `stable-releases`.
- [ ] Remove `cws-release-ready` from `main`'s required status checks. Nothing posts it any more, so leaving it would block every PR forever.
- [ ] Delete the `release/patch`, `release/minor`, `release/major` and `release/hotfix` labels.
- [ ] Confirm the repository default workflow token permission is still `read`.

---

## Task 13: Validate on a real 1.5.1

Do this **before** relying on the new pipeline, and keep the old branch around until it passes.

- [ ] Merge this branch into `develop` via PR, then open and merge a `develop` to `main` PR, so both new workflows exist on the default branch. Dispatch only lists workflows present on the default branch.
- [ ] Run **Prepare release** with `patch`. Confirm it opens `release/1.5.1` into `main` containing 7 bumped `package.json` files and a dated 1.5.1 changelog entry.
- [ ] Merge that PR.
- [ ] Run **Release** on `main`. Approve the single `production` gate.
- [ ] Verify: tag `v1.5.1` on the merge commit; the GitHub release marked Latest carrying the signed CRX, both browser zips, sources and checksums; `ghcr.io/jamezrin/lurkloot-cli` tags `1.5.1`, `1.5`, `1` and `latest` all resolving to one multi-arch digest; the store item submitted with immediate publication; `lurkloot.jamezrin.com` serving 1.5.1; a `main` to `develop` sync PR open.
- [ ] Re-run **Release** unchanged and confirm it is a harmless no-op. This idempotency is what replaces rollback.
- [ ] Confirm the store publishes on its own once Google approves, with no further action.
