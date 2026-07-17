import assert from "node:assert/strict";
import test from "node:test";
import { candidateMetadata } from "./fixtures/candidate.mjs";
import {
  assertPromotableMetadata,
  desiredPromotionLabel,
  dockerPromotionTags,
  stableMilestoneBody,
  stableReleaseNotes,
} from "./promotion.mjs";

test("a merge with no release label is inert rather than an error", () => {
  assert.equal(desiredPromotionLabel(["bug", "docs"]), null);
  assert.equal(desiredPromotionLabel([]), null);
});

test("exactly one release label identifies the promotion", () => {
  assert.equal(desiredPromotionLabel(["bug", "release/minor"]), "release/minor");
  assert.throws(() => desiredPromotionLabel(["release/minor", "release/patch"]), /exactly one recognized release label/);
});

test("only a schema-2 DRAFT candidate owned by this PR is promotable", () => {
  assert.ok(assertPromotableMetadata(candidateMetadata(), { pr: 120 }));
  assert.throws(() => assertPromotableMetadata(candidateMetadata({ releasePr: 999 }), { pr: 120 }), /claims PR #999/);
  assert.throws(() => assertPromotableMetadata(candidateMetadata({ cwsState: "PUBLISHED" }), { pr: 120 }), /cwsState PUBLISHED is not promotable/);
  assert.throws(() => assertPromotableMetadata(candidateMetadata({ artifactChecksums: {} }), { pr: 120 }), /no artifact checksums/);
  assert.throws(() => assertPromotableMetadata(candidateMetadata({ dockerDigests: [`sha256:${"a".repeat(64)}`] }), { pr: 120 }), /two Docker digests/);
});

test("docker promotion tags cover exact, minor, major, and latest", () => {
  assert.deepEqual(dockerPromotionTags("ghcr.io/o/lurkloot-cli", "1.5.0"), [
    "ghcr.io/o/lurkloot-cli:1.5.0",
    "ghcr.io/o/lurkloot-cli:1.5",
    "ghcr.io/o/lurkloot-cli:1",
    "ghcr.io/o/lurkloot-cli:latest",
  ]);
  assert.deepEqual(dockerPromotionTags("img", "10.20.30"), ["img:10.20.30", "img:10.20", "img:10", "img:latest"]);
});

test("stable release notes and milestone body name the version and initiator", () => {
  assert.equal(stableReleaseNotes("1.5.0"), "Stable release v1.5.0 from reviewed candidate.");
  const body = stableMilestoneBody("<!-- m -->", { version: "1.5.0", initiator: "jamezrin" });
  assert.match(body, /^<!-- m -->\n@jamezrin, candidate \*\*v1\.5\.0\*\* reached \*\*stable\*\*\./);
});
