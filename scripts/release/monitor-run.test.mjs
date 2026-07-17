import assert from "node:assert/strict";
import test from "node:test";
import {
  activeCandidateVersions,
  assertMonitorVersion,
  countLabel,
  deriveHeadEvidence,
  isMetadataOnly,
  recognizedCount,
} from "./monitor-run.mjs";

const release = (overrides = {}) => ({ tag_name: "v1.5.0", name: "v1.5.0", prerelease: true, ...overrides });

test("active candidates exclude stable, cancelled, and non-semver releases", () => {
  assert.deepEqual(activeCandidateVersions([release()]), ["1.5.0"]);
  assert.deepEqual(activeCandidateVersions([release({ prerelease: false })]), []);
  assert.deepEqual(activeCandidateVersions([release({ name: "v1.5.0 cancelled" })]), []);
  assert.deepEqual(activeCandidateVersions([release({ tag_name: "nightly" })]), []);
  assert.deepEqual(activeCandidateVersions([release({ name: null })]), ["1.5.0"]);
});

test("the optional version input must be blank or stable semver", () => {
  assert.equal(assertMonitorVersion(""), "");
  assert.equal(assertMonitorVersion("1.5.0"), "1.5.0");
  assert.throws(() => assertMonitorVersion("1.5"), /blank or stable SemVer/);
  assert.throws(() => assertMonitorVersion("v1.5.0"), /blank or stable SemVer/);
});

test("only release metadata paths count as metadata-only", () => {
  assert.equal(isMetadataOnly(["package.json", "packages/site/src/changelog.json"]), true);
  assert.equal(isMetadataOnly(["packages/core/package.json"]), true);
  assert.equal(isMetadataOnly([]), true);
  assert.equal(isMetadataOnly(["packages/core/src/scheduler.ts"]), false);
  assert.equal(isMetadataOnly(["package.json", "README.md"]), false);
});

test("label counting distinguishes the exact label from any release label", () => {
  assert.equal(countLabel(["release/minor", "bug"], "release/minor"), 1);
  assert.equal(countLabel(["bug"], "release/minor"), 0);
  assert.equal(recognizedCount(["release/minor", "release/patch", "bug"]), 2);
});

test("head evidence reports a clean finalize head", () => {
  const evidence = deriveHeadEvidence({
    comparison: { status: "ahead", commits: ["c1"], files: ["package.json"] },
    headCommit: { authorEmail: "bot@example.com", subject: "chore(release): finalize 1.5.0 metadata" },
    labelValid: true,
    readyValid: true,
  });
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    descendsFromSource: true,
    metadataOnly: true,
    commitCount: 1,
    authorEmail: "bot@example.com",
    subject: "chore(release): finalize 1.5.0 metadata",
  });
});

test("an identical head still descends from source", () => {
  const evidence = deriveHeadEvidence({
    comparison: { status: "identical", commits: [], files: [] },
    headCommit: { authorEmail: "x", subject: "y" },
    labelValid: true,
    readyValid: true,
  });
  assert.equal(evidence.descendsFromSource, true);
  assert.equal(evidence.commitCount, 0);
});

test("a diverged head is not a descendant and is never metadata-only", () => {
  const evidence = deriveHeadEvidence({
    comparison: { status: "diverged", commits: ["c1"], files: ["package.json"] },
    headCommit: { authorEmail: "x", subject: "y" },
    labelValid: true,
    readyValid: true,
  });
  assert.equal(evidence.descendsFromSource, false);
  assert.equal(evidence.metadataOnly, false);
});

// The shell forced metadataOnly false when labels or readiness drifted, so a candidate that lost
// its label could not be finalized on the strength of a clean diff alone.
test("invalid labels or a draft PR force metadata-only false", () => {
  const comparison = { status: "ahead", commits: ["c1"], files: ["package.json"] };
  const headCommit = { authorEmail: "x", subject: "y" };
  assert.equal(deriveHeadEvidence({ comparison, headCommit, labelValid: false, readyValid: true }).metadataOnly, false);
  assert.equal(deriveHeadEvidence({ comparison, headCommit, labelValid: true, readyValid: false }).metadataOnly, false);
});

test("source changes are never metadata-only", () => {
  const evidence = deriveHeadEvidence({
    comparison: { status: "ahead", commits: ["c1"], files: ["package.json", "packages/core/src/scheduler.ts"] },
    headCommit: { authorEmail: "x", subject: "y" },
    labelValid: true,
    readyValid: true,
  });
  assert.equal(evidence.metadataOnly, false);
});
