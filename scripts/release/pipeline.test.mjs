import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReleaseAssets,
  candidateMarker,
  candidateTag,
  expectedReleaseAssets,
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
  assert.equal(candidateTag("1.6.0"), "v1.6.0");
});

test("uses only the final trailing candidate ownership marker", () => {
  const spoofed = candidateMarker({ pr: 999, version: "1.6.0", head: "release/1.6.0" });
  const canonical = candidateMarker({ pr: 132, version: "1.6.0", head: "release/1.6.0" });
  assert.deepEqual(parseCandidateMarker(`${spoofed}\nnotes\n${canonical}\n`), {
    pr: 132,
    version: "1.6.0",
    head: "release/1.6.0",
  });
  assert.equal(parseCandidateMarker(`${canonical}\nuser-controlled suffix`), undefined);
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

test("expected release assets are the four builds plus checksums", () => {
  assert.deepEqual(expectedReleaseAssets("1.6.0"), [
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-1.6.0-chrome.zip",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-1.6.0-firefox.zip",
  ]);
});

test("asset assertion accepts the exact expected set in any order", () => {
  const names = [
    "lurkloot-1.6.0-firefox.zip",
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-1.6.0-chrome.zip",
  ];
  assert.deepEqual(assertReleaseAssets({ names, version: "1.6.0" }), expectedReleaseAssets("1.6.0"));
});

test("asset assertion rejects an unexpected file", () => {
  const names = [...expectedReleaseAssets("1.6.0"), "candidate.json"];
  assert.throws(() => assertReleaseAssets({ names, version: "1.6.0" }), /unexpected release asset: candidate\.json/);
});

test("asset assertion rejects a missing file", () => {
  const names = expectedReleaseAssets("1.6.0").filter((name) => name !== "SHA256SUMS");
  assert.throws(() => assertReleaseAssets({ names, version: "1.6.0" }), /missing release asset: SHA256SUMS/);
});

test("asset assertion rejects a version mismatch", () => {
  assert.throws(
    () => assertReleaseAssets({ names: expectedReleaseAssets("1.5.0"), version: "1.6.0" }),
    /unexpected release asset: lurkloot-1\.5\.0-chrome\.crx/,
  );
});

test("a prerelease tag never influences the next version", () => {
  // The candidate publishes vX.Y.Z as a prerelease before the version is final, so that tag is in
  // the v* namespace while it is still a candidate. Counting it would skip a version.
  assert.deepEqual(releasePolicy({
    labels: ["release/minor"],
    head: "develop",
    tags: ["v1.4.0", "v1.5.0", "v1.6.0"],
    exclude: ["v1.6.0"],
  }), { action: "prepare", bump: "minor", label: "release/minor", version: "1.6.0" });
});

test("excluding nothing leaves the derivation unchanged", () => {
  assert.equal(releasePolicy({
    labels: ["release/minor"],
    head: "develop",
    tags: ["v1.4.0", "v1.5.0"],
    exclude: [],
  }).version, "1.6.0");
});

test("recomputing after the candidate tag exists is stable", () => {
  // validate computes 1.6.0 and publishes the v1.6.0 prerelease; cut must reach the same answer.
  const at = (tags) => releasePolicy({ labels: ["release/minor"], head: "develop", tags, exclude: ["v1.6.0"] }).version;
  assert.equal(at(["v1.5.0"]), "1.6.0");
  assert.equal(at(["v1.5.0", "v1.6.0"]), "1.6.0");
});
