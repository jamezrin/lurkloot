import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKERS_AI_SECRET = /WORKERS_AI_API_TOKEN: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/;

function jobSection(workflowText, jobId) {
  const match = workflowText.match(new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:|$)`));
  return match?.[1] ?? "";
}

function buildReleaseCandidateInvocations(workflowText) {
  const marker = "uses: ./.github/workflows/build-release-candidate.yml";
  const parts = workflowText.split(marker);
  return parts.slice(1).map((segment, index) => {
    const secretsMatch = segment.match(/^\s*with:[\s\S]*?\n\s*secrets:\n([\s\S]*?)(?=\n\S|$)/);
    assert.ok(secretsMatch, `build-release-candidate invocation ${index + 1} missing secrets block`);
    return secretsMatch[1];
  });
}

test("Workers AI credentials stay on trusted production site builds", async () => {
  const deploy = await readFile(new URL("../../../.github/workflows/site-deploy.yml", import.meta.url), "utf8");
  const action = await readFile(new URL("../../../.github/actions/build-site/action.yml", import.meta.url), "utf8");
  const candidate = await readFile(new URL("../../../.github/workflows/build-release-candidate.yml", import.meta.url), "utf8");
  const prepare = await readFile(new URL("../../../.github/workflows/prepare-release.yml", import.meta.url), "utf8");
  const refresh = await readFile(new URL("../../../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
  const release = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
  const prValidation = await readFile(new URL("../../../.github/workflows/pr-validation.yml", import.meta.url), "utf8");

  assert.match(action, /workers_ai_token/);
  assert.match(action, /pnpm --filter @lurkloot\/site translate/);
  assert.doesNotMatch(action, /CLOUDFLARE_API_TOKEN/);

  const deployBuild = jobSection(deploy, "build");
  assert.match(deployBuild, /workers_ai_token:/);
  assert.match(deployBuild, /secrets\.WORKERS_AI_API_TOKEN/);
  assert.match(deployBuild, /inputs\.channel == 'production'/);
  assert.doesNotMatch(jobSection(deploy, "deploy"), /WORKERS_AI_API_TOKEN/);

  assert.match(release, /workers_ai_token: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.doesNotMatch(jobSection(release, "publish"), /WORKERS_AI_API_TOKEN/);
  assert.doesNotMatch(prValidation, /WORKERS_AI_API_TOKEN/);

  assert.match(candidate, /WORKERS_AI_API_TOKEN:\n\s+required: false/);
  assert.doesNotMatch(jobSection(candidate, "site"), WORKERS_AI_SECRET);

  const prepareInvocations = buildReleaseCandidateInvocations(prepare);
  assert.equal(prepareInvocations.length, 2, "prepare-release should call build-release-candidate twice");
  for (const secrets of prepareInvocations) {
    assert.doesNotMatch(secrets, WORKERS_AI_SECRET);
  }

  const refreshInvocations = buildReleaseCandidateInvocations(refresh);
  assert.equal(refreshInvocations.length, 1, "release-candidate should call build-release-candidate once");
  for (const secrets of refreshInvocations) {
    assert.doesNotMatch(secrets, WORKERS_AI_SECRET);
  }
});
