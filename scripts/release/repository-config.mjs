import { requiredMainStatusContexts, validationStatusContexts } from "./checks.mjs";

const actionsAppId = 15368;

export function repositoryPatch() {
  return {
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
    merge_commit_title: "PR_TITLE",
    merge_commit_message: "PR_BODY",
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  };
}

function pullRequestRule(mergeMethod) {
  return {
    type: "pull_request",
    parameters: {
      allowed_merge_methods: [mergeMethod],
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: false,
    },
  };
}

function statusRule(contexts) {
  return {
    type: "required_status_checks",
    parameters: {
      do_not_enforce_on_create: false,
      strict_required_status_checks_policy: true,
      required_status_checks: contexts.map((context) => ({ context, integration_id: actionsAppId })),
    },
  };
}

function branchRuleset({ name, branch, mergeMethod, statusContexts, bypass_actors = [] }) {
  return {
    name,
    target: "branch",
    enforcement: "active",
    bypass_actors,
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      pullRequestRule(mergeMethod),
      statusRule(statusContexts),
    ],
  };
}

export function mainRuleset() {
  return branchRuleset({
    name: "main release history",
    branch: "main",
    mergeMethod: "merge",
    statusContexts: requiredMainStatusContexts,
  });
}

export function developRuleset(syncAppId) {
  const actorId = Number(syncAppId);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error("sync App ID must be a positive integer");
  return branchRuleset({
    name: "develop squash history",
    branch: "develop",
    mergeMethod: "squash",
    statusContexts: validationStatusContexts,
    bypass_actors: [{ actor_id: actorId, actor_type: "Integration", bypass_mode: "always" }],
  });
}

function comparableRuleset(value) {
  return {
    name: value.name,
    target: value.target,
    enforcement: value.enforcement,
    bypass_actors: value.bypass_actors ?? [],
    conditions: value.conditions,
    rules: value.rules,
  };
}

function assertRuleset(actual, expected) {
  if (JSON.stringify(comparableRuleset(actual)) !== JSON.stringify(expected)) {
    throw new Error(`ruleset ${expected.name} did not read back with the requested configuration`);
  }
}

async function reconcileRuleset(client, existing, desired) {
  if (existing) {
    await client.request(client.repoPath(`/rulesets/${existing.id}`), { method: "PUT", body: desired });
    return existing.id;
  }
  const created = await client.request(client.repoPath("/rulesets"), { method: "POST", body: desired });
  return created.id;
}

export async function applyRepositoryConfig({ client, syncAppId }) {
  const desired = [mainRuleset(), developRuleset(syncAppId)];
  await client.request(client.repoPath(""), { method: "PATCH", body: repositoryPatch() });
  const current = await client.request(client.repoPath("/rulesets"));
  const ids = [];
  for (const ruleset of desired) {
    ids.push(await reconcileRuleset(client, current.find(({ name }) => name === ruleset.name), ruleset));
  }
  for (let index = 0; index < desired.length; index += 1) {
    const actual = await client.request(client.repoPath(`/rulesets/${ids[index]}`));
    assertRuleset(actual, desired[index]);
  }
  for (const branch of ["main", "develop"]) {
    await client.request(client.repoPath(`/branches/${branch}/protection`), {
      method: "DELETE",
      allowNotFound: true,
    });
  }
  return { repository: repositoryPatch(), rulesets: desired };
}

export function repositoryConfiguration(syncAppId) {
  return { repository: repositoryPatch(), rulesets: [mainRuleset(), developRuleset(syncAppId)] };
}
