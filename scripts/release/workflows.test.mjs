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
