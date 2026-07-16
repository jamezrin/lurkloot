import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyCandidateAssets, verifyCandidateHead, verifyHotfixHistory } from "./cli.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitAs(cwd, email, message) {
  git(cwd, "-c", "user.name=github-actions[bot]", "-c", `user.email=${email}`, "commit", "-m", message);
}

async function candidate(t) {
  const cwd = await mkdtemp(join(tmpdir(), "lurkloot-candidate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "release/1.5.0");
  git(cwd, "config", "user.name", "Release Test");
  git(cwd, "config", "user.email", "release@example.com");
  await mkdir(join(cwd, "packages/site/src"), { recursive: true });
  await writeFile(join(cwd, "package.json"), '{ "version": "1.5.0" }\n');
  await writeFile(join(cwd, "packages/site/src/changelog.json"), '[{ "version": "1.5.0" }]\n');
  await writeFile(join(cwd, "app.js"), "source\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "chore(release): bump version to 1.5.0");
  git(cwd, "tag", "source");
  return cwd;
}

async function finalize(cwd, { email = botEmail, subject = "chore(release): finalize 1.5.0 metadata" } = {}) {
  await writeFile(join(cwd, "packages/site/src/changelog.json"), '[{ "version": "1.5.0", "date": "2026-07-16" }]\n');
  git(cwd, "add", ".");
  commitAs(cwd, email, subject);
}

const head = (cwd, { version = "1.5.0", verifyWorkspace = async () => {} } = {}) => verifyCandidateHead({
  cwd,
  version,
  sourceSha: git(cwd, "rev-parse", "source"),
  headSha: git(cwd, "rev-parse", "HEAD"),
  verifyWorkspace,
});

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

test("an untouched candidate head matches its frozen source", async (t) => {
  assert.equal(await head(await candidate(t)), true);
});

test("accepts the finalize commit the monitor pushes itself", async (t) => {
  const cwd = await candidate(t);
  await finalize(cwd);
  assert.equal(await head(cwd), true);
});

test("rejects a finalize commit that is not authored by the release bot", async (t) => {
  const cwd = await candidate(t);
  await finalize(cwd, { email: "attacker@example.com" });
  assert.equal(await head(cwd), false);
});

test("rejects a finalize commit whose subject does not match the version", async (t) => {
  const cwd = await candidate(t);
  await finalize(cwd, { subject: "chore(release): finalize 9.9.9 metadata" });
  assert.equal(await head(cwd), false);
});

test("rejects a head that changed anything outside the version metadata", async (t) => {
  const cwd = await candidate(t);
  await writeFile(join(cwd, "app.js"), "smuggled\n");
  git(cwd, "add", ".");
  commitAs(cwd, botEmail, "chore(release): finalize 1.5.0 metadata");
  assert.equal(await head(cwd), false);
});

test("rejects a head carrying more than a single finalize commit", async (t) => {
  const cwd = await candidate(t);
  await finalize(cwd);
  await writeFile(join(cwd, "packages/site/src/changelog.json"), '[{ "version": "1.5.0", "date": "2026-07-17" }]\n');
  git(cwd, "add", ".");
  commitAs(cwd, botEmail, "chore(release): finalize 1.5.0 metadata");
  assert.equal(await head(cwd), false);
});

test("rejects a head that does not descend from the frozen source", async (t) => {
  const cwd = await candidate(t);
  git(cwd, "checkout", "--orphan", "rewritten");
  git(cwd, "add", ".");
  commitAs(cwd, botEmail, "chore(release): finalize 1.5.0 metadata");
  assert.equal(await head(cwd), false);
});

test("rejects a finalize commit that leaves the workspace inconsistent", async (t) => {
  const cwd = await candidate(t);
  await finalize(cwd);
  const verifyWorkspace = async () => { throw new Error("workspace release metadata is inconsistent"); };
  assert.equal(await head(cwd, { verifyWorkspace }), false);
});

async function report(cwd, { state = "STAGED", submittedVersion = "1.5.0", recovery = "false", comments } = {}) {
  const checksum = "d".repeat(64);
  await writeFile(join(cwd, "candidate.json"), `${JSON.stringify({
    schemaVersion: 1,
    version: "1.5.0",
    kind: "normal",
    sourceSha: git(cwd, "rev-parse", "source"),
    releasePr: 42,
    initiator: "jamezrin",
    chromeZipSha256: checksum,
    artifactChecksums: { "lurkloot-1.5.0-chrome.zip": checksum },
    dockerDigests: [`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`],
    cwsState: "DRAFT",
    previewUrl: "https://next.lurkloot.pages.dev",
  })}\n`);
  await writeFile(join(cwd, "status"), [
    "published_version=1.4.0",
    `submitted_version=${submittedVersion}`,
    `submitted_state=${state}`,
    "warned=false",
    "taken_down=false",
    "",
  ].join("\n"));
  const args = [
    cli, "cws-report",
    "--candidate", "candidate.json",
    "--status", "status",
    "--head-sha", git(cwd, "rev-parse", "HEAD"),
    "--version", "1.5.0",
    "--recovery", recovery,
    "--report-dir", cwd,
  ];
  if (comments !== undefined) {
    await writeFile(join(cwd, "comments"), comments.map((body) => `${JSON.stringify(body)}\n`).join(""));
    args.push("--comments", "comments");
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: join(cwd, "outputs"), GITHUB_STEP_SUMMARY: join(cwd, "step") },
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(
    (await readFile(join(cwd, "outputs"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  return {
    outputs,
    comment: await readFile(join(cwd, "comment.md"), "utf8"),
    notes: await readFile(join(cwd, "notes.md"), "utf8"),
    step: await readFile(join(cwd, "step"), "utf8"),
  };
}

test("cws-report emits a staged check run, notes, and comment", async (t) => {
  const cwd = await candidate(t);
  const { outputs, comment, notes, step } = await report(cwd);
  assert.equal(outputs.state, "STAGED");
  assert.equal(outputs.status, "completed");
  assert.equal(outputs.conclusion, "success");
  assert.equal(outputs.title, "CWS candidate staged");
  assert.equal(outputs.summary, "v1.5.0 is approved and ready for final PR approval and merge.");
  assert.equal(outputs.pr, "42");
  assert.equal(outputs.should_comment, "true");
  assert.equal(comment, "<!-- lurkloot-release:1.5.0:cws:STAGED -->\n@jamezrin, candidate **v1.5.0** is now **STAGED**. v1.5.0 is approved and ready for final PR approval and merge.\n");
  assert.match(notes, /^Candidate for release PR #42\. Chrome Web Store version 1\.5\.0 last reported STAGED\./);
  assert.match(step, /## CWS status for v1\.5\.0/);
});

test("cws-report asks for a finalize commit only while the changelog is undated", async (t) => {
  const cwd = await candidate(t);
  assert.equal((await report(cwd)).outputs.finalize, "true");
  await finalize(cwd);
  assert.equal((await report(cwd)).outputs.finalize, "false");
});

test("cws-report leaves a pending review in progress with no conclusion", async (t) => {
  const cwd = await candidate(t);
  const { outputs } = await report(cwd, { state: "PENDING_REVIEW" });
  assert.equal(outputs.status, "in_progress");
  assert.equal(outputs.conclusion, "");
  assert.equal(outputs.finalize, "false");
});

test("cws-report blocks a staged candidate whose head drifted", async (t) => {
  const cwd = await candidate(t);
  await writeFile(join(cwd, "app.js"), "smuggled\n");
  git(cwd, "add", ".");
  commitAs(cwd, botEmail, "chore(release): finalize 1.5.0 metadata");
  const { outputs, comment } = await report(cwd);
  assert.equal(outputs.state, "CANDIDATE_CHANGED");
  assert.equal(outputs.conclusion, "failure");
  assert.match(outputs.summary, /no longer matches frozen source/);
  assert.match(comment, /do not merge this head/);
});

test("cws-report suppresses a comment that already exists", async (t) => {
  const cwd = await candidate(t);
  const first = await report(cwd, { comments: [] });
  assert.equal(first.outputs.should_comment, "true");
  const repeat = await report(cwd, { comments: ["unrelated", first.comment] });
  assert.equal(repeat.outputs.should_comment, "false");
});

test("cws-report refuses candidate metadata for another version", async (t) => {
  const cwd = await candidate(t);
  await report(cwd);
  const result = spawnSync(process.execPath, [
    cli, "cws-report",
    "--candidate", "candidate.json",
    "--status", "status",
    "--head-sha", git(cwd, "rev-parse", "HEAD"),
    "--version", "9.9.9",
    "--report-dir", cwd,
  ], { cwd, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match v9\.9\.9/);
});
