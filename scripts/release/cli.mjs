#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { changelogPath, checkWorkspace, prepareWorkspace } from "../release.mjs";
import {
  checkConclusion,
  checkTitle,
  renderReleaseComment,
  renderReleaseNotes,
  renderStepSummary,
  shouldComment,
  stateGuidance,
} from "./github.mjs";
import { buildCandidateMetadata, parseChecksums } from "./metadata.mjs";
import { parseCandidateMetadata, renderCandidateMetadata } from "./model.mjs";
import { deriveCwsState, parseStatusOutputs } from "./monitor.mjs";

const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

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

async function emitOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
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

// A staged candidate may only carry the finalize commit this workflow pushes itself; anything else
// means the reviewed head drifted away from the frozen candidate source.
export async function verifyCandidateHead({
  cwd = process.cwd(),
  version,
  sourceSha,
  headSha,
  verifyWorkspace = checkWorkspace,
}) {
  const ancestry = await run("git", ["merge-base", "--is-ancestor", sourceSha, headSha], { cwd, allowFailure: true });
  if (ancestry.code !== 0) return false;
  const drift = await run("git", [
    "diff",
    "--quiet",
    sourceSha,
    headSha,
    "--",
    ".",
    ":(exclude)package.json",
    ":(exclude)packages/*/package.json",
    `:(exclude)${changelogPath}`,
  ], { cwd, allowFailure: true });
  if (drift.code !== 0) return false;
  if (headSha === sourceSha) return true;
  const count = await run("git", ["rev-list", "--count", `${sourceSha}..${headSha}`], { cwd });
  if (count.stdout !== "1") return false;
  const author = await run("git", ["show", "-s", "--format=%ae", headSha], { cwd });
  if (author.stdout !== botEmail) return false;
  const subject = await run("git", ["show", "-s", "--format=%s", headSha], { cwd });
  if (subject.stdout !== `chore(release): finalize ${version} metadata`) return false;
  try {
    await verifyWorkspace();
  } catch {
    return false;
  }
  return true;
}

async function changelogHasDate(version) {
  const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
  return Boolean(changelog.find((entry) => entry.version === version)?.date);
}

function parseCommentBodies(text) {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function readCandidate(path, expectedVersion) {
  const metadata = parseCandidateMetadata(await readFile(path, "utf8"));
  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(`candidate metadata version ${metadata.version} does not match v${expectedVersion}`);
  }
  return metadata;
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

async function candidateRead({ file, version }) {
  const metadata = await readCandidate(file, version);
  await emitOutputs({
    version: metadata.version,
    pr: metadata.releasePr,
    initiator: metadata.initiator,
    source_sha: metadata.sourceSha,
  });
}

async function cwsReport(values) {
  const metadata = await readCandidate(values.candidate, values.version);
  const { version, sourceSha, releasePr: pr } = metadata;
  const status = parseStatusOutputs(await readFile(values.status, "utf8"));
  const headSha = values["head-sha"];
  const recoveryRequested = values.recovery === "true";
  const probe = deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested });
  const candidateHeadValid = probe.state === "STAGED"
    ? await verifyCandidateHead({ version, sourceSha, headSha })
    : true;
  const { state, recovery } = deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested, candidateHeadValid });
  const summary = stateGuidance(state, { version, pr, sourceSha, submittedVersion: status.submittedVersion, recovery });
  const check = checkConclusion(state, { recovery });
  const conclusion = check.conclusion ?? "";
  const reportDir = values["report-dir"];
  await writeFile(join(reportDir, "comment.md"), `${renderReleaseComment({ metadata, state, summary })}\n`);
  await writeFile(join(reportDir, "notes.md"), `${renderReleaseNotes({ version, pr, state, summary })}\n`);
  const existingBodies = values.comments ? parseCommentBodies(await readFile(values.comments, "utf8")) : [];
  await emitOutputs({
    state,
    status: check.status,
    conclusion,
    title: checkTitle(state, { recovery }),
    summary,
    pr,
    finalize: String(state === "STAGED" && !(await changelogHasDate(version))),
    should_comment: String(shouldComment(existingBodies, version, state)),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderStepSummary({ version, pr, state, conclusion, summary }));
  }
}

const commands = {
  "version": {
    usage: "version",
    run: async () => {
      const manifest = JSON.parse(await readFile("package.json", "utf8"));
      process.stdout.write(`${manifest.version}\n`);
    },
  },
  "check": {
    usage: "check",
    run: () => checkWorkspace(),
  },
  "prepare-workspace": {
    usage: "prepare-workspace VERSION [--date YYYY-MM-DD]",
    positionals: 1,
    options: { date: { type: "string" } },
    run: ({ positionals, values }) => prepareWorkspace(positionals[0], values.date),
  },
  "metadata create": {
    usage: "metadata create",
    run: createMetadata,
  },
  "metadata verify": {
    usage: "metadata verify CANDIDATE_JSON ASSET_DIR",
    positionals: 2,
    run: async ({ positionals }) => { await verifyCandidateAssets(positionals[0], positionals[1]); },
  },
  "candidate read": {
    usage: "candidate read --file CANDIDATE_JSON [--version VERSION]",
    options: { file: { type: "string" }, version: { type: "string" } },
    requires: ["file"],
    run: ({ values }) => candidateRead(values),
  },
  "verify-hotfix": {
    usage: "verify-hotfix --main REF --develop REF --candidate REF",
    options: { main: { type: "string" }, develop: { type: "string" }, candidate: { type: "string" } },
    requires: ["main", "develop", "candidate"],
    run: ({ values }) => verifyHotfixHistory({
      mainRef: values.main,
      developRef: values.develop,
      candidateRef: values.candidate,
    }),
  },
  "cws-report": {
    usage: "cws-report --candidate CANDIDATE_JSON --status STATUS_FILE --head-sha SHA --version VERSION --report-dir DIR [--recovery true|false] [--comments FILE]",
    options: {
      candidate: { type: "string" },
      status: { type: "string" },
      "head-sha": { type: "string" },
      version: { type: "string" },
      "report-dir": { type: "string" },
      recovery: { type: "string", default: "false" },
      comments: { type: "string" },
    },
    requires: ["candidate", "status", "head-sha", "version", "report-dir"],
    run: ({ values }) => cwsReport(values),
  },
};

const usage = `usage: cli.mjs <${Object.values(commands).map((command) => command.usage).join(" | ")}>`;

function resolve(argv) {
  const name = [argv.slice(0, 2).join(" "), argv[0]].find((candidate) => Object.hasOwn(commands, candidate));
  if (!name) throw new Error(usage);
  return { name, command: commands[name], rest: argv.slice(name.split(" ").length) };
}

async function main() {
  const { name, command, rest } = resolve(process.argv.slice(2));
  const { values, positionals } = parseArgs({
    args: rest,
    options: command.options ?? {},
    allowPositionals: true,
  });
  if (positionals.length !== (command.positionals ?? 0)) throw new Error(`usage: cli.mjs ${command.usage}`);
  for (const option of command.requires ?? []) {
    if (!values[option]) throw new Error(`--${option} is required by ${name}`);
  }
  await command.run({ values, positionals });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  });
}
