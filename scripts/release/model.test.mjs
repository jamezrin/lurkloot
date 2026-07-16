import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateVersion,
  candidateAction,
  compareVersions,
  parseLegacyCandidateMetadata,
  parseCandidateMetadata,
  renderCandidateMetadata,
} from "./model.mjs";

const fixtureMetadata = {
  schemaVersion: 2,
  version: "1.5.0",
  kind: "normal",
  label: "release/minor",
  stableVersion: "1.4.0",
  stableSha: "1".repeat(40),
  developSha: "2".repeat(40),
  sourceSha: "3".repeat(40),
  authorizedSha: "3".repeat(40),
  releasePr: 42,
  initiator: "jamezrin",
  authorizedBy: "release-admin",
  trustedToolsSha: "4".repeat(40),
  createdAt: "2026-07-16T18:00:00.000Z",
  reconciledAt: "2026-07-16T18:00:00.000Z",
  chromeZipSha256: "b".repeat(64),
  artifactChecksums: {
    "lurkloot-1.5.0-chrome.zip": "b".repeat(64),
  },
  dockerDigests: ["sha256:" + "c".repeat(64), "sha256:" + "d".repeat(64)],
  cwsState: "DRAFT",
  previewUrl: "https://next.lurkloot.pages.dev",
};

test("orders stable semantic versions", () => {
  assert.equal(compareVersions("1.5.0", "1.4.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.9.9", "2.0.0"), -1);
});

test("rejects malformed stable semantic versions", () => {
  assert.throws(() => compareVersions("1.5.0-rc.1", "1.4.0"), /stable semantic version/);
  assert.throws(() => compareVersions("01.5.0", "1.4.0"), /stable semantic version/);
});

test("rejects candidates at or below the stable version", () => {
  assert.throws(
    () => assertCandidateVersion({ version: "1.4.0", stableVersion: "1.4.0", activeVersions: [] }),
    /greater than stable version/,
  );
});

test("rejects a version owned by another active candidate", () => {
  assert.throws(
    () => assertCandidateVersion({ version: "1.5.0", stableVersion: "1.4.0", activeVersions: ["1.5.0"] }),
    /already has an active candidate/,
  );
});

test("accepts a higher candidate version", () => {
  assert.equal(
    assertCandidateVersion({ version: "2.0.0", stableVersion: "1.4.0", activeVersions: ["1.5.0"] }),
    "2.0.0",
  );
});

test("rejects a candidate below a newer active version", () => {
  assert.throws(
    () => assertCandidateVersion({ version: "1.5.0", stableVersion: "1.4.0", activeVersions: ["1.6.0"] }),
    /cannot supersede newer active candidate/,
  );
});

test("allows replacement only before CWS submission", () => {
  assert.equal(candidateAction({ exists: false, stable: false }), "create");
  assert.equal(candidateAction({ exists: true, stable: false }), "replace");
  assert.equal(candidateAction({ exists: true, stable: false, submittedState: "PENDING_REVIEW" }), "frozen");
  assert.equal(candidateAction({ exists: true, stable: false, submittedState: "STAGED" }), "frozen");
  assert.equal(candidateAction({ exists: true, stable: true }), "immutable");
});

test("round trips schema-versioned candidate metadata", () => {
  const encoded = renderCandidateMetadata(fixtureMetadata);
  assert.deepEqual(parseCandidateMetadata(encoded), fixtureMetadata);
});

test("rejects unsafe candidate metadata", () => {
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, schemaVersion: 1 })),
    /schemaVersion/,
  );
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, sourceSha: "main" })),
    /sourceSha/,
  );
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, unexpected: true })),
    /unexpected field/,
  );
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, authorizedSha: "5".repeat(40) })),
    /authorizedSha/,
  );
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, label: "release/hotfix" })),
    /label/,
  );
  assert.throws(
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, dockerDigests: [fixtureMetadata.dockerDigests[0], fixtureMetadata.dockerDigests[0]] })),
    /two distinct/,
  );
});

test("accepts null develop provenance for hotfix candidates", () => {
  const hotfix = { ...fixtureMetadata, kind: "hotfix", label: "release/hotfix", developSha: null };
  assert.deepEqual(parseCandidateMetadata(renderCandidateMetadata(hotfix)), hotfix);
});

test("parses schema v1 metadata only through the recovery parser", () => {
  const legacy = {
    schemaVersion: 1,
    version: fixtureMetadata.version,
    kind: fixtureMetadata.kind,
    sourceSha: fixtureMetadata.sourceSha,
    releasePr: fixtureMetadata.releasePr,
    initiator: fixtureMetadata.initiator,
    chromeZipSha256: fixtureMetadata.chromeZipSha256,
    artifactChecksums: fixtureMetadata.artifactChecksums,
    dockerDigests: fixtureMetadata.dockerDigests,
    cwsState: fixtureMetadata.cwsState,
    previewUrl: fixtureMetadata.previewUrl,
  };
  assert.deepEqual(parseLegacyCandidateMetadata(JSON.stringify(legacy)), legacy);
  assert.throws(() => parseCandidateMetadata(JSON.stringify(legacy)), /schemaVersion/);
});
