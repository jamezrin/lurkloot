import test from "node:test";
import assert from "node:assert/strict";
import { deriveReleasePolicy, deriveVersion } from "./policy.mjs";

test("derives all release versions from stable main", () => {
  assert.equal(deriveVersion("1.4.9", "release/patch"), "1.4.10");
  assert.equal(deriveVersion("1.4.9", "release/minor"), "1.5.0");
  assert.equal(deriveVersion("1.4.9", "release/major"), "2.0.0");
  assert.equal(deriveVersion("1.4.9", "release/hotfix"), "1.4.10");
});

const normal = {
  baseRef: "main", sameRepository: true, labels: ["release/minor"],
  labelActorPermission: "admin", headSha: "a".repeat(40), mainSha: "b".repeat(40),
  developSha: "c".repeat(40), mainAncestor: true, developAncestor: true,
  leakedDevelopCommit: "", stableVersion: "1.4.9",
};

test("requires exactly one recognized label", () => {
  assert.equal(deriveReleasePolicy({ ...normal, labels: [] }).state, "inactive");
  const result = deriveReleasePolicy({ ...normal, labels: ["release/patch", "release/minor"] });
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /exactly one/);
});

test("requires admin label authorization", () => {
  const result = deriveReleasePolicy({ ...normal, labelActorPermission: "write" });
  assert.equal(result.state, "blocked");
  assert.match(result.reason, /administrator/);
});

test("classifies normal and hotfix history", () => {
  assert.deepEqual(deriveReleasePolicy(normal), {
    state: "active", kind: "normal", label: "release/minor", version: "1.5.0",
    authorizedSha: normal.headSha, reason: "normal release candidate",
  });
  const hotfix = deriveReleasePolicy({
    ...normal, labels: ["release/hotfix"], developAncestor: false,
  });
  assert.equal(hotfix.kind, "hotfix");
  assert.equal(hotfix.version, "1.4.10");
});

test("rejects forks, non-main bases, invalid ancestry, and develop leakage", () => {
  for (const input of [
    { ...normal, sameRepository: false },
    { ...normal, baseRef: "develop" },
    { ...normal, developAncestor: false },
    { ...normal, labels: ["release/hotfix"], mainAncestor: false },
    { ...normal, labels: ["release/hotfix"], leakedDevelopCommit: "d".repeat(40) },
  ]) assert.equal(deriveReleasePolicy(input).state, "blocked");
});
