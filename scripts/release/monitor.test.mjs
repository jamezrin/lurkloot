import assert from "node:assert/strict";
import test from "node:test";
import { deriveCwsState, parseStatusOutputs } from "./monitor.mjs";

const sourceSha = "a".repeat(40);

function status(overrides = {}) {
  return {
    publishedVersion: "1.4.0",
    submittedVersion: "1.5.0",
    submittedState: "STAGED",
    warned: false,
    takenDown: false,
    ...overrides,
  };
}

function derive(overrides = {}) {
  return deriveCwsState({
    version: "1.5.0",
    sourceSha,
    headSha: sourceSha,
    ...overrides,
    status: status(overrides.status),
  });
}

test("parses the key=value outputs cws.mjs status writes", () => {
  const parsed = parseStatusOutputs([
    "published_version=1.4.0",
    "submitted_version=1.5.0",
    "submitted_state=PENDING_REVIEW",
    "warned=false",
    "taken_down=true",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, {
    publishedVersion: "1.4.0",
    submittedVersion: "1.5.0",
    submittedState: "PENDING_REVIEW",
    warned: false,
    takenDown: true,
  });
});

test("reports missing status fields as none rather than undefined", () => {
  const parsed = parseStatusOutputs("");
  assert.equal(parsed.publishedVersion, "none");
  assert.equal(parsed.submittedVersion, "none");
  assert.equal(parsed.submittedState, "none");
  assert.equal(parsed.warned, false);
});

test("passes through the submitted state when nothing overrides it", () => {
  assert.deepEqual(derive(), { state: "STAGED", recovery: false });
  assert.deepEqual(derive({ status: { submittedState: "REJECTED" } }), { state: "REJECTED", recovery: false });
  assert.deepEqual(derive({ status: { submittedState: "CANCELLED" } }), { state: "CANCELLED", recovery: false });
});

test("treats a warning or takedown as a policy block", () => {
  assert.equal(derive({ status: { warned: true } }).state, "POLICY_BLOCKED");
  assert.equal(derive({ status: { takenDown: true } }).state, "POLICY_BLOCKED");
});

test("a version mismatch outranks a policy block", () => {
  assert.equal(derive({ status: { warned: true, submittedVersion: "1.6.0" } }).state, "VERSION_MISMATCH");
});

test("an absent submission is not a version mismatch", () => {
  const state = derive({ status: { submittedVersion: "none", submittedState: "none" } });
  assert.deepEqual(state, { state: "none", recovery: false });
});

test("a pending review whose head moved is a changed candidate", () => {
  const moved = derive({ status: { submittedState: "PENDING_REVIEW" }, headSha: "b".repeat(40), candidateHeadValid: false });
  assert.equal(moved.state, "CANDIDATE_CHANGED");
  assert.equal(derive({ status: { submittedState: "PENDING_REVIEW" } }).state, "PENDING_REVIEW");
  // The verified metadata-only finalize commit lands after submission and stays reviewable.
  const finalized = derive({ status: { submittedState: "PENDING_REVIEW" }, headSha: "b".repeat(40), candidateHeadValid: true });
  assert.equal(finalized.state, "PENDING_REVIEW");
});

test("a staged candidate with an unverifiable head is a changed candidate", () => {
  assert.equal(derive({ candidateHeadValid: false }).state, "CANDIDATE_CHANGED");
  assert.equal(derive({ candidateHeadValid: true }).state, "STAGED");
});

test("recovery only republishes an already-published version on request", () => {
  const absent = { submittedVersion: "none", submittedState: "none", publishedVersion: "1.5.0" };
  assert.deepEqual(derive({ status: absent, recoveryRequested: true }), { state: "PUBLISHED", recovery: true });
  assert.deepEqual(derive({ status: absent }), { state: "none", recovery: false });
});

test("recovery does not rescue a published version nobody asked to recover", () => {
  const other = { submittedVersion: "none", submittedState: "none", publishedVersion: "1.4.0" };
  assert.deepEqual(derive({ status: other, recoveryRequested: true }), { state: "none", recovery: false });
});

test("a store-reported PUBLISHED submission is not a recovery", () => {
  const published = { submittedState: "PUBLISHED" };
  assert.deepEqual(derive({ status: published, recoveryRequested: true }), { state: "PUBLISHED", recovery: false });
});

