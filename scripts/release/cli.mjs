#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { changelogPath, checkWorkspace, prepareWorkspace } from "../release.mjs";
import { parseCandidateHeadEvidence } from "./evidence.mjs";
import {
  checkConclusion,
  checkTitle,
  renderReleaseStatus,
  renderReleaseComment,
  renderReleaseNotes,
  renderMilestone,
  renderStepSummary,
  shouldComment,
  stateGuidance,
  submitCandidateCheck,
} from "./github.mjs";
import { buildCandidateMetadata, parseChecksums } from "./metadata.mjs";
import { assertCandidateVersion, compareVersions, parseCandidateMetadata, renderCandidateMetadata } from "./model.mjs";
import { deriveCwsState, parseStatusOutputs } from "./monitor.mjs";
import { deriveReleasePolicy } from "./policy.mjs";
import { deriveReconciliation } from "./reconcile.mjs";

const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function emitOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    const normalized = value == null ? "" : String(value);
    if (/\r|\n/.test(normalized)) throw new Error(`workflow output ${key} contains a line break`);
    return `${key}=${normalized}`;
  });
  for (const line of lines) console.log(line);
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

export async function verifyHotfixHistory({ mainAncestor, developCommits, candidateCommits }) {
  if (!mainAncestor) throw new Error("hotfix candidate must descend from main");
  const candidateSet = new Set(candidateCommits);
  const leakedCommit = developCommits.find((commit) => candidateSet.has(commit));
  if (leakedCommit) throw new Error(`hotfix candidate contains unreleased develop commit ${leakedCommit}`);
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
  version,
  sourceSha,
  headSha,
  descendsFromSource,
  metadataOnly,
  commitCount,
  authorEmail,
  subject,
  verifyWorkspace = checkWorkspace,
}) {
  if (!descendsFromSource || !metadataOnly) return false;
  if (headSha === sourceSha) return true;
  if (commitCount !== 1) return false;
  if (authorEmail !== botEmail) return false;
  if (subject !== `chore(release): finalize ${version} metadata`) return false;
  try {
    await verifyWorkspace();
  } catch {
    return false;
  }
  return true;
}

function parseBooleanEvidence(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function parseCommitList(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
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
    label: required("RELEASE_LABEL"),
    stableVersion: required("STABLE_VERSION"),
    stableSha: required("STABLE_SHA"),
    developSha: process.env.DEVELOP_SHA || null,
    sourceSha: required("SOURCE_SHA"),
    authorizedSha: required("AUTHORIZED_SHA"),
    releasePr: required("RELEASE_PR"),
    initiator: required("INITIATOR"),
    authorizedBy: required("AUTHORIZED_BY"),
    trustedToolsSha: required("TRUSTED_TOOLS_SHA"),
    createdAt: required("CREATED_AT"),
    reconciledAt: required("RECONCILED_AT"),
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

function metadataOutputs(metadata) {
  return {
    schema_version: metadata.schemaVersion,
    version: metadata.version,
    kind: metadata.kind,
    label: metadata.label,
    stable_version: metadata.stableVersion,
    stable_sha: metadata.stableSha,
    develop_sha: metadata.developSha,
    source_sha: metadata.sourceSha,
    authorized_sha: metadata.authorizedSha,
    release_pr: metadata.releasePr,
    initiator: metadata.initiator,
    authorized_by: metadata.authorizedBy,
    trusted_tools_sha: metadata.trustedToolsSha,
    created_at: metadata.createdAt,
    reconciled_at: metadata.reconciledAt,
    chrome_zip_sha256: metadata.chromeZipSha256,
    artifact_checksums: JSON.stringify(metadata.artifactChecksums),
    docker_digests: JSON.stringify(metadata.dockerDigests),
    cws_state: metadata.cwsState,
    preview_url: metadata.previewUrl,
  };
}

async function metadataRead({ file, version }) {
  await emitOutputs(metadataOutputs(await readCandidate(file, version)));
}

async function cwsReport(values) {
  const metadata = await readCandidate(values.candidate, values.version);
  const { version, sourceSha, releasePr: pr } = metadata;
  const status = parseStatusOutputs(await readFile(values.status, "utf8"));
  const headSha = values["head-sha"];
  const recoveryRequested = values.recovery === "true";
  const probe = deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested });
  const headEvidence = parseCandidateHeadEvidence(await readFile(values["head-evidence"], "utf8"));
  const candidateHeadValid = probe.state === "STAGED"
    ? await verifyCandidateHead({
      version,
      sourceSha,
      headSha,
      ...headEvidence,
    })
    : true;
  const { state, recovery } = deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested, candidateHeadValid });
  const summary = stateGuidance(state, { version, pr, sourceSha, submittedVersion: status.submittedVersion, recovery });
  const check = checkConclusion(state, { recovery });
  const conclusion = check.conclusion ?? "";
  const reportDir = values["report-dir"];
  await writeFile(join(reportDir, "comment.md"), `${renderReleaseComment({ metadata, state, summary })}\n`);
  await writeFile(join(reportDir, "status.md"), `${renderReleaseStatus({
    version,
    kind: metadata.kind,
    pr,
    sourceSha,
    state,
    checksum: metadata.chromeZipSha256,
    releaseUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/v${version}`,
    previewUrl: metadata.previewUrl,
    workflowUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    activity: summary,
  })}\n`);
  if (state === "STAGED") {
    await writeFile(join(reportDir, "milestone.md"), `${renderMilestone({
      metadata,
      milestone: "cws-staged",
      guidance: `The frozen candidate is approved. Complete final PR review and merge PR #${pr} to promote it.`,
    })}\n`);
  }
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
    should_milestone: String(state === "STAGED" && shouldComment(existingBodies, version, "milestone:cws-staged")),
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
  "metadata read": {
    usage: "metadata read --file CANDIDATE_JSON [--version VERSION]",
    options: { file: { type: "string" }, version: { type: "string" } },
    requires: ["file"],
    run: ({ values }) => metadataRead(values),
  },
  "candidate read": {
    usage: "candidate read --file CANDIDATE_JSON [--version VERSION]",
    options: { file: { type: "string" }, version: { type: "string" } },
    requires: ["file"],
    run: ({ values }) => candidateRead(values),
  },
  "candidate validate-version": {
    usage: "candidate validate-version --version VERSION --active-versions JSON [--replacing-version VERSION]",
    options: {
      version: { type: "string" },
      "active-versions": { type: "string" },
      "replacing-version": { type: "string" },
    },
    requires: ["version", "active-versions"],
    run: async ({ values }) => {
      const manifest = JSON.parse(await readFile("package.json", "utf8"));
      assertCandidateVersion({
        version: values.version,
        stableVersion: manifest.version,
        activeVersions: JSON.parse(values["active-versions"]),
        replacingVersion: values["replacing-version"],
      });
    },
  },
  "policy": {
    usage: "policy --input INPUT_JSON",
    options: { input: { type: "string" } },
    requires: ["input"],
    run: async ({ values }) => {
      const policy = deriveReleasePolicy(JSON.parse(await readFile(values.input, "utf8")));
      await emitOutputs({
        state: policy.state,
        kind: policy.kind,
        label: policy.label,
        version: policy.version,
        authorized_sha: policy.authorizedSha,
        reason: policy.reason,
      });
    },
  },
  "reconcile": {
    usage: "reconcile --input INPUT_JSON",
    options: { input: { type: "string" } },
    requires: ["input"],
    run: async ({ values }) => {
      const reconciliation = deriveReconciliation(JSON.parse(await readFile(values.input, "utf8")));
      await emitOutputs({
        action: reconciliation.action,
        convert_to_draft: reconciliation.convertToDraft,
        reason: reconciliation.reason,
      });
    },
  },
  "version less-than": {
    usage: "version less-than VERSION VERSION",
    positionals: 2,
    run: ({ positionals }) => {
      if (compareVersions(positionals[0], positionals[1]) >= 0) process.exitCode = 1;
    },
  },
  "verify-hotfix": {
    usage: "verify-hotfix --main-ancestor true|false --develop-commits FILE --candidate-commits FILE",
    options: {
      "main-ancestor": { type: "string" },
      "develop-commits": { type: "string" },
      "candidate-commits": { type: "string" },
    },
    requires: ["main-ancestor", "develop-commits", "candidate-commits"],
    run: async ({ values }) => verifyHotfixHistory({
      mainAncestor: parseBooleanEvidence(values["main-ancestor"], "main-ancestor"),
      developCommits: parseCommitList(await readFile(values["develop-commits"], "utf8")),
      candidateCommits: parseCommitList(await readFile(values["candidate-commits"], "utf8")),
    }),
  },
  "submit-check": {
    usage: "submit-check --action ACTION --version VERSION",
    options: { action: { type: "string" }, version: { type: "string" } },
    requires: ["action", "version"],
    run: ({ values }) => emitOutputs(submitCandidateCheck(values.action, values.version)),
  },
  "render-status": {
    usage: "render-status --input STATUS_JSON --output FILE",
    options: { input: { type: "string" }, output: { type: "string" } },
    requires: ["input", "output"],
    run: async ({ values }) => {
      const status = JSON.parse(await readFile(values.input, "utf8"));
      await writeFile(values.output, `${renderReleaseStatus(status)}\n`);
    },
  },
  "cws-report": {
    usage: "cws-report --candidate CANDIDATE_JSON --status STATUS_FILE --head-sha SHA --head-evidence JSON_FILE --version VERSION --report-dir DIR [--recovery true|false] [--comments FILE]",
    options: {
      candidate: { type: "string" },
      status: { type: "string" },
      "head-sha": { type: "string" },
      "head-evidence": { type: "string" },
      version: { type: "string" },
      "report-dir": { type: "string" },
      recovery: { type: "string", default: "false" },
      comments: { type: "string" },
    },
    requires: [
      "candidate",
      "status",
      "head-sha",
      "head-evidence",
      "version",
      "report-dir",
    ],
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
