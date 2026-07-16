#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { renderCandidateMetadata } from "./model.mjs";

const checksumLine = /^([0-9a-f]{64})  ([^/\\]+)$/;
const digestName = /^[0-9a-f]{64}$/;

export function parseChecksums(text) {
  const entries = {};
  for (const line of text.trim().split("\n")) {
    const match = checksumLine.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    entries[match[2]] = match[1];
  }
  return entries;
}

export function parseDockerDigests(names) {
  return names.sort().map((name) => {
    if (!digestName.test(name)) throw new Error(`invalid Docker digest filename: ${name}`);
    return `sha256:${name}`;
  });
}

export function buildCandidateMetadata(input) {
  const artifactChecksums = parseChecksums(input.checksumsText);
  const chromeName = `lurkloot-${input.version}-chrome.zip`;
  const chromeZipSha256 = artifactChecksums[chromeName];
  if (!chromeZipSha256) throw new Error(`${chromeName} is missing from SHA256SUMS`);
  return JSON.parse(renderCandidateMetadata({
    schemaVersion: 1,
    version: input.version,
    kind: input.kind,
    sourceSha: input.sourceSha,
    releasePr: Number(input.releasePr),
    initiator: input.initiator,
    chromeZipSha256,
    artifactChecksums,
    dockerDigests: parseDockerDigests(input.digestNames),
    cwsState: "DRAFT",
    previewUrl: input.previewUrl,
  }));
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const metadata = buildCandidateMetadata({
    version: required("VERSION"),
    kind: required("KIND"),
    sourceSha: required("SOURCE_SHA"),
    releasePr: required("RELEASE_PR"),
    initiator: required("INITIATOR"),
    checksumsText: await readFile(required("CHECKSUMS_PATH"), "utf8"),
    digestNames: await readdir(required("DIGESTS_DIR")),
    previewUrl: required("PREVIEW_URL"),
  });
  process.stdout.write(renderCandidateMetadata(metadata));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release metadata: ${error.message}`);
    process.exitCode = 1;
  });
}
