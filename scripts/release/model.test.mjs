import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCandidateVersion,
  candidateAction,
  compareVersions,
  parseCandidateMetadata,
  renderCandidateMetadata,
} from "./model.mjs";

const fixtureMetadata = {
  schemaVersion: 1,
  version: "1.5.0",
  kind: "normal",
  sourceSha: "a".repeat(40),
  releasePr: 113,
  initiator: "jamezrin",
  chromeZipSha256: "b".repeat(64),
  artifactChecksums: {
    "lurkloot-1.5.0-chrome.zip": "b".repeat(64),
  },
  dockerDigests: ["sha256:" + "c".repeat(64)],
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
    () => parseCandidateMetadata(JSON.stringify({ ...fixtureMetadata, schemaVersion: 2 })),
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
});
