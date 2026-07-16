import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = (name) => readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

test("prepare workflow exposes controlled candidate inputs", async () => {
  const yaml = await workflow("prepare-prerelease.yml");
  for (const input of ["version:", "source_ref:", "release_kind:", "pr_number:"]) assert.match(yaml, new RegExp(`\\n      ${input}`));
  assert.match(yaml, /environment: prereleases/);
  assert.match(yaml, /group: prepare-candidate-/);
  assert.match(yaml, /node trusted-release-tools\/scripts\/cws\.mjs upload-candidate/);
  assert.match(yaml, /candidate\.json/);
  assert.match(yaml, /imagetools create --tag "\$IMAGE_NAME:\$VERSION" --tag "\$IMAGE_NAME:next"/);
  assert.match(yaml, /Mark older mutable candidates as superseded/);
});

test("review workflows submit staged, cancel, and poll", async () => {
  const submit = await workflow("submit-candidate.yml");
  const cancel = await workflow("cancel-candidate.yml");
  const monitor = await workflow("monitor-cws.yml");
  assert.match(submit, /node trusted-release-tools\/scripts\/cws\.mjs submit-staged/);
  assert.match(submit, /environment: cws-review/);
  assert.match(submit, /cd candidate && sha256sum --check SHA256SUMS/);
  assert.match(cancel, /node trusted-release-tools\/scripts\/cws\.mjs cancel-submission/);
  assert.match(cancel, /environment: cws-review/);
  assert.match(monitor, /cron: ['"]\*\/30 \* \* \* \*['"]/);
  assert.match(monitor, /cws-release-ready/);
});

test("promotion consumes stored artifacts without rebuilding", async () => {
  const yaml = await workflow("promote-release.yml");
  assert.match(yaml, /pull_request:/);
  assert.match(yaml, /types: \[closed\]/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /gh release download/);
  assert.match(yaml, /git diff --quiet "\$\{\{ github\.event\.pull_request\.head\.sha \}\}" "\$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}"/);
  assert.match(yaml, /cd release-assets && sha256sum --check SHA256SUMS/);
  assert.match(yaml, /node scripts\/cws\.mjs publish-stable/);
  assert.doesNotMatch(yaml, /build-extension\.yml|build-docker\.yml|pnpm zip|docker\/build-push-action/);
  assert.doesNotMatch(yaml, /git tag --force|git push --force/);
});

test("site deployment uses explicit channel input", async () => {
  const yaml = await workflow("site-deploy.yml");
  assert.match(yaml, /channel:\n        type: string/);
  assert.doesNotMatch(yaml, /release\.channel/);
});

test("legacy publisher and candidate tag are gone", async () => {
  await assert.rejects(workflow("release.yml"), /ENOENT/);
  const workflows = await Promise.all(["prepare-prerelease.yml", "submit-candidate.yml", "cancel-candidate.yml", "monitor-cws.yml", "promote-release.yml"].map(workflow));
  assert.doesNotMatch(workflows.join("\n"), /cws-v.*-candidate|release\.channel/);
});
