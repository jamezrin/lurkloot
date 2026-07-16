import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateMetadata, parseChecksums, parseDockerDigests } from "./metadata.mjs";

test("parses GNU checksum files", () => {
  assert.deepEqual(parseChecksums(`${"a".repeat(64)}  lurkloot-1.5.0-chrome.zip\n`), {
    "lurkloot-1.5.0-chrome.zip": "a".repeat(64),
  });
  assert.throws(() => parseChecksums("unsafe  ../asset.zip\n"), /checksum line/);
});

test("parses digest artifact filenames", () => {
  assert.deepEqual(parseDockerDigests(["a".repeat(64), "b".repeat(64)]), [
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
  ]);
  assert.throws(() => parseDockerDigests(["latest"]), /digest filename/);
});

test("builds validated candidate metadata", () => {
  const checksum = "a".repeat(64);
  const metadata = buildCandidateMetadata({
    version: "1.5.0",
    kind: "normal",
    sourceSha: "b".repeat(40),
    releasePr: "113",
    initiator: "jamezrin",
    checksumsText: `${checksum}  lurkloot-1.5.0-chrome.zip\n`,
    digestNames: ["c".repeat(64), "d".repeat(64)],
    previewUrl: "https://next.lurkloot.pages.dev",
  });
  assert.equal(metadata.chromeZipSha256, checksum);
  assert.equal(metadata.releasePr, 113);
});
