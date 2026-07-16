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
  ["replace frozen label", { policy: { ...active, label: "release/major", version: "2.0.0" }, draft: false, candidate: { ...candidate, state: "PENDING_REVIEW" } }, "cancel-and-prepare"],
  ["close submitted", { policy: active, closed: true, candidate: { ...candidate, state: "PENDING_REVIEW" } }, "cancel"],
  ["merge staged", { policy: active, merged: true, candidate: { ...candidate, state: "STAGED" } }, "promote"],
  ["merge without candidate", { policy: { state: "inactive" }, merged: true }, "none"],
  ["policy block", { policy: { state: "blocked", reason: "bad labels" }, draft: true, candidate }, "retire"],
];

for (const [name, input, action] of cases) test(name, () => {
  assert.equal(deriveReconciliation({ closed: false, merged: false, candidate: undefined, cwsState: "none", ...input }).action, action);
});

test("duplicate submitted event is a no-op", () => {
  const result = deriveReconciliation({
    policy: active,
    draft: false,
    closed: false,
    merged: false,
    candidate: { ...candidate, state: "PENDING_REVIEW" },
    cwsState: "none",
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
    cwsState: "none",
  });
  assert.deepEqual(result, {
    action: "cancel",
    reason: "bad labels",
    convertToDraft: true,
  });
});
