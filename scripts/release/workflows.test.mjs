import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = (name) => readFile(`.github/workflows/${name}`, "utf8");

test("controller uses trusted pull_request_target events", async () => {
  const text = await workflow("reconcile-release-pr.yml");
  assert.match(text, /pull_request_target:/);
  for (const type of ["opened", "reopened", "synchronize", "labeled", "unlabeled", "converted_to_draft", "ready_for_review", "closed"]) {
    assert.match(text, new RegExp(`\\b${type}\\b`));
  }
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /group: release-pr-\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(text, /actions\/checkout[^\n]*\n(?:.*\n){0,5}.*ref:.*head\.sha/);
  for (const job of ["inspect", "prepare", "cancel", "cancel-and-prepare", "submit", "notify"]) {
    assert.match(text, new RegExp(`\\n  ${job}:\\n[\\s\\S]*?permissions:`));
  }
});

test("controller recovers authorization and calls only policy-selected mutations", async () => {
  const text = await workflow("reconcile-release-pr.yml");
  assert.match(text, /permission.*admin|admin.*permission/is);
  assert.match(text, /metadata read/);
  for (const field of ["authorized_by", "authorized_sha", "label"]) assert.match(text, new RegExp(`\\b${field}\\b`));
  assert.match(text, /awaiting-approval/);
  assert.match(text, /jq -r \.state policy\.json\) == blocked/);
  assert.match(text, /needs\.cancel\.outputs\.safe_to_replace == 'true'/);
  for (const reusable of ["prepare-prerelease.yml", "cancel-candidate.yml", "submit-candidate.yml"]) {
    assert.match(text, new RegExp(`uses: \\.\\/\\.github\\/workflows\\/${reusable.replace(".", "\\.")}`));
  }
  assert.doesNotMatch(text.match(/\n  inspect:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/)?.[1] ?? "", /secrets\./);
  assert.match(text, /lur[k]?loot-release-pr:\$PR:status/);
  assert.match(text, /milestone/);
  assert.doesNotMatch(text, /uses: \.\/\.github\/workflows\/promote-release\.yml/);
});

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
  assert.doesNotMatch(prepare, /test -z \"\$priorDocker\" \|\| docker buildx/, "an empty prior alias must not become a rollback no-op");
  assert.match(prepare, /dockerAliasesToDelete=\(\)/);
  assert.match(prepare, /dockerAliasesToDelete\+=\(\"\$VERSION\"\)/);
  assert.match(prepare, /dockerAliasesToDelete\+=\(next\)/);
  assert.match(prepare, /users\/\$owner\/packages\/container\/lurkloot-cli\/versions/);
  assert.match(prepare, /orgs\/\$owner\/packages\/container\/lurkloot-cli\/versions/);
  assert.match(prepare, /select\(\.name == \$digest\)/, "the package version lookup is pinned to the run-owned digest");
  assert.match(prepare, /index\(\$staging\)/, "the immutable run staging tag proves package-version ownership");
  assert.match(prepare, /all\(\. == \$version or \. == \"next\" or \. == \$staging\)/, "package deletion rejects unrelated attached tags");
  assert.equal((prepare.match(/gh api -X DELETE \"\$endpoint\/\$packageId\"/g) ?? []).length, 1, "both empty aliases share one package-version deletion");
  assert.match(prepare, /GHCR_RECONCILIATION_BLOCKED/);
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

test("candidate cancellation is a reusable fail-closed replacement gate", async () => {
  const text = await workflow("cancel-candidate.yml");
  assert.match(text, /workflow_call:/);
  for (const input of ["pr_number", "candidate_version", "expected_candidate_sha", "disposition"]) assert.match(text, new RegExp(`\\b${input}:`));
  for (const output of ["cancelled", "safe_to_replace", "reason"]) assert.match(text, new RegExp(`\\b${output}:`));
  assert.match(text, /group: cws-mutation/);
  assert.match(text, /schemaVersion candidate\/candidate\.json\)" = 2/);
  assert.match(text, /cancel-submission/);
  assert.match(text, /scripts\/cws\.mjs status/);
  assert.match(text, /submitted_state.*CANCELLED|CANCELLED.*submitted_state/s);
  assert.match(text, /gh pr ready "\$PR" --undo/);
  assert.match(text, /safe_to_replace=false/);
  assert.match(text, /PUBLISHED/);
  assert.match(text, /--json headRefOid,isDraft,state,labels/);
  assert.match(text, /if \[\[ "\$is_draft" != true \]\]; then/);
  assert.doesNotMatch(text, /jq -r \.releaseLabel/);
  assert.match(text, /jq -r \.label candidate\/candidate\.json/);
  assert.match(text, /if: always\(\)/);
  assert.match(text, /release-candidate/);
  assert.match(text, /reconciliation-blocked/);
  assert.match(text, /lur[k]?loot-release-pr:\$PR:status/);
});

test("candidate submission is reusable, approval-gated, and revalidates live ownership", async () => {
  const text = await workflow("submit-candidate.yml");
  assert.match(text, /workflow_call:/);
  for (const input of ["pr_number", "version", "expected_head_sha", "trusted_tools_ref"]) assert.match(text, new RegExp(`\\b${input}:`));
  assert.doesNotMatch(text, /workflow_dispatch:/);
  assert.match(text, /environment: cws-review/);
  assert.doesNotMatch(text, /gh pr ready/);
  assert.match(text, /schemaVersion candidate\/candidate\.json\)" = 2/);
  assert.ok((text.match(/gh pr view "\$PR" --json headRefOid,isDraft,state,labels/g) ?? []).length >= 2);
  assert.match(text, /submit-staged/);
  assert.match(text, /GITHUB_OUTPUT="\$submission_output" node scripts\/cws\.mjs submit-staged/);
  assert.match(text, /action=\$\(sed -n 's\/\^action=\/\/p' "\$submission_output"\)/);
  assert.match(text, /test "\$action" = submitted \|\| test "\$action" = already-submitted \|\| test "\$action" = already-staged/);
  assert.match(text, /submitCandidateCheck\(process\.env\.ACTION, process\.env\.VERSION\)/);
  assert.match(text, /if \[\[ "\$action" == already-staged \]\]; then/);
  assert.match(text, /Chrome Web Store version \$VERSION is STAGED and awaits monitor finalization/);
  assert.match(text, /status_state="staged validation pending"/);
  assert.match(text, /CWS already reports staged publishing approval/);
  assert.match(text, /Monitor finalization and release metadata validation remain pending/);
  assert.match(text, /cws-pending/);
  assert.match(text, /ref: \$\{\{ inputs\.trusted_tools_ref \}\}/);
  assert.match(text, /version: \$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(text, /jq -r \.releaseLabel/);
  assert.ok((text.match(/jq -r \.label candidate\/candidate\.json/g) ?? []).length >= 2);
  assert.match(text, /actions\/upload-artifact@v7/);
  assert.match(text, /name: extension-submission-evidence-\$\{\{ inputs\.version \}\}/);
  assert.match(text, /actions\/download-artifact@v8[\s\S]*extension-submission-evidence/);
  assert.match(text, /sha256sum candidate\/\*.*verification\/release-assets\.sha256/s);
  assert.match(text, /sha256sum -c verification\/release-assets\.sha256/);
  for (const field of ["version", "sourceSha", "headSha", "label", "trustedToolsSha", "freshChromeSha256"]) {
    assert.match(text, new RegExp(`jq -r \\.${field} verification/evidence\\.json`));
  }
  assert.match(text, /metadata verify candidate\/candidate\.json candidate/);
  assert.match(text, /cws-release-ready/);
  assert.match(text, /lur[k]?loot-release-pr:\$PR:status/);
  assert.match(text, /gh release edit "v\$VERSION"/);
});

test("privileged candidate boundaries require exactly the expected recognized release label", async () => {
  const recognized = /select\(\. == "release\/patch" or \. == "release\/minor" or \. == "release\/major" or \. == "release\/hotfix"\)/;
  for (const name of ["prepare-prerelease.yml", "submit-candidate.yml", "cancel-candidate.yml"]) {
    const text = await workflow(name);
    assert.match(text, recognized, `${name} must filter the complete recognized label set`);
    assert.match(text, /recognized_labels=.*jq/, `${name} must filter recognized labels from live PR data`);
    assert.match(text, /recognized_count=\$\(jq ['"]length['"]/, `${name} must count recognized labels`);
    assert.match(text, /test "\$recognized_count" = 1/, `${name} must reject zero or multiple recognized labels`);
    assert.match(text, /test "\$recognized_label" = "\$(?:RELEASE_LABEL|label)"/, `${name} must match the expected metadata or input label`);
  }

  const prepare = await workflow("prepare-prerelease.yml");
  for (const marker of ["id: cws_candidate", "id: github_tag", "id: github_release", "id: github_assets", "id: docker_version", "id: docker_next"]) {
    const boundary = prepare.indexOf(marker);
    assert.ok(boundary >= 0);
    assert.match(prepare.slice(boundary, boundary + 1800), /test "\$recognized_count" = 1/, `${marker} must contain a fresh exact-label boundary`);
  }
  const siteMutation = prepare.indexOf("id: site_next");
  assert.match(prepare.slice(Math.max(0, siteMutation - 1400), siteMutation), /test "\$recognized_count" = 1/);

  const submit = await workflow("submit-candidate.yml");
  const submitMutation = submit.indexOf("submit-staged");
  assert.match(submit.slice(Math.max(0, submitMutation - 1800), submitMutation), /test "\$recognized_count" = 1/);
  const cancel = await workflow("cancel-candidate.yml");
  const cancelMutation = cancel.indexOf("cancel-submission");
  assert.match(cancel.slice(Math.max(0, cancelMutation - 1800), cancelMutation), /test "\$recognized_count" = 1/);
});

test("manual PR validation skips payload-dependent release policy while normal verification runs", async () => {
  const text = await workflow("pr-validation.yml");
  const policy = text.match(/\n  release-policy:\n([\s\S]*?)(?=\n  verify:\n)/)?.[1] ?? "";
  assert.match(policy, /if: github\.event_name == 'pull_request'/);
  assert.doesNotMatch(text.match(/\n  verify:\n([\s\S]*?)(?=\n  extension:\n)/)?.[1] ?? "", /if:.*pull_request/);
});

test("stable promotion selects schema-v2 candidates by PR identity, never branch names", async () => {
  const text = await workflow("promote-release.yml");
  assert.match(text, /workflow_dispatch:/);
  const dispatch = text.match(/workflow_dispatch:\n([\s\S]*?)\npermissions:/)?.[1] ?? "";
  assert.match(dispatch, /\n      pr_number:/);
  assert.doesNotMatch(dispatch, /\n      (?:version|source_ref|release_kind):/);
  assert.doesNotMatch(text, /startsWith\([^\n]*(?:release\/|hotfix\/)/);
  assert.match(text, /schema_version[\s\S]*= 2/);
  for (const field of ["label", "authorized_sha", "release_pr", "source_sha", "artifact_checksums", "docker_digests", "cws_state"]) {
    assert.match(text, new RegExp(`s/\\^${field}=//p`));
  }
  assert.match(text, /No matching authorized staged candidate; no release action was performed/);
  assert.match(text, /recognized release PR #\$PR has no matching candidate/);
  assert.match(text, /merged PR release labels no longer exactly match candidate metadata/);
  assert.match(text, /--json headRefOid,mergeCommit,mergedAt,state,labels,statusCheckRollup/);
  assert.match(text, /cws-release-ready/);
  assert.match(text, /metadata verify release-assets\/candidate\.json release-assets/);
  assert.match(text, /chore\(release\): finalize \$version metadata/);
  assert.match(text, /group: cws-mutation/);
});

test("promotion and forward merge use trusted live-main tooling and revalidate before mutations", async () => {
  const promote = await workflow("promote-release.yml");
  assert.match(promote, /git\/ref\/heads\/main/);
  assert.match(promote, /trusted_tools_ref/);
  assert.ok((promote.match(/gh pr view "\$PR" --json/g) ?? []).length >= 3);
  assert.match(promote, /stable-release-\$\{\{ github\.repository \}\}/);
  assert.match(promote, /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"/);
  assert.doesNotMatch(promote, /gh release list --limit 100/);
  assert.match(promote, /published_version/);
  assert.match(promote, /submitted_state.*STAGED[\s\S]*submitted_state.*PUBLISHED/);
  assert.match(promote, /EXPECTED_MERGE_SHA/);
  assert.ok((promote.match(/recognized_count/g) ?? []).length >= 3, "exact label invariant is repeated at privileged mutation boundaries");
  assert.ok((promote.match(/cws-release-ready/g) ?? []).length >= 3, "required checks are repeated at privileged mutation boundaries");

  const forward = await workflow("forward-hotfix.yml");
  assert.match(forward, /expected_main_sha/);
  assert.match(forward, /git\/ref\/heads\/main/);
  assert.match(forward, /test "\$live_main" = "\$EXPECTED_MAIN_SHA"/);
});
