import assert from "node:assert/strict";
import test from "node:test";
import {
  assertForwardInputs,
  forwardBranch,
  forwardConflictIssue,
  forwardMergeMessage,
  forwardPullRequest,
  forwardSummary,
} from "./forward.mjs";

const sha = (char) => char.repeat(40);

test("forward inputs are validated before any branch is created", () => {
  const base = { kind: "normal", expectedMainSha: sha("a"), version: "1.5.0" };
  assert.doesNotThrow(() => assertForwardInputs(base));
  assert.doesNotThrow(() => assertForwardInputs({ ...base, kind: "hotfix" }));
  assert.throws(() => assertForwardInputs({ ...base, kind: "release" }), /normal or hotfix/);
  assert.throws(() => assertForwardInputs({ ...base, expectedMainSha: "abc" }), /commit SHA/);
  assert.throws(() => assertForwardInputs({ ...base, version: "1.5" }), /stable SemVer/);
});

test("branch and merge identities name the release", () => {
  assert.equal(forwardBranch("1.5.0"), "chore/forward-release-1.5.0");
  assert.equal(forwardMergeMessage({ kind: "hotfix", version: "1.4.1" }), "chore: forward hotfix release 1.4.1");
});

test("the synchronization PR explains what it carries", () => {
  const pr = forwardPullRequest({ kind: "normal", version: "1.5.0" });
  assert.equal(pr.title, "chore: forward release 1.5.0");
  assert.match(pr.body, /Carries stable normal release v1\.5\.0 metadata/);
});

test("a conflict escalates with resolution instructions that protect main", () => {
  const issue = forwardConflictIssue({ kind: "hotfix", version: "1.4.1" });
  assert.equal(issue.title, "chore: forward release 1.4.1 to develop");
  assert.match(issue.body, /resolve the conflicts without changing main/);
});

test("summaries distinguish existing, conflicted, and opened outcomes", () => {
  assert.match(forwardSummary({ version: "1.5.0", outcome: "exists", pr: 7 }), /already exists as PR #7; leaving it unchanged/);
  assert.match(forwardSummary({ version: "1.5.0", outcome: "exists", pr: null }), /already exists; leaving it unchanged/);
  assert.match(forwardSummary({ version: "1.5.0", outcome: "conflict", issueUrl: "https://x/9" }), /conflicted\. Follow https:\/\/x\/9/);
  assert.match(forwardSummary({ version: "1.5.0", outcome: "opened", pr: 8 }), /Opened or refreshed PR #8/);
});
