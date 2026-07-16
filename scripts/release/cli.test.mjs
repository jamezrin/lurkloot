import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyCandidateAssets, verifyHotfixHistory } from "./cli.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), "lurkloot-hotfix-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Release Test");
  git(cwd, "config", "user.email", "release@example.com");
  await writeFile(join(cwd, "state.txt"), "main\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "main");
  git(cwd, "branch", "develop");
  git(cwd, "switch", "develop");
  await writeFile(join(cwd, "develop.txt"), "unreleased\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "develop");
  git(cwd, "switch", "-c", "hotfix/clean", "main");
  await writeFile(join(cwd, "hotfix.txt"), "fixed\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "hotfix");
  return cwd;
}

test("metadata verification accepts exact assets and rejects changed bytes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "lurkloot-metadata-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const assetDir = join(cwd, "assets");
  await mkdir(assetDir);
  const name = "lurkloot-1.5.0-chrome.zip";
  const bytes = Buffer.from("reviewed archive");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(assetDir, name), bytes);
  await writeFile(join(assetDir, "SHA256SUMS"), `${checksum}  ${name}\n`);
  const metadata = {
    schemaVersion: 1,
    version: "1.5.0",
    kind: "normal",
    sourceSha: "a".repeat(40),
    releasePr: 123,
    initiator: "jamezrin",
    chromeZipSha256: checksum,
    artifactChecksums: { [name]: checksum },
    dockerDigests: [`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`],
    cwsState: "DRAFT",
    previewUrl: "https://next.lurkloot.pages.dev",
  };
  await verifyCandidateAssets(metadata, assetDir);
  await writeFile(join(assetDir, name), "changed");
  await assert.rejects(verifyCandidateAssets(metadata, assetDir), /checksum mismatch/);
});

test("hotfix verification accepts main-only work", async (t) => {
  const cwd = await repository(t);
  await verifyHotfixHistory({ cwd, mainRef: "main", developRef: "develop", candidateRef: "hotfix/clean" });
});

test("hotfix verification rejects unreleased develop history", async (t) => {
  const cwd = await repository(t);
  git(cwd, "merge", "--no-edit", "develop");
  await assert.rejects(
    verifyHotfixHistory({ cwd, mainRef: "main", developRef: "develop", candidateRef: "hotfix/clean" }),
    /unreleased develop commit/,
  );
});

test("CLI rejects an unsafe hotfix with a nonzero exit", async (t) => {
  const cwd = await repository(t);
  git(cwd, "merge", "--no-edit", "develop");
  const result = spawnSync(process.execPath, [cli, "verify-hotfix", "--main", "main", "--develop", "develop", "--candidate", "hotfix/clean"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unreleased develop commit/);
});
