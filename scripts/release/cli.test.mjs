import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { emitOutputs } from "./cli.mjs";

const releaseDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(releaseDir, "cli.mjs");
const fixture = (name) => join(releaseDir, "fixtures", name);

async function runCli(args) {
  const directory = await mkdtemp(join(tmpdir(), "lurkloot-release-cli-"));
  const outputPath = join(directory, "github-output");
  await writeFile(outputPath, "");
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("policy command emits workflow outputs", async () => {
  const output = await runCli(["policy", "--input", fixture("policy-active.json")]);
  assert.match(output, /^state=active$/m);
  assert.match(output, /^kind=normal$/m);
  assert.match(output, /^label=release\/minor$/m);
  assert.match(output, /^version=1\.5\.0$/m);
  assert.match(output, /^authorized_sha=[0-9a-f]{40}$/m);
  assert.match(output, /^reason=normal release candidate$/m);
});

test("policy command normalizes unavailable optional outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lurkloot-policy-inactive-"));
  const input = join(directory, "input.json");
  await writeFile(input, JSON.stringify({ labels: [] }));
  try {
    const output = await runCli(["policy", "--input", input]);
    for (const key of ["kind", "label", "version", "authorized_sha"]) {
      assert.match(output, new RegExp(`^${key}=$`, "m"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile command emits prepare", async () => {
  const output = await runCli(["reconcile", "--input", fixture("reconcile-prepare.json")]);
  assert.match(output, /^action=prepare$/m);
  assert.match(output, /^convert_to_draft=false$/m);
  assert.match(output, /^reason=active PR has no candidate$/m);
});

test("metadata read emits every schema v2 field", async () => {
  const sha = "a".repeat(40);
  const digestA = `sha256:${"b".repeat(64)}`;
  const digestB = `sha256:${"c".repeat(64)}`;
  const checksum = "d".repeat(64);
  const metadata = {
    schemaVersion: 2,
    version: "1.5.0",
    kind: "normal",
    label: "release/minor",
    stableVersion: "1.4.0",
    stableSha: "e".repeat(40),
    developSha: "f".repeat(40),
    sourceSha: sha,
    authorizedSha: sha,
    releasePr: 42,
    initiator: "release-user",
    authorizedBy: "release-admin",
    trustedToolsSha: "1".repeat(40),
    createdAt: "2026-07-16T10:00:00Z",
    reconciledAt: "2026-07-16T10:01:00Z",
    chromeZipSha256: checksum,
    artifactChecksums: { "lurkloot-1.5.0-chrome.zip": checksum },
    dockerDigests: [digestA, digestB],
    cwsState: "DRAFT",
    previewUrl: "https://example.com/preview",
  };
  const directory = await mkdtemp(join(tmpdir(), "lurkloot-metadata-read-"));
  const input = join(directory, "candidate.json");
  await writeFile(input, JSON.stringify(metadata));
  try {
    const output = await runCli(["metadata", "read", "--file", input]);
    const entries = Object.fromEntries(output.trimEnd().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(entries, {
      schema_version: "2", version: "1.5.0", kind: "normal", label: "release/minor",
      stable_version: "1.4.0", stable_sha: "e".repeat(40), develop_sha: "f".repeat(40),
      source_sha: sha, authorized_sha: sha, release_pr: "42", initiator: "release-user",
      authorized_by: "release-admin", trusted_tools_sha: "1".repeat(40),
      created_at: "2026-07-16T10:00:00Z", reconciled_at: "2026-07-16T10:01:00Z",
      chrome_zip_sha256: checksum,
      artifact_checksums: JSON.stringify(metadata.artifactChecksums),
      docker_digests: JSON.stringify(metadata.dockerDigests),
      cws_state: "DRAFT", preview_url: "https://example.com/preview",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emitOutputs rejects workflow output line breaks", async () => {
  await assert.rejects(emitOutputs({ reason: "safe\ninjected=true" }), /line break/);
});
