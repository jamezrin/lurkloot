import assert from "node:assert/strict";
import test from "node:test";
import { encodeAuthorization } from "./authorization.mjs";
import { candidateMetadata } from "./fixtures/candidate.mjs";
import { inspectReleasePr } from "./inspect.mjs";

const sha = (char) => char.repeat(40);
const head = sha("a");
const stable = sha("b");
const develop = sha("c");

const botComment = (body, id = 1) => ({ id, user: { login: "github-actions[bot]", type: "Bot" }, body });
const labelEvent = (id, action, label, actor) => ({ id, event: action, label: { name: label }, actor: { login: actor } });

function fakeClient({
  labels = ["release/minor"],
  draft = true,
  state = "open",
  mergedAt = null,
  headSha = head,
  baseRef = "main",
  repoFullName = "owner/repo",
  permissions = { "admin-user": "admin" },
  events = [],
  comments = [],
  candidate = null,
  developCommits = [],
  candidateCommits = [],
  mainAncestor = true,
  developAncestor = true,
} = {}) {
  const calls = { created: [], updated: [] };
  const client = {
    repo: "owner/repo",
    calls,
    pullRequest: async () => ({
      head: { sha: headSha, repo: { full_name: repoFullName } },
      base: { ref: baseRef },
      draft,
      state,
      merged_at: mergedAt,
      labels: labels.map((name) => ({ name })),
    }),
    refSha: async (ref) => (ref === "main" ? stable : develop),
    fileAtRef: async () => JSON.stringify({ version: "1.4.0" }),
    isAncestor: async (base) => (base === stable ? mainAncestor : developAncestor),
    compare: async (base, target) => ({
      status: "ahead",
      commits: target === develop ? developCommits : candidateCommits,
    }),
    issueEvents: async () => events,
    issueComments: async () => comments,
    collaboratorPermission: async (login) => permissions[login] ?? "none",
    createComment: async (pr, body) => { calls.created.push(body); return { id: 99 }; },
    updateComment: async (id, body) => { calls.updated.push({ id, body }); return { id }; },
    releases: async () => (candidate ? [{
      tag_name: `v${candidate.version}`,
      name: `v${candidate.version}`,
      draft: false,
      prerelease: true,
      assets: [{ name: "candidate.json", url: "https://api.github.com/asset/1" }],
    }] : []),
    releaseAsset: async () => JSON.stringify(candidate),
  };
  return client;
}

const labeled = { action: "labeled", actor: "admin-user", label: "release/minor" };

test("an administrator labelling an unlabelled PR prepares a candidate and mints authorization", async () => {
  const client = fakeClient({ events: [labelEvent(7, "labeled", "release/minor", "admin-user")] });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });

  assert.equal(result.action, "prepare");
  assert.equal(result.version, "1.5.0");
  assert.equal(result.kind, "normal");
  assert.equal(result.release_label, "release/minor");
  assert.equal(result.authorized_by, "admin-user");
  // A fresh label has no approved SHA, so this head must be approved before any mutation.
  assert.equal(result.state, "awaiting-approval");
  assert.equal(result.milestone, "environment-approval");
  assert.equal(client.calls.created.length, 1);
  assert.match(client.calls.created[0], /^<!-- lurkloot-release-label-authorization:/);
});

test("a non-administrator label transition is blocked and mints nothing", async () => {
  const client = fakeClient({
    permissions: { dev: "write" },
    events: [labelEvent(7, "labeled", "release/minor", "dev")],
  });
  const result = await inspectReleasePr(client, {
    pr: 120,
    event: { action: "labeled", actor: "dev", label: "release/minor" },
  });

  assert.equal(result.action, "block");
  assert.match(result.reason, /not an administrator/);
  assert.equal(result.convert_to_draft, false);
  assert.equal(client.calls.created.length, 0);
});

test("a label transition that is not the newest event is blocked", async () => {
  const client = fakeClient({
    events: [
      labelEvent(7, "labeled", "release/minor", "admin-user"),
      labelEvent(8, "unlabeled", "release/minor", "someone-else"),
    ],
  });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  assert.equal(result.action, "block");
  assert.equal(client.calls.created.length, 0);
});

test("two release labels block regardless of authorization", async () => {
  const client = fakeClient({
    labels: ["release/minor", "release/patch"],
    events: [labelEvent(7, "labeled", "release/minor", "admin-user")],
  });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  assert.equal(result.action, "block");
  assert.equal(result.convert_to_draft, false);
});

test("an unlabelled PR stays inert", async () => {
  const client = fakeClient({ labels: [] });
  const result = await inspectReleasePr(client, { pr: 120, event: { action: "synchronize", actor: "", label: "" } });
  assert.equal(result.action, "none");
  assert.equal(result.state, "inactive");
});

test("a cross-repository PR is blocked", async () => {
  const client = fakeClient({
    repoFullName: "fork/repo",
    events: [labelEvent(7, "labeled", "release/minor", "admin-user")],
  });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  assert.equal(result.action, "block");
  assert.match(result.reason, /same-repository PR to main/);
});

test("a push recovers authorization from the stored snapshot", async () => {
  const record = {
    schema: 2,
    pr: 120,
    headSha: head,
    labels: ["release/minor"],
    authorizedBy: "admin-user",
    eventId: 7,
    eventAction: "labeled",
    eventLabel: "release/minor",
    createdAt: "2026-07-17T00:00:00Z",
  };
  const client = fakeClient({
    events: [labelEvent(7, "labeled", "release/minor", "admin-user")],
    comments: [botComment(encodeAuthorization(record))],
    candidate: candidateMetadata(),
  });
  const result = await inspectReleasePr(client, { pr: 120, event: { action: "synchronize", actor: "", label: "" } });

  assert.equal(result.authorized_by, "admin-user");
  assert.equal(result.candidate_version, "1.5.0");
  // Candidate authorizedSha equals this head, so no re-approval is demanded.
  assert.equal(result.state, "active");
  assert.equal(result.milestone, "");
});

test("a stored snapshot bound to a superseded label event does not authorize", async () => {
  const record = {
    schema: 2,
    pr: 120,
    headSha: head,
    labels: ["release/minor"],
    authorizedBy: "admin-user",
    eventId: 7,
    eventAction: "labeled",
    eventLabel: "release/minor",
    createdAt: "2026-07-17T00:00:00Z",
  };
  const client = fakeClient({
    events: [
      labelEvent(7, "labeled", "release/minor", "admin-user"),
      labelEvent(8, "labeled", "release/patch", "admin-user"),
    ],
    comments: [botComment(encodeAuthorization(record))],
  });
  const result = await inspectReleasePr(client, { pr: 120, event: { action: "synchronize", actor: "", label: "" } });
  assert.equal(result.action, "block");
});

test("a candidate whose label no longer matches the PR is blocked without fresh authorization", async () => {
  const client = fakeClient({
    labels: ["release/major"],
    events: [labelEvent(7, "labeled", "release/minor", "admin-user")],
    candidate: candidateMetadata(),
  });
  const result = await inspectReleasePr(client, { pr: 120, event: { action: "synchronize", actor: "", label: "" } });
  assert.equal(result.action, "block");
  assert.match(result.reason, /label snapshot lacks current administrator authorization/);
});

test("a hotfix carrying an unreleased develop commit is blocked", async () => {
  const client = fakeClient({
    labels: ["release/hotfix"],
    developAncestor: false,
    developCommits: ["leaked-sha", "other"],
    candidateCommits: ["leaked-sha"],
    events: [labelEvent(7, "labeled", "release/hotfix", "admin-user")],
  });
  const result = await inspectReleasePr(client, {
    pr: 120,
    event: { action: "labeled", actor: "admin-user", label: "release/hotfix" },
  });
  assert.equal(result.action, "block");
  assert.match(result.reason, /unreleased develop commit leaked-sha/);
});

test("a clean hotfix off main derives a patch version", async () => {
  const client = fakeClient({
    labels: ["release/hotfix"],
    developAncestor: false,
    developCommits: ["unrelated"],
    candidateCommits: ["hotfix-sha"],
    events: [labelEvent(7, "labeled", "release/hotfix", "admin-user")],
  });
  const result = await inspectReleasePr(client, {
    pr: 120,
    event: { action: "labeled", actor: "admin-user", label: "release/hotfix" },
  });
  assert.equal(result.action, "prepare");
  assert.equal(result.kind, "hotfix");
  assert.equal(result.version, "1.4.1");
});

test("a candidate not descending from main is blocked", async () => {
  const client = fakeClient({
    mainAncestor: false,
    events: [labelEvent(7, "labeled", "release/minor", "admin-user")],
  });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  assert.equal(result.action, "block");
  assert.match(result.reason, /must descend from main/);
});

test("stable and trusted tooling refs resolve from one ref and cannot diverge", async () => {
  const client = fakeClient({ events: [labelEvent(7, "labeled", "release/minor", "admin-user")] });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  assert.equal(result.stable_sha, stable);
  assert.equal(result.trusted_tools_ref, stable);
  assert.equal(result.stable_version, "1.4.0");
  assert.equal(result.develop_sha, develop);
});

test("outputs carry no line breaks so workflow outputs stay well formed", async () => {
  const client = fakeClient({ events: [labelEvent(7, "labeled", "release/minor", "admin-user")] });
  const result = await inspectReleasePr(client, { pr: 120, event: labeled });
  for (const [key, value] of Object.entries(result)) {
    assert.doesNotMatch(String(value ?? ""), /\r|\n/, `${key} must be single-line`);
  }
});

test("a head that is not a commit SHA is rejected before any decision", async () => {
  const client = fakeClient({ headSha: "not-a-sha" });
  await assert.rejects(inspectReleasePr(client, { pr: 120, event: labeled }), /head did not resolve/);
});
