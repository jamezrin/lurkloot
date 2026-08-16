import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("site-deploy passes Workers AI credentials only into build-site", async () => {
  const deploy = await readFile(new URL("../../../.github/workflows/site-deploy.yml", import.meta.url), "utf8");
  const action = await readFile(new URL("../../../.github/actions/build-site/action.yml", import.meta.url), "utf8");
  const candidate = await readFile(new URL("../../../.github/workflows/build-release-candidate.yml", import.meta.url), "utf8");
  const prepare = await readFile(new URL("../../../.github/workflows/prepare-release.yml", import.meta.url), "utf8");
  const refresh = await readFile(new URL("../../../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
  const release = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(action, /workers_ai_token/);
  assert.match(action, /pnpm --filter @lurkloot\/site translate/);
  assert.match(deploy, /workers_ai_token: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.doesNotMatch(deploy.split("\n  deploy:")[1] ?? "", /WORKERS_AI_API_TOKEN/);
  assert.match(candidate, /WORKERS_AI_API_TOKEN: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.match(prepare, /WORKERS_AI_API_TOKEN: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.match(refresh, /WORKERS_AI_API_TOKEN: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.match(release, /workers_ai_token: \$\{\{ secrets\.WORKERS_AI_API_TOKEN \}\}/);
  assert.doesNotMatch(release.split("\n  publish:")[1] ?? "", /WORKERS_AI_API_TOKEN/);
});
