import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function workflow(name) {
  return readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
}

test("release preparation uses trusted base tooling for label lifecycle events", async () => {
  const text = await workflow("prepare-release.yml");
  assert.match(text, /pull_request_target:/);
  assert.match(text, /types: \[labeled, unlabeled\]/);
  assert.match(text, /head\.repo\.full_name == github\.repository/);
  assert.match(text, /!startsWith\(github\.event\.pull_request\.head\.ref, 'release\/'\)/);
  assert.match(text, /path: trusted/);
  assert.match(text, /path: candidate/);
  assert.match(text, /\.\.\/trusted\/scripts\/release\/cli\.mjs prepare-workspace/);
  assert.match(text, /--add-label "\$LABEL"/);
  assert.match(text, /uses: \.\/\.github\/workflows\/build-release-candidate\.yml/);
});

test("candidate workflow runs trusted orchestration for generated release pull requests", async () => {
  const controller = await workflow("release-candidate.yml");
  const candidate = await workflow("build-release-candidate.yml");
  assert.match(controller, /pull_request_target:/);
  assert.match(controller, /types: \[opened, reopened, synchronize\]/);
  assert.match(controller, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/'\)/);
  assert.match(controller, /uses: \.\/\.github\/workflows\/build-release-candidate\.yml/);
  assert.match(controller, /commit-status/);
  assert.match(controller, /release candidate \/ ready/);
  assert.match(candidate, /permissions:\n\s+contents: read/);
  assert.match(candidate, /trusted_ref:/);
  assert.match(candidate, /statuses: write/);
  assert.match(candidate, /candidate-checks/);
  assert.match(candidate, /pnpm check/);
  assert.match(candidate, /extension:\n\s+needs: verify/);
  assert.match(candidate, /docker:\n\s+needs: verify/);
  assert.match(candidate, /sign_crx: true/);
  assert.match(candidate, /image_tag: candidate-\$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(candidate, /image_tag: latest/);
  assert.match(candidate, /publish-candidate/);
  assert.match(candidate, /channel: prerelease/);
});

test("signed extension tooling is prepared only from a trusted ref", async () => {
  const text = await workflow("build-extension.yml");
  assert.match(text, /prepare-signer:/);
  assert.match(text, /ref: \$\{\{ inputs\.trusted_ref \|\| github\.sha \}\}/);
  assert.match(text, /pnpm --filter lurkloot deploy --legacy --dev signer/);
  assert.match(text, /needs: \[build, prepare-signer\]/);
  assert.doesNotMatch(text, /if: inputs\.sign_crx && inputs\.version != ''/);
});

test("docker separates workspace version overlays from image tags", async () => {
  const text = await workflow("build-docker.yml");
  assert.match(text, /image_tag:/);
  assert.match(text, /inputs\.image_tag \|\| inputs\.version \|\| 'validation'/);
  assert.match(text, /IMAGE_TAG: \$\{\{ inputs\.image_tag \|\| inputs\.version \}\}/);
});

test("stable promotion runs automatically with one production gate and a dedicated sync token", async () => {
  const text = await workflow("release.yml");
  assert.match(text, /pull_request:\n\s+types: \[closed\]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /github\.event\.pull_request\.merged/);
  assert.match(text, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/'\)/);
  assert.equal((text.match(/environment: production/g) ?? []).length, 1);
  assert.match(text, /export_oci: true/);
  assert.doesNotMatch(text, /image_tag: \$\{\{ needs\.resolve\.outputs\.version \}\}\n\s+push: true/);
  assert.match(text, /Verify and publish immutable stable image/);
  assert.match(text, /refusing to move immutable image/);
  assert.match(text, /uses: \.\/\.github\/actions\/build-site/);
  assert.match(text, /uses: \.\/\.github\/actions\/deploy-site/);
  assert.match(text, /RELEASE_SYNC_APP_ID/);
  assert.match(text, /RELEASE_SYNC_APP_PRIVATE_KEY/);
  assert.match(text, /cli\.mjs app-token/);
  assert.match(text, /cli\.mjs sync-branches/);
  assert.match(text, /retire-candidate/);
  assert.doesNotMatch(text, /gh pr create --base develop/);
});
