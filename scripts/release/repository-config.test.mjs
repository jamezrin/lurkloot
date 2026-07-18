import test from "node:test";
import assert from "node:assert/strict";
import { applyRepositoryConfig, developRuleset, mainRuleset, repositoryPatch } from "./repository-config.mjs";

const checks = [
  "verify",
  "extension / build",
  "docker / build (linux/amd64, ubuntu-latest, amd64)",
  "docker / build (linux/arm64, ubuntu-24.04-arm, arm64)",
  "release candidate / ready",
];

function rule(ruleset, type) {
  return ruleset.rules.find((entry) => entry.type === type);
}

test("enables merge and squash while disabling repository-wide rebase", () => {
  assert.deepEqual(repositoryPatch(), {
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
    merge_commit_title: "PR_TITLE",
    merge_commit_message: "PR_BODY",
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  });
});

test("main permits only merge commits and retains required checks", () => {
  const ruleset = mainRuleset();
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/main"]);
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(rule(ruleset, "pull_request").parameters.allowed_merge_methods, ["merge"]);
  assert.deepEqual(
    rule(ruleset, "required_status_checks").parameters.required_status_checks.map(({ context }) => context),
    checks,
  );
  assert.ok(rule(ruleset, "non_fast_forward"));
  assert.ok(rule(ruleset, "deletion"));
  assert.equal(rule(ruleset, "required_linear_history"), undefined);
});

test("develop permits squash PRs and only the dedicated App bypasses", () => {
  const ruleset = developRuleset(98765);
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/develop"]);
  assert.deepEqual(ruleset.bypass_actors, [{
    actor_id: 98765,
    actor_type: "Integration",
    bypass_mode: "always",
  }]);
  assert.deepEqual(rule(ruleset, "pull_request").parameters.allowed_merge_methods, ["squash"]);
  assert.equal(JSON.stringify(ruleset.bypass_actors).includes("15368"), false);
  assert.equal(rule(ruleset, "required_linear_history"), undefined);
});

test("rejects an invalid synchronization App ID", () => {
  assert.throws(() => developRuleset(0), /positive integer/);
  assert.throws(() => developRuleset("github-actions"), /positive integer/);
});

test("removes classic protection only after both rulesets read back", async () => {
  const calls = [];
  const desired = [mainRuleset(), developRuleset(98765)];
  const client = {
    repoPath: (path) => `/repos/jamezrin/lurkloot${path}`,
    async request(path, init = {}) {
      calls.push({ path, init });
      if (path.endsWith("/rulesets") && !init.method) return [];
      if (path.endsWith("/rulesets") && init.method === "POST") {
        const index = calls.filter((call) => call.init.method === "POST").length - 1;
        return { id: index + 10, ...desired[index] };
      }
      if (/\/rulesets\/1[01]$/.test(path)) return desired[Number(path.at(-1)) - 0];
      return {};
    },
  };
  await applyRepositoryConfig({ client, syncAppId: 98765 });
  const deletes = calls.filter(({ init }) => init.method === "DELETE");
  assert.deepEqual(deletes.map(({ path }) => path), [
    "/repos/jamezrin/lurkloot/branches/main/protection",
    "/repos/jamezrin/lurkloot/branches/develop/protection",
  ]);
  const lastRulesetRead = calls.map(({ path }) => path).findLastIndex((path) => path.includes("/rulesets/"));
  const firstDelete = calls.findIndex(({ init }) => init.method === "DELETE");
  assert.ok(lastRulesetRead < firstDelete);
});
