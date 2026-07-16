#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { checkWorkspace, prepareWorkspace } from "../release.mjs";
import { buildCandidateMetadata, parseChecksums } from "./metadata.mjs";
import { parseCandidateMetadata, renderCandidateMetadata } from "./model.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, { cwd = process.cwd(), allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

async function gitLines(cwd, args) {
  const result = await run("git", args, { cwd });
  return result.stdout ? result.stdout.split("\n") : [];
}

export async function verifyHotfixHistory({ cwd = process.cwd(), mainRef, developRef, candidateRef }) {
  const ancestry = await run("git", ["merge-base", "--is-ancestor", mainRef, candidateRef], { cwd, allowFailure: true });
  if (ancestry.code !== 0) throw new Error(`${candidateRef} must descend from ${mainRef}`);
  const [developOnly, candidateOnly] = await Promise.all([
    gitLines(cwd, ["rev-list", developRef, `^${mainRef}`]),
    gitLines(cwd, ["rev-list", candidateRef, `^${mainRef}`]),
  ]);
  const candidateCommits = new Set(candidateOnly);
  const leakedCommit = developOnly.find((commit) => candidateCommits.has(commit));
  if (leakedCommit) throw new Error(`${candidateRef} contains unreleased develop commit ${leakedCommit}`);
}

export async function verifyCandidateAssets(metadataInput, assetDirectory) {
  const metadata = typeof metadataInput === "string"
    ? parseCandidateMetadata(await readFile(metadataInput, "utf8"))
    : parseCandidateMetadata(renderCandidateMetadata(metadataInput));
  const actualNames = (await readdir(assetDirectory)).filter((name) => name !== "candidate.json").sort();
  const expectedNames = Object.keys(metadata.artifactChecksums).sort();
  const checksumManifest = parseChecksums(await readFile(join(assetDirectory, "SHA256SUMS"), "utf8"));
  if (JSON.stringify(checksumManifest) !== JSON.stringify(metadata.artifactChecksums)) {
    throw new Error("SHA256SUMS does not match candidate metadata");
  }
  for (const name of expectedNames) {
    const bytes = await readFile(join(assetDirectory, name));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== metadata.artifactChecksums[name]) {
      throw new Error(`checksum mismatch for ${name}: expected ${metadata.artifactChecksums[name]}, got ${actual}`);
    }
  }
  const unexpected = actualNames.filter((name) => name !== "SHA256SUMS" && !expectedNames.includes(name));
  if (unexpected.length) throw new Error(`unexpected candidate assets: ${unexpected.join(", ")}`);
  return metadata;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
}

async function createMetadata() {
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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version" && args.length === 0) {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (command === "check" && args.length === 0) return checkWorkspace();
  if (command === "prepare-workspace" && args[0] && args.length === 1) return prepareWorkspace(args[0]);
  if (command === "prepare-workspace" && args[0] && args[1] === "--date" && args[2] && args.length === 3) {
    return prepareWorkspace(args[0], args[2]);
  }
  if (command === "metadata" && args[0] === "create" && args.length === 1) return createMetadata();
  if (command === "metadata" && args[0] === "verify" && args[1] && args[2] && args.length === 3) {
    await verifyCandidateAssets(args[1], args[2]);
    return;
  }
  if (command === "verify-hotfix") {
    await verifyHotfixHistory({
      mainRef: option(args, "--main"),
      developRef: option(args, "--develop"),
      candidateRef: option(args, "--candidate"),
    });
    return;
  }
  throw new Error("usage: cli.mjs <version | check | prepare-workspace VERSION [--date YYYY-MM-DD] | metadata create | metadata verify CANDIDATE_JSON ASSET_DIR | verify-hotfix --main REF --develop REF --candidate REF>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  });
}
