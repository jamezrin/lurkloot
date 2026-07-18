import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateMarker,
  candidateTag,
  isGeneratedReleaseHead,
  parseCandidateMarker,
  releasePolicy,
  selectReleaseLabel,
  validatePromotion,
} from "./pipeline.mjs";

test("selects exactly one recognized release label", () => {
  assert.equal(selectReleaseLabel(["docs", "release/minor"]), "release/minor");
  assert.equal(selectReleaseLabel(["docs"]), undefined);
  assert.throws(
    () => selectReleaseLabel(["release/patch", "release/minor"]),
    /only one release label can be specified/,
  );
});

test("recognizes only generated stable release heads", () => {
  assert.equal(isGeneratedReleaseHead("release/1.6.0"), true);
  assert.equal(isGeneratedReleaseHead("release/v1.6.0"), false);
  assert.equal(isGeneratedReleaseHead("release/minor"), false);
  assert.equal(isGeneratedReleaseHead("hotfix/login"), false);
});

test("derives preparation and orphan actions from live labels", () => {
  assert.deepEqual(releasePolicy({
    labels: ["release/minor"],
    head: "develop",
    tags: ["v1.5.0"],
  }), {
    action: "prepare",
    bump: "minor",
    label: "release/minor",
    version: "1.6.0",
  });
  assert.deepEqual(releasePolicy({ labels: [], head: "develop", tags: ["v1.5.0"] }), {
    action: "orphan",
  });
  assert.deepEqual(releasePolicy({ labels: ["release/minor"], head: "release/1.6.0", tags: ["v1.5.0"] }), {
    action: "ignore",
  });
});

test("candidate ownership markers round trip", () => {
  const context = { pr: 132, version: "1.6.0", head: "release/1.6.0" };
  const marker = candidateMarker(context);
  assert.match(marker, /^<!-- lurkloot-release-candidate:/);
  assert.deepEqual(parseCandidateMarker(`Candidate\n\n${marker}\n`), context);
  assert.equal(parseCandidateMarker("ordinary release body"), undefined);
  assert.equal(candidateTag("1.6.0"), "candidate-v1.6.0");
});

test("validates a concurrent minor candidate after a patch release", () => {
  assert.deepEqual(validatePromotion({
    stableVersion: "1.5.1",
    version: "1.6.0",
    label: "release/minor",
  }), { bump: "minor", version: "1.6.0" });
  assert.throws(
    () => validatePromotion({ stableVersion: "1.6.0", version: "1.5.1", label: "release/patch" }),
    /expected 1\.6\.1/,
  );
});
