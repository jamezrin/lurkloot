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
  assert.match(candidate, /permissions:\n\s+contents: read/);
  assert.match(candidate, /pnpm check/);
  assert.match(candidate, /sign_crx: true/);
  assert.match(candidate, /image_tag: candidate-\$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(candidate, /image_tag: latest/);
  assert.match(candidate, /publish-candidate/);
  assert.match(candidate, /channel: prerelease/);
});

test("docker separates workspace version overlays from image tags", async () => {
  const text = await workflow("build-docker.yml");
  assert.match(text, /image_tag:/);
  assert.match(text, /inputs\.image_tag \|\| inputs\.version \|\| 'validation'/);
  assert.match(text, /IMAGE_TAG: \$\{\{ inputs\.image_tag \|\| inputs\.version \}\}/);
});
