import assert from "node:assert/strict";
import test from "node:test";
import { candidateMetadata } from "./fixtures/candidate.mjs";
import {
  assertCandidateOwnership,
  assertEvidenceMatches,
  assertPullRequestState,
  assertSubmitAction,
  buildSubmissionEvidence,
  recognizedLabel,
  submissionNarrative,
} from "./submission.mjs";

const sha = (char) => char.repeat(40);
const head = sha("a");

const livePr = (overrides = {}) => ({
  head: { sha: head },
  state: "open",
  draft: false,
  labels: [{ name: "release/minor" }],
  ...overrides,
});

const evidenceInput = {
  version: "1.5.0",
  sourceSha: head,
  headSha: head,
  label: "release/minor",
  trustedToolsSha: sha("b"),
  freshChromeSha256: "a".repeat(64),
  assetChecksums: { "lurkloot-1.5.0-chrome.zip": "a".repeat(64) },
};
const expectation = {
  version: "1.5.0",
  sourceSha: head,
  headSha: head,
  label: "release/minor",
  trustedToolsSha: sha("b"),
  chromeZipSha256: "a".repeat(64),
  assetChecksums: { "lurkloot-1.5.0-chrome.zip": "a".repeat(64) },
};

test("exactly one recognized release label is required", () => {
  assert.equal(recognizedLabel(["bug", "release/minor"]), "release/minor");
  assert.throws(() => recognizedLabel(["bug"]), /exactly one recognized release label/);
  assert.throws(() => recognizedLabel(["release/minor", "release/patch"]), /exactly one recognized release label/);
});

test("a drifted pull request stops submission", () => {
  const expected = { expectedSha: head, expectedLabel: "release/minor" };
  assert.equal(assertPullRequestState(livePr(), expected), "release/minor");
  assert.throws(() => assertPullRequestState(livePr({ head: { sha: sha("f") } }), expected), /head identity changed/);
  assert.throws(() => assertPullRequestState(livePr({ state: "closed" }), expected), /must remain open/);
  assert.throws(() => assertPullRequestState(livePr({ draft: true }), expected), /must remain ready for review/);
  assert.throws(() => assertPullRequestState(livePr({ labels: [{ name: "release/major" }] }), expected), /does not match candidate label/);
});

test("candidate ownership binds metadata to the version, PR, and head", () => {
  const owned = { version: "1.5.0", pr: 120, sourceSha: head };
  assert.ok(assertCandidateOwnership(candidateMetadata(), owned));
  assert.throws(() => assertCandidateOwnership(candidateMetadata({ version: "1.6.0" }), owned), /does not match v1.5.0/);
  assert.throws(() => assertCandidateOwnership(candidateMetadata({ releasePr: 999 }), owned), /claims PR #999/);
  assert.throws(() => assertCandidateOwnership(candidateMetadata({ sourceSha: sha("f"), authorizedSha: sha("f") }), owned), /source SHA does not match/);
});

test("sealed evidence must still describe the candidate being submitted", () => {
  assert.ok(assertEvidenceMatches(buildSubmissionEvidence(evidenceInput), expectation));
  const cases = [
    [{ version: "1.6.0" }, /version does not match/],
    [{ sourceSha: sha("f") }, /source SHA does not match/],
    [{ headSha: sha("f") }, /head SHA does not match/],
    [{ label: "release/major" }, /label does not match/],
    [{ trustedToolsSha: sha("f") }, /trusted tooling SHA changed/],
    [{ freshChromeSha256: "b".repeat(64) }, /rebuild checksum does not match/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => assertEvidenceMatches(buildSubmissionEvidence({ ...evidenceInput, ...override }), expectation), pattern);
  }
});

// Re-verifying the re-downloaded assets against candidate.json alone would pass if both were
// swapped together after approval. The sealed checksums are what makes that detectable.
test("assets swapped after the seal are rejected even if candidate.json agrees with them", () => {
  const swapped = { ...expectation, assetChecksums: { "lurkloot-1.5.0-chrome.zip": "c".repeat(64) } };
  assert.throws(
    () => assertEvidenceMatches(buildSubmissionEvidence(evidenceInput), swapped),
    /frozen release assets changed after evidence was sealed/,
  );
});

test("an added or removed asset is rejected", () => {
  const extra = {
    ...expectation,
    assetChecksums: { ...expectation.assetChecksums, "lurkloot-1.5.0-firefox.zip": "d".repeat(64) },
  };
  assert.throws(() => assertEvidenceMatches(buildSubmissionEvidence(evidenceInput), extra), /assets changed after evidence/);
  assert.throws(() => assertEvidenceMatches(buildSubmissionEvidence({ ...evidenceInput, assetChecksums: {} }), expectation), /assets changed after evidence/);
});

test("legacy schema-1 evidence is not accepted", () => {
  const legacy = { ...buildSubmissionEvidence(evidenceInput), schemaVersion: 1 };
  assert.throws(() => assertEvidenceMatches(legacy, expectation), /must be schema version 2/);
});

test("only known submit actions may proceed", () => {
  for (const action of ["submitted", "already-submitted", "already-staged"]) {
    assert.equal(assertSubmitAction(action), action);
  }
  assert.throws(() => assertSubmitAction("frozen"), /unexpected Chrome Web Store submit action frozen/);
  assert.throws(() => assertSubmitAction(""), /unexpected Chrome Web Store submit action/);
});

test("narrative distinguishes a fresh submission from an already-staged one", () => {
  const pending = submissionNarrative("submitted", { version: "1.5.0", pr: 120 });
  assert.equal(pending.milestone, "cws-pending");
  assert.equal(pending.statusState, "cws pending");
  assert.match(pending.notes, /PENDING_REVIEW with deferred publishing/);

  const staged = submissionNarrative("already-staged", { version: "1.5.0", pr: 120 });
  assert.equal(staged.milestone, "cws-staged-validation");
  assert.equal(staged.statusState, "staged validation pending");
  assert.match(staged.notes, /is STAGED and awaits monitor finalization/);
});
