import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDigestFilenames,
  assertPrepareInputs,
  assertPreparePullRequest,
  assertSameRepository,
  canonicalReleaseNotes,
  cwsRollbackAction,
  ownsCanonicalReferences,
  selectRunOwnedContainerVersion,
  stagingReleaseNotes,
} from "./prepare.mjs";

const sha = (char) => char.repeat(40);
const head = sha("a");

const live = (overrides = {}) => ({
  head: { sha: head, repo: { full_name: "owner/repo" } },
  base: { ref: "main" },
  state: "open",
  labels: [{ name: "release/minor" }],
  ...overrides,
});

test("controller inputs must agree before any build runs", () => {
  const base = { expectedSha: head, trustedTools: sha("b"), version: "1.5.0", kind: "normal", label: "release/minor" };
  assert.doesNotThrow(() => assertPrepareInputs(base));
  assert.throws(() => assertPrepareInputs({ ...base, expectedSha: "abc" }), /expected head SHA/);
  assert.throws(() => assertPrepareInputs({ ...base, trustedTools: "abc" }), /trusted tools ref/);
  assert.throws(() => assertPrepareInputs({ ...base, version: "1.5" }), /stable SemVer/);
});

test("a kind and label that disagree are rejected", () => {
  const base = { expectedSha: head, trustedTools: sha("b"), version: "1.5.0" };
  assert.doesNotThrow(() => assertPrepareInputs({ ...base, kind: "hotfix", label: "release/hotfix" }));
  assert.throws(() => assertPrepareInputs({ ...base, kind: "normal", label: "release/hotfix" }), /does not permit/);
  assert.throws(() => assertPrepareInputs({ ...base, kind: "hotfix", label: "release/minor" }), /does not permit/);
  assert.throws(() => assertPrepareInputs({ ...base, kind: "other", label: "release/minor" }), /does not permit/);
});

test("every canonical write requires the authorized PR identity", () => {
  const expected = { expectedSha: head, expectedLabel: "release/minor" };
  assert.equal(assertPreparePullRequest(live(), expected), "release/minor");
  assert.throws(() => assertPreparePullRequest(live({ head: { sha: sha("f") } }), expected), /head identity changed/);
  assert.throws(() => assertPreparePullRequest(live({ state: "closed" }), expected), /must remain open/);
  assert.throws(() => assertPreparePullRequest(live({ base: { ref: "develop" } }), expected), /must target main/);
  assert.throws(() => assertPreparePullRequest(live({ labels: [] }), expected), /exactly one recognized release label/);
  assert.throws(() => assertPreparePullRequest(live({ labels: [{ name: "release/major" }] }), expected), /does not match release\/minor/);
});

test("a fork PR never publishes", () => {
  assert.throws(() => assertSameRepository(live({ head: { sha: head, repo: { full_name: "fork/repo" } } }), "owner/repo"), /same-repository/);
  assert.doesNotThrow(() => assertSameRepository(live(), "owner/repo"));
});

test("exactly one well-formed docker digest artifact is required", () => {
  assert.equal(assertDigestFilenames(["a".repeat(64)]), "a".repeat(64));
  assert.throws(() => assertDigestFilenames([]), /exactly one Docker digest artifact, found 0/);
  assert.throws(() => assertDigestFilenames(["a".repeat(64), "b".repeat(64)]), /found 2/);
  assert.throws(() => assertDigestFilenames(["latest"]), /not a SHA-256 value/);
});

test("release notes name the run and the candidate", () => {
  assert.equal(stagingReleaseNotes({ version: "1.5.0", runId: "9", runAttempt: "1" }),
    "Immutable staging candidate for v1.5.0 from run 9/1.");
  assert.equal(canonicalReleaseNotes({ pr: 120, sourceSha: head, stagingId: "candidate-9-1" }),
    `Mutable candidate from PR #120 at ${head} (staged as candidate-9-1).`);
});

// Rollback must never revert references another run has taken ownership of.
test("rollback only claims references this run still owns", () => {
  const base = { currentTagSha: head, expectedSha: head, candidateSourceSha: head, releaseBody: "x", stagingId: "candidate-9-1" };
  assert.equal(ownsCanonicalReferences(base), true);
  assert.equal(ownsCanonicalReferences({ ...base, currentTagSha: sha("f") }), false, "another run moved the tag");
  assert.equal(ownsCanonicalReferences({ ...base, candidateSourceSha: sha("f") }), false, "candidate belongs to another source");
  // A body naming this run's staging id still proves ownership when the candidate is unreadable.
  assert.equal(ownsCanonicalReferences({ ...base, candidateSourceSha: null, releaseBody: "staged as candidate-9-1" }), true);
  assert.equal(ownsCanonicalReferences({ ...base, candidateSourceSha: null, releaseBody: "unrelated" }), false);
});

test("only an exclusively run-owned container version is deletable", () => {
  const staged = "sha256:abc";
  const versions = [{ id: 5, name: staged, metadata: { container: { tags: ["1.5.0", "next", "candidate-9-1"] } } }];
  const args = { stagedDigest: staged, version: "1.5.0", stagingId: "candidate-9-1", aliases: ["1.5.0", "next"] };
  assert.equal(selectRunOwnedContainerVersion(versions, args), 5);

  const shared = [{ id: 5, name: staged, metadata: { container: { tags: ["1.5.0", "candidate-9-1", "latest"] } } }];
  assert.equal(selectRunOwnedContainerVersion(shared, { ...args, aliases: ["1.5.0"] }), null, "an unrelated tag blocks deletion");

  const missingStaging = [{ id: 5, name: staged, metadata: { container: { tags: ["1.5.0", "next"] } } }];
  assert.equal(selectRunOwnedContainerVersion(missingStaging, args), null, "not provably this run's version");

  assert.equal(selectRunOwnedContainerVersion(versions, { ...args, stagedDigest: "sha256:other" }), null);
});

test("an ambiguous container match deletes nothing", () => {
  const staged = "sha256:abc";
  const versions = [
    { id: 5, name: staged, metadata: { container: { tags: ["1.5.0", "candidate-9-1"] } } },
    { id: 6, name: staged, metadata: { container: { tags: ["1.5.0", "candidate-9-1"] } } },
  ];
  assert.equal(selectRunOwnedContainerVersion(versions, {
    stagedDigest: staged, version: "1.5.0", stagingId: "candidate-9-1", aliases: ["1.5.0"],
  }), null);
});

test("CWS rollback refuses when ownership moved on", () => {
  assert.equal(cwsRollbackAction({ currentSubmittedVersion: "1.6.0", version: "1.5.0", priorExisted: true }), "stale");
  assert.equal(cwsRollbackAction({ currentSubmittedVersion: "1.5.0", version: "1.5.0", priorExisted: true }), "restore");
  assert.equal(cwsRollbackAction({ currentSubmittedVersion: "none", version: "1.5.0", priorExisted: true }), "restore");
  assert.equal(cwsRollbackAction({ currentSubmittedVersion: "none", version: "1.5.0", priorExisted: false }), "blocked");
});
