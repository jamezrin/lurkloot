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
  assert.match(yaml, /--force-with-lease="refs\/heads\/\$BRANCH:\$EXPECTED_REMOTE_SHA"/);
  assert.match(yaml, /verify-hotfix/);
  assert.match(yaml, /Chrome Web Store Developer Dashboard/);
  assert.match(yaml, /\$GITHUB_STEP_SUMMARY/);
  assert.match(yaml, /gh workflow run pr-validation\.yml --ref "\$BRANCH"/);
  assert.ok(yaml.indexOf("name: Upload CWS draft") < yaml.indexOf("name: Advance canonical release PR"));
  assert.ok(yaml.indexOf("name: Advance canonical release PR") < yaml.indexOf("name: Replace mutable prerelease"));
});

test("review workflows submit staged, cancel, and poll", async () => {
  const submit = await workflow("submit-candidate.yml");
  const cancel = await workflow("cancel-candidate.yml");
  const monitor = await workflow("monitor-cws.yml");
  assert.match(submit, /node scripts\/cws\.mjs submit-staged/);
  assert.match(submit, /environment: cws-review/);
  assert.match(submit, /metadata verify candidate\/candidate\.json candidate/);
  assert.match(submit, /extension-submission-verification/);
  assert.match(submit, /fresh.*chrome\.zip/i);
  assert.match(cancel, /node scripts\/cws\.mjs cancel-submission/);
  assert.match(cancel, /environment: cws-review/);
  assert.match(monitor, /cron: ['"]\*\/30 \* \* \* \*['"]/);
  assert.match(monitor, /cws-release-ready/);
  assert.match(monitor, /gh workflow run pr-validation\.yml --ref "\$branch"/);
});

test("promotion consumes stored artifacts without rebuilding", async () => {
  const yaml = await workflow("promote-release.yml");
  assert.match(yaml, /pull_request:/);
  assert.match(yaml, /types: \[closed\]/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /gh release download/);
  assert.match(yaml, /git diff --quiet "\$\{\{ github\.event\.pull_request\.head\.sha \}\}" "\$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}"/);
  assert.match(yaml, /metadata verify release-assets\/candidate\.json release-assets/);
  assert.match(yaml, /refs\/tags\/v\$version/);
  assert.match(yaml, /trusted-release-tools\/scripts\/cws\.mjs publish-stable/);
  assert.match(yaml, /node trusted-release-tools\/scripts\/cws\.mjs publish-stable/);
  assert.match(yaml, /Notify releaser when CWS is not publishable/);
  assert.match(yaml, /Announce stable publication/);
  assert.doesNotMatch(yaml, /build-extension\.yml|build-docker\.yml|pnpm zip|docker\/build-push-action/);
  assert.doesNotMatch(yaml, /git tag --force|git push --force/);
  assert.match(yaml, /channel: production\n      ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
});

test("site deployment uses explicit channel input", async () => {
  const yaml = await workflow("site-deploy.yml");
  assert.match(yaml, /channel:\n        type: string/);
  assert.match(yaml, /actions\/upload-artifact/);
  assert.match(yaml, /actions\/download-artifact/);
  assert.match(yaml, /persist-credentials: false/);
  assert.doesNotMatch(yaml, /release\.channel/);
});

test("candidate builds cannot access signing or deployment credentials", async () => {
  const extension = await workflow("build-extension.yml");
  const site = await workflow("site-deploy.yml");
  assert.match(extension, /finalize:\n    needs: build/);
  assert.match(site, /deploy:\n    needs: build/);
  assert.doesNotMatch(extension.match(/build:\n[\s\S]*?\n  finalize:/)?.[0] ?? "", /CRX_PRIVATE_KEY/);
  assert.doesNotMatch(site.match(/build:\n[\s\S]*?\n  deploy:/)?.[0] ?? "", /CLOUDFLARE_/);
});

test("legacy publisher and candidate tag are gone", async () => {
  await assert.rejects(workflow("release.yml"), /ENOENT/);
  const workflows = await Promise.all(["prepare-prerelease.yml", "submit-candidate.yml", "cancel-candidate.yml", "monitor-cws.yml", "promote-release.yml"].map(workflow));
  assert.doesNotMatch(workflows.join("\n"), /cws-v.*-candidate|release\.channel/);
});
