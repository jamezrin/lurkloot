import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = (name) => readFile(`.github/workflows/${name}`, "utf8");

test("candidate preparation is reusable and recovery accepts only a PR number", async () => {
  const text = await workflow("prepare-prerelease.yml");
  assert.match(text, /workflow_call:/);
  for (const input of ["expected_head_sha", "version", "kind", "release_label", "authorized_by", "stable_sha", "develop_sha", "trusted_tools_ref"]) {
    assert.match(text, new RegExp(`\\b${input}:`));
  }
  const dispatch = text.match(/workflow_dispatch:\n([\s\S]*?)\n  workflow_call:/)?.[1] ?? "";
  assert.match(dispatch, /\n      pr_number:/);
  assert.doesNotMatch(dispatch, /\n      (?:version|source_ref|release_kind):/);
  assert.equal((dispatch.match(/\n      pr_number:/g) ?? []).length, 1);
  assert.doesNotMatch(text, /gh pr create/);
});

test("candidate preparation pins and revalidates authorized PR state", async () => {
  const text = await workflow("prepare-prerelease.yml");
  assert.match(text, /headRefOid/);
  assert.match(text, /EXPECTED_HEAD_SHA/);
  assert.match(text, /RELEASE_LABEL/);
  assert.ok((text.match(/gh pr view "\$PR"/g) ?? []).length >= 3, "validate before builds and immediately before mutations");
  assert.match(text, /ref: \$\{\{ needs\.[^.]+\.outputs\.candidate_sha \}\}/);
  assert.ok((text.match(/trusted_tools_ref: \$\{\{ needs\.[^.]+\.outputs\.trusted_tools_ref \}\}/g) ?? []).length >= 2);
});

test("candidate builders isolate credentials from candidate code", async () => {
  for (const name of ["build-extension.yml", "build-docker.yml", "site-deploy.yml"]) {
    const text = await workflow(name);
    const build = text.match(/\n  build:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/)?.[1] ?? "";
    assert.doesNotMatch(build, /contents:\s*write|packages:\s*write|CLOUDFLARE_API_TOKEN|CWS_|CRX_PRIVATE_KEY|secrets\.GITHUB_TOKEN|docker\/login-action/);
  }
});

test("CRX signing executes only a locally verified pinned signer with the key", async () => {
  const extension = await workflow("build-extension.yml");
  const build = extension.match(/\n  build:\n([\s\S]*?)(?=\n  finalize:\n)/)?.[1] ?? "";
  assert.match(build, /pnpm --dir trusted-release-tools install --frozen-lockfile --ignore-scripts/);
  assert.match(build, /pnpm --dir trusted-release-tools\/signer install --offline --ignore-scripts/);
  const finalize = extension.match(/\n  finalize:\n([\s\S]*)/)?.[1] ?? "";
  assert.doesNotMatch(finalize, /\bnpx\b|npm (?:install|exec)|pnpm (?:add|dlx|install)|curl|wget/);
  assert.match(finalize, /SIGNER_SHA256/);
  assert.match(finalize, /sha256sum -c/);
  assert.match(finalize, /node signer\/node_modules\/crx3\/bin\/crx3\.js/);
  const keyStep = finalize.match(/- name: Build signed CRX3\n([\s\S]*?)(?=\n      - name:|\n      - uses:)/)?.[1] ?? "";
  assert.match(keyStep, /CRX_PRIVATE_KEY/);
  assert.doesNotMatch(keyStep, /actions\/|\bnpx\b|pnpm|npm|curl|wget/);
});

test("candidate Docker builds explicitly deny inherited package permissions", async () => {
  const docker = await workflow("build-docker.yml");
  const build = docker.match(/\n  build:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/)?.[1] ?? "";
  assert.match(build, /permissions:\n\s+contents: read\n\s+packages: none/);
  const publish = docker.match(/\n  publish:\n([\s\S]*?)$/)?.[1] ?? "";
  assert.match(publish, /permissions:\n\s+contents: read\n\s+packages: write/);
});

test("trusted tooling is derived from and matched to the live main ref, including recovery", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  assert.match(prepare, /git\/ref\/heads\/main/);
  assert.match(prepare, /CALL_TRUSTED_TOOLS/);
  assert.match(prepare, /trusted_tools_ref does not match independently resolved main/);
  assert.doesNotMatch(prepare, /tools:\.trustedToolsSha/);
  const validate = prepare.indexOf("Validate exact authorized PR state before builds");
  const extension = prepare.indexOf("\n  extension:");
  assert.ok(validate >= 0 && validate < extension, "trusted main mismatch fails before privileged work");
});

test("each external mutation has an adjacent live candidate revalidation", async () => {
  for (const name of ["prepare-prerelease.yml", "build-docker.yml", "site-deploy.yml"]) {
    const fullText = await workflow(name);
    const text = fullText.split("- name: Roll back canonical candidate references")[0];
    const mutations = [...text.matchAll(/(?:gh api -X (?:POST|PATCH|DELETE)|gh release (?:create|edit|upload|delete)|docker (?:push|buildx imagetools create)|pages deploy|upload-candidate)/g)];
    for (const mutation of mutations) {
      const before = text.slice(Math.max(0, mutation.index - 900), mutation.index);
      assert.match(before, /(?:gh pr view "\$PR" --json headRefOid,labels|\brevalidate\s*)/, `${name}: ${mutation[0]} must immediately revalidate`);
    }
  }
});

test("candidate publication uses one repository-wide non-cancelling transaction lock", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  assert.match(prepare, /concurrency:\n  group: candidate-publication-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false/);
  assert.doesNotMatch(prepare, /prepare-candidate-pr-|cancel-in-progress: true/);
});

test("candidate publication stages immutable run identities and rolls back partial commits", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  assert.match(prepare, /STAGING_ID: candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  for (const id of ["github_tag", "github_release", "github_assets", "docker_version", "docker_next", "cws_candidate", "site_next"]) {
    assert.match(prepare, new RegExp(`- id: ${id}\\n`));
  }
  assert.match(prepare, /name: Roll back canonical candidate references/);
  assert.match(prepare, /if: always\(\) && steps\.transaction_started\.outputs\.started == 'true' && failure\(\)/);
  assert.doesNotMatch(prepare, /steps\.commit\.outcome == 'success'/);
  const stage = prepare.indexOf("name: Stage");
  const commit = prepare.indexOf("id: github_tag");
  assert.ok(stage >= 0 && stage < commit);

  const docker = await workflow("build-docker.yml");
  assert.match(docker, /candidate-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.ok(docker.indexOf("Stage immutable OCI amd64") < docker.indexOf("Stage immutable OCI manifest"));

  const site = await workflow("site-deploy.yml");
  assert.match(site, /format\('candidate-\{0\}-\{1\}', github\.run_id, github\.run_attempt\)/);
  assert.ok(site.indexOf("Stage immutable site deployment") < site.indexOf("Promote staged site to mutable channel"));
});

test("rollback snapshots complete canonical state and restores only run-owned mutations", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  for (const marker of [
    "prior-release.json", "prior-release-notes.md", "prior-assets.json", "rollback-assets",
    "prior-docker-version-digest", "prior-docker-next-digest", "prior-cws-package",
  ]) assert.match(prepare, new RegExp(marker.replaceAll(".", "\\.")));
  for (const field of [".prerelease", ".draft", ".name", ".body", ".tag_name", "prior-release-is-latest"]) {
    assert.match(prepare, new RegExp(field.replace(".", "\\.")));
  }
  assert.match(prepare, /gh api .*releases\/assets.*-X DELETE/);
  assert.match(prepare, /--notes-file prior-release-notes\.md/);
  assert.match(prepare, /--prerelease=\"\$priorPrerelease\"/);
  assert.match(prepare, /--latest=\"\$priorLatest\"/);
  assert.ok((prepare.match(/current=.*imagetools inspect/g) ?? []).length >= 2, "both OCI aliases compare ownership before restore");
  assert.ok((prepare.match(/test \"\$current\" = \"\$stagedDigest\"/g) ?? []).length >= 2, "OCI rollback is ownership guarded");
  assert.match(prepare, /currentTag=.*git\/ref\/tags/);
  assert.match(prepare, /\"\$currentTag\" == \"\$EXPECTED_HEAD_SHA\"/);
  assert.match(prepare, /\.sourceSha \"\$currentOwner\/candidate\.json\"/);
});

test("CWS mutation is restorable or fails closed without claiming success", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  assert.match(prepare, /prior-cws-existed/);
  assert.match(prepare, /prior-cws-package/);
  assert.match(prepare, /CWS_PACKAGE_PATH=prior-cws-package/);
  assert.match(prepare, /CWS_RECONCILIATION_BLOCKED/);
  assert.match(prepare, /exit 1/);
  assert.ok(prepare.indexOf("id: cws_candidate") > prepare.indexOf("Back up prior canonical"));
});

test("site is the last fallible canonical mutation and outputs are prepared beforehand", async () => {
  const prepare = await workflow("prepare-prerelease.yml");
  const outputs = prepare.indexOf("id: outputs");
  const site = prepare.indexOf("id: site_next");
  const rollback = prepare.indexOf("name: Roll back canonical candidate references");
  assert.ok(outputs >= 0 && outputs < site && site < rollback);
  assert.doesNotMatch(prepare.slice(site, rollback), /\n      - (?:name|uses|id):/);
});

test("CRX key is confined to a literal network namespace with guaranteed cleanup", async () => {
  const extension = await workflow("build-extension.yml");
  const keyStep = extension.match(/- name: Build signed CRX3\n([\s\S]*?)(?=\n      - name:|\n      - uses:)/)?.[1] ?? "";
  assert.match(keyStep, /unshare --net/);
  assert.match(keyStep, /trap .*lurkloot\.pem.*EXIT/);
  assert.doesNotMatch(keyStep, /docker pull|podman pull|pnpm|npm|curl|wget/);
});

test("privileged artifact jobs are protected and never check out candidate code", async () => {
  const extension = await workflow("build-extension.yml");
  const finalize = extension.match(/\n  finalize:\n([\s\S]*)/)?.[1] ?? "";
  assert.match(finalize, /environment:\s*prereleases/);
  assert.match(finalize, /sha256sum -c/);
  assert.doesNotMatch(finalize, /actions\/checkout/);

  const docker = await workflow("build-docker.yml");
  const publish = docker.match(/\n  publish:\n([\s\S]*)/)?.[1] ?? "";
  assert.match(publish, /environment:\s*prereleases/);
  assert.match(publish, /sha256sum -c/);
  assert.doesNotMatch(publish, /actions\/checkout/);

  const site = await workflow("site-deploy.yml");
  const deploy = site.match(/\n  deploy:\n([\s\S]*)/)?.[1] ?? "";
  assert.match(deploy, /environment:/);
  assert.match(deploy, /sha256sum -c/);
  assert.doesNotMatch(deploy, /actions\/checkout/);
});

test("candidate preparation exposes the controller result contract", async () => {
  const text = await workflow("prepare-prerelease.yml");
  for (const output of ["candidate_sha", "release_url", "preview_url", "chrome_zip_sha256", "docker_tag"]) {
    assert.match(text, new RegExp(`\\b${output}:`));
  }
  assert.match(text, /metadata create/);
  assert.match(text, /schemaVersion/);
});
