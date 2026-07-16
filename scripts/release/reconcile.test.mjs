import test from "node:test";
import assert from "node:assert/strict";
import { deriveReconciliation } from "./reconcile.mjs";

const active = { state: "active", kind: "normal", label: "release/minor", version: "1.5.0", authorizedSha: "a".repeat(40) };
const candidate = { version: "1.5.0", label: "release/minor", sourceSha: "a".repeat(40), state: "DRAFT" };

const cases = [
  ["inactive untouched PR", { policy: { state: "inactive" }, draft: true }, "none"],
  ["new draft", { policy: active, draft: true }, "prepare"],
  ["matching mutable draft", { policy: active, draft: true, candidate }, "none"],
  ["changed mutable head", { policy: { ...active, authorizedSha: "b".repeat(40) }, draft: true, candidate }, "prepare"],
  ["ready candidate", { policy: active, draft: false, candidate }, "submit"],
  ["remove label", { policy: { state: "inactive" }, draft: true, candidate }, "retire"],
  ["replace frozen label", { policy: { ...active, label: "release/major", version: "2.0.0" }, draft: false, candidate: { ...candidate, state: "PENDING_REVIEW" }, cwsState: "PENDING_REVIEW" }, "cancel-and-prepare"],
  ["close submitted", { policy: active, closed: true, candidate: { ...candidate, state: "PENDING_REVIEW" }, cwsState: "PENDING_REVIEW" }, "cancel"],
  ["merge staged", { policy: active, merged: true, candidate: { ...candidate, state: "STAGED" }, cwsState: "STAGED" }, "promote"],
  ["merge without candidate", { policy: { state: "inactive" }, merged: true }, "none"],
  ["policy block", { policy: { state: "blocked", reason: "bad labels" }, draft: true, candidate }, "retire"],
];

for (const [name, input, action] of cases) test(name, () => {
  const selectedPolicy = input.policy ?? active;
  assert.equal(deriveReconciliation({
    closed: false,
    merged: false,
    candidate: undefined,
    cwsState: "none",
    headSha: selectedPolicy.authorizedSha,
    ...input,
  }).action, action);
});

test("duplicate submitted event is a no-op", () => {
  const result = deriveReconciliation({
    policy: active,
    draft: false,
    closed: false,
    merged: false,
    candidate: { ...candidate, state: "PENDING_REVIEW" },
    cwsState: "PENDING_REVIEW",
    headSha: active.authorizedSha,
  });
  assert.equal(result.action, "none");
});

test("published candidate is never prepared again", () => {
  const result = deriveReconciliation({
    policy: { ...active, authorizedSha: "b".repeat(40) },
    draft: true,
    closed: false,
    merged: false,
    candidate: { ...candidate, state: "PUBLISHED" },
    cwsState: "none",
    headSha: "b".repeat(40),
  });
  assert.equal(result.action, "block");
});

test("CWS version mismatch blocks reconciliation", () => {
  const result = deriveReconciliation({
    policy: active,
    draft: true,
    closed: false,
    merged: false,
    candidate,
    cwsState: "VERSION_MISMATCH",
    headSha: active.authorizedSha,
  });
  assert.equal(result.action, "block");
});

test("blocked policy cancels a frozen candidate", () => {
  const result = deriveReconciliation({
    policy: { state: "blocked", reason: "bad labels" },
    draft: false,
    closed: false,
    merged: false,
    candidate: { ...candidate, state: "PENDING_REVIEW" },
    cwsState: "PENDING_REVIEW",
    headSha: active.authorizedSha,
  });
  assert.deepEqual(result, {
    action: "cancel",
    reason: "bad labels",
    convertToDraft: true,
  });
});

test("merged staged candidate must match the active policy identity", () => {
  for (const mismatchedCandidate of [
    { ...candidate, version: "1.4.0", state: "STAGED" },
    { ...candidate, label: "release/patch", state: "STAGED" },
    { ...candidate, sourceSha: "b".repeat(40), state: "STAGED" },
  ]) {
    const result = deriveReconciliation({
      policy: active,
      draft: false,
      closed: false,
      merged: true,
      headSha: active.authorizedSha,
      candidate: mismatchedCandidate,
      cwsState: "STAGED",
    });
    assert.equal(result.action, "block");
  }
});

test("a pushed draft renews authorization through preparation", () => {
  const live = { ...active, authorizedSha: "b".repeat(40) };
  assert.equal(deriveReconciliation({
    policy: live, draft: true, closed: false, merged: false,
    headSha: live.authorizedSha, candidate, cwsState: "DRAFT",
  }).action, "prepare");
});

test("a pushed submitted candidate is cancelled before renewed preparation", () => {
  const live = { ...active, authorizedSha: "b".repeat(40) };
  assert.equal(deriveReconciliation({
    policy: live, draft: false, closed: false, merged: false,
    headSha: live.authorizedSha,
    candidate: { ...candidate, state: "PENDING_REVIEW" },
    cwsState: "PENDING_REVIEW",
  }).action, "cancel-and-prepare");
});

test("matching frozen candidate on a draft PR is cancelled and converted to draft", () => {
  for (const state of ["PENDING_REVIEW", "STAGED"]) {
    const result = deriveReconciliation({
      policy: active,
      draft: true,
      closed: false,
      merged: false,
      headSha: active.authorizedSha,
      candidate: { ...candidate, state },
      cwsState: state,
    });
    assert.deepEqual(result, {
      action: "cancel",
      reason: "draft PR cannot retain a frozen candidate",
      convertToDraft: true,
    });
  }
});

test("unexpected CWS states block reconciliation", () => {
  for (const cwsState of [undefined, "PUBLISHED", "REJECTED", "CANCELLED", "CANDIDATE_CHANGED", "unknown"]) {
    const result = deriveReconciliation({
      policy: active,
      draft: true,
      closed: false,
      merged: false,
      headSha: active.authorizedSha,
      candidate,
      cwsState,
    });
    assert.equal(result.action, "block");
  }
});

test("duplicate and out-of-order CWS events are non-mutating", () => {
  const duplicate = deriveReconciliation({
    policy: active,
    draft: false,
    closed: false,
    merged: false,
    headSha: active.authorizedSha,
    candidate: { ...candidate, state: "STAGED" },
    cwsState: "STAGED",
  });
  assert.equal(duplicate.action, "none");

  for (const [candidateState, cwsState] of [
    ["DRAFT", "PENDING_REVIEW"],
    ["DRAFT", "STAGED"],
    ["PENDING_REVIEW", "DRAFT"],
    ["PENDING_REVIEW", "STAGED"],
    ["STAGED", "DRAFT"],
    ["STAGED", "PENDING_REVIEW"],
  ]) {
    const result = deriveReconciliation({
      policy: active,
      draft: false,
      closed: false,
      merged: false,
      headSha: active.authorizedSha,
      candidate: { ...candidate, state: candidateState },
      cwsState,
    });
    assert.equal(result.action, "block");
  }
});
