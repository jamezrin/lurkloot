import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// These tests guard privilege boundaries that live in workflow structure, not in shell code: which
// events are trusted, which jobs may hold secrets or write, and where candidate code is allowed to
// run. They deliberately assert only YAML-structural facts (triggers, permissions, environments,
// checkout refs) — never bash internals — so they catch a job silently gaining write access or a
// secret without pinning any implementation detail.

const workflow = (name) => readFile(`.github/workflows/${name}`, "utf8");

// Slices a single top-level job's block out of a workflow, from its `  name:` line up to the next
// two-space-indented `  name:` key (or end of file).
function jobBlock(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = text.slice(start + 1);
  const next = rest.slice(`  ${name}:\n`.length).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, `  ${name}:\n`.length + next);
}

test("the controller only reacts to trusted pull_request_target events", async () => {
  const text = await workflow("reconcile-release-pr.yml");
  assert.match(text, /on:\n {2}pull_request_target:/);
  // A default read-only token at the top of a pull_request_target workflow keeps any job that does
  // not explicitly widen it from touching repository state.
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
});

test("the controller never checks out candidate head code", async () => {
  const text = await workflow("reconcile-release-pr.yml");
  for (const ref of text.matchAll(/ref: \$\{\{ ([^}]+) \}\}/g)) {
    assert.doesNotMatch(ref[1], /head/, `checkout ref ${ref[1].trim()} must not reference the PR head`);
  }
  // Base tooling only: any checkout that pins a ref pins the PR base commit.
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  // A full-history fetch would place untrusted candidate history on the privileged runner.
  assert.doesNotMatch(text, /fetch-depth:/);
  assert.doesNotMatch(text, /persist-credentials: true/);
});

test("candidate code builds without secrets or write access", async () => {
  const text = await workflow("build-extension.yml");
  const build = jobBlock(text, "build");
  // The build job runs the candidate's own package scripts, so it must carry no credentials and no
  // write scope of any kind.
  assert.doesNotMatch(build, /secrets\./);
  assert.doesNotMatch(build, /CRX_PRIVATE_KEY|CWS_|CLOUDFLARE/);
  assert.doesNotMatch(build, /contents:\s*write|packages:\s*write/);
  assert.doesNotMatch(build, /environment:/);
  assert.doesNotMatch(build, /docker\/login-action/);

  // Signing with the CRX key is confined to the finalize job, which is gated on the prereleases
  // environment whenever signing is requested (the environment may be expressed conditionally so
  // that unsigned validation runs are not gated).
  const finalize = jobBlock(text, "finalize");
  assert.match(finalize, /environment:.*prereleases/);
  assert.match(finalize, /CRX_PRIVATE_KEY: \$\{\{ secrets\.CRX_PRIVATE_KEY \}\}/);
});

test("every publishing mutation is gated by a protected environment", async () => {
  const gates = [
    ["prepare-prerelease.yml", "publish", "prereleases"],
    ["build-extension.yml", "finalize", "prereleases"],
    ["build-docker.yml", "publish", "prereleases"],
    ["submit-candidate.yml", "submit", "cws-review"],
    ["cancel-candidate.yml", "cancel", "cws-review"],
    ["promote-release.yml", "publish", "stable-releases"],
  ];
  for (const [file, job, environment] of gates) {
    const block = jobBlock(await workflow(file), job);
    // Accepts the plain form, the `name:` form, and a conditional expression that names the
    // environment (used where the gate applies only to the privileged variant of the job).
    assert.match(block, new RegExp(`environment:[^\\n]*${environment}|environment:\\s*\\n\\s+name:\\s*${environment}`),
      `${file} job ${job} must deploy to the ${environment} environment`);
  }
});

test("the controller job that mutates issues carries no release secrets", async () => {
  const text = await workflow("reconcile-release-pr.yml");
  // The inspect job reads live state and posts comments with the default token; release secrets are
  // only ever passed to the reusable publishing workflows it calls.
  const inspect = jobBlock(text, "inspect");
  assert.doesNotMatch(inspect, /secrets\.[A-Z]/);
});
