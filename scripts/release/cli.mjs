#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  cancelAction,
  ChromeWebStoreClient,
  normalizeStatus,
  serviceAccountToken,
  submitAction,
  submittedAction,
  uploadAction,
  waitForCancellation,
  waitForUpload,
} from "../cws.mjs";
import { changelogPath, checkWorkspace, packagePaths, prepareWorkspace } from "../release.mjs";
import { activeCandidateVersions, assertMonitorVersion, countLabel, deriveHeadEvidence, isMetadataOnly, recognizedCount } from "./monitor-run.mjs";
import { candidateReleases, findCandidateForPr, isActiveCandidate } from "./candidates.mjs";
import {
  assertForwardInputs,
  forwardBranch,
  forwardConflictIssue,
  forwardMergeMessage,
  forwardPullRequest,
  forwardSummary,
} from "./forward.mjs";
import {
  assertCancelPullRequestState,
  assertCancelledTerminal,
  assertNotPublished,
  cancellationOutcome,
  parseCancellationInputs,
  selectRetirableContainerVersion,
} from "./cancellation.mjs";
import { ensureComment, upsertComment } from "./comments.mjs";
import {
  checkConclusion,
  checkTitle,
  lifecycleMilestoneGuidance,
  milestoneMarker,
  renderReleaseStatus,
  renderReleaseComment,
  renderReleaseNotes,
  renderMilestone,
  renderStepSummary,
  shouldComment,
  stateGuidance,
  statusMarker,
  submitCandidateCheck,
} from "./github.mjs";
import { GitHubClient } from "./github-api.mjs";
import { gatherRepositoryState, inspectReleasePr } from "./inspect.mjs";
import { recognizedReleaseLabels } from "./authorization.mjs";
import { buildCandidateMetadata, parseChecksums } from "./metadata.mjs";
import {
  assertCandidateOwnership,
  assertEvidenceMatches,
  assertPullRequestState,
  assertSubmitAction,
  buildSubmissionEvidence,
  submissionNarrative,
} from "./submission.mjs";
import {
  assertCandidateVersion,
  compareVersions,
  parseCandidateMetadata,
  promotionCwsAction,
  renderCandidateMetadata,
  selectPromotionCandidate,
  validatePromotionPullRequest,
} from "./model.mjs";
import {
  assertDigestFilenames,
  assertPrepareInputs,
  assertPreparePullRequest,
  assertSameRepository,
  canonicalReleaseNotes,
  cwsRollbackAction,
  ownsCanonicalReferences,
  selectRunOwnedContainerVersion,
  stagingReleaseNotes,
} from "./prepare.mjs";
import {
  assertPromotableMetadata,
  desiredPromotionLabel,
  dockerPromotionTags,
  stableMilestoneBody,
  stableReleaseNotes,
} from "./promotion.mjs";
import { deriveCwsState } from "./monitor.mjs";
import { deriveReleasePolicy } from "./policy.mjs";
import { deriveReconciliation } from "./reconcile.mjs";

const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// GITHUB_API_URL is provided by the Actions runner and points at the host's API root, so the
// controller works unchanged on GitHub Enterprise.
function releaseClient() {
  return new GitHubClient({
    token: required("GITHUB_TOKEN"),
    repo: required("GITHUB_REPOSITORY"),
    ...(process.env.GITHUB_API_URL ? { origin: process.env.GITHUB_API_URL } : {}),
  });
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

function changelogHasDate(changelog, version) {
  return Boolean(changelog.find((entry) => entry.version === version)?.date);
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

// Release tooling is only trusted at the SHA the caller pinned; resolving main independently and
// comparing keeps a mid-run branch move from swapping the tools underneath a release.
async function assertTrustedTools(client, expected) {
  if (!/^[0-9a-f]{40}$/.test(expected ?? "")) throw new Error("trusted tools ref must be a commit SHA");
  const live = await client.refSha("main");
  if (live !== expected) throw new Error(`trusted tools ref ${expected} does not match main at ${live}`);
  return live;
}

const finalizeAuthor = { name: "github-actions[bot]", email: botEmail };
const releaseMetadataFiles = [...packagePaths, changelogPath];

/**
 * Writes the candidate's release-metadata files into an isolated directory.
 *
 * The monitor checks out trusted tooling from main, not the candidate, so these files must come
 * from the API at the candidate's own source commit. Reading the checked-out copies would prepare
 * main's metadata and commit it to the candidate branch.
 */
async function materializeSourceMetadata(client, sourceSha, directory) {
  for (const path of releaseMetadataFiles) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await client.fileAtRef(path, sourceSha));
  }
  return directory;
}

// prepareWorkspace resolves its paths relative to the process working directory, so the candidate
// metadata is prepared from inside its own materialized copy and restored afterwards.
async function prepareSourceMetadata(directory, version, date) {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    await prepareWorkspace(version, date);
  } finally {
    process.chdir(previous);
  }
}

// Publishes the finalize commit through the git data API. Building it from blobs avoids a
// credentialed checkout and a `git push`, and the non-forcing ref update makes a branch that moved
// mid-run fail loudly instead of being overwritten.
async function pushFinalizeCommit(client, { version, branch, sourceSha, directory }) {
  const source = await client.commit(sourceSha);
  const entries = [];
  for (const path of releaseMetadataFiles) {
    entries.push({
      path,
      mode: "100644",
      type: "blob",
      sha: await client.createBlob(await readFile(join(directory, path), "utf8")),
    });
  }
  const tree = await client.createTree(source.commit.tree.sha, entries);
  const commit = await client.createCommit({
    message: `chore(release): finalize ${version} metadata`,
    tree,
    parents: [sourceSha],
    author: { ...finalizeAuthor, date: new Date().toISOString() },
  });
  await client.updateBranch(branch, commit);
  return commit;
}

async function monitorCandidate(client, { version, recovery, reportDir }) {
  const candidateDir = join(reportDir, "candidate");
  await downloadReleaseAssets(client, `v${version}`, candidateDir);
  const metadata = await verifyCandidateAssets(join(candidateDir, "candidate.json"), candidateDir);
  if (metadata.version !== version) throw new Error(`candidate metadata version ${metadata.version} does not match v${version}`);
  if (metadata.schemaVersion !== 2 || metadata.sourceSha !== metadata.authorizedSha) {
    console.log(`ignoring non-v2 or unauthorized candidate v${version}`);
    return;
  }
  const { releasePr: pr, sourceSha, label } = metadata;
  if (await client.tagCommitSha(`v${version}`) !== sourceSha) {
    throw new Error(`tag v${version} does not point at the candidate source`);
  }

  let live = await client.pullRequest(pr);
  if (live.state !== "open") return;
  const branch = live.head.ref;
  let headSha = live.head.sha;
  const labelNames = (live.labels ?? []).map((entry) => entry.name);
  const labelValid = countLabel(labelNames, label) === 1 && recognizedCount(labelNames) === 1;
  const readyValid = live.draft === false;

  const headCommit = await client.commit(headSha);
  const evidence = deriveHeadEvidence({
    comparison: await client.compare(sourceSha, headSha),
    headCommit: {
      authorEmail: headCommit.commit?.author?.email ?? "",
      subject: (headCommit.commit?.message ?? "").split("\n")[0],
    },
    labelValid,
    readyValid,
  });

  const store = await cwsClient();
  const storeStatus = normalizeStatus(await store.status());
  const report = await buildCwsReport(client, {
    metadata,
    status: {
      publishedVersion: storeStatus.publishedVersion ?? "none",
      submittedVersion: storeStatus.submittedVersion ?? "none",
      submittedState: storeStatus.submittedState ?? "none",
      warned: storeStatus.warned,
      takenDown: storeStatus.takenDown,
    },
    headSha,
    headEvidence: evidence,
    recovery,
    reportDir,
    comments: await client.issueComments(pr),
    // The changelog that decides whether finalization is still needed is the candidate's own.
    changelog: JSON.parse(await client.fileAtRef(changelogPath, sourceSha)),
  });

  // Any mutation below must act on the head this report describes; re-reading the PR before each
  // one keeps a mid-run push from being blessed by a stale report.
  const assertHead = async (expected) => {
    const current = await client.pullRequest(pr);
    if (current.head.sha !== expected) throw new Error("CANDIDATE_CHANGED");
    return current;
  };

  if (report.finalize) {
    live = await assertHead(sourceSha);
    if (live.draft !== false || live.state !== "open") throw new Error("CANDIDATE_CHANGED");
    if (countLabel((live.labels ?? []).map((entry) => entry.name), label) !== 1) throw new Error("CANDIDATE_CHANGED");
    const workspace = join(reportDir, "workspace");
    await materializeSourceMetadata(client, sourceSha, workspace);
    await prepareSourceMetadata(workspace, version, new Date().toISOString().slice(0, 10));
    await assertHead(sourceSha);
    headSha = await pushFinalizeCommit(client, { version, branch, sourceSha, directory: workspace });
    await client.dispatchWorkflow("pr-validation.yml", branch);
  }

  await assertHead(headSha);
  await client.createCheckRun({
    name: "cws-release-ready",
    head_sha: headSha,
    status: report.status,
    ...(report.conclusion ? { conclusion: report.conclusion } : {}),
    output: { title: report.title, summary: report.summary },
  });

  await assertHead(headSha);
  const release = await client.releaseByTag(`v${version}`);
  await client.updateRelease(release.id, {
    prerelease: true,
    make_latest: "false",
    body: await readFile(join(reportDir, "notes.md"), "utf8"),
  });

  await assertHead(headSha);
  const comments = await client.issueComments(pr);
  await upsertComment(client, pr, {
    marker: statusMarker(pr),
    comments,
    body: await readFile(join(reportDir, "status.md"), "utf8"),
  });

  if (!report.shouldMilestone) return;
  await assertHead(headSha);
  await ensureComment(client, pr, {
    marker: milestoneMarker(version, "cws-staged"),
    comments,
    body: await readFile(join(reportDir, "milestone.md"), "utf8"),
  });
}

// Re-reads the merged PR and re-asserts the full promotion contract. Every stable mutation calls
// this first, so a label removal or a check flipping red between steps halts the rest.
async function revalidatePromotion(client, { pr, expectedHeadSha, expectedMergeSha, expectedLabel }) {
  const live = await client.promotionPullRequest(pr);
  return validatePromotionPullRequest({
    ...live,
    expectedHeadSha,
    expectedMergeSha,
    expectedLabel,
  });
}

async function resolvePromotionCandidate(client, { pr, assetDir }) {
  const live = await client.promotionPullRequest(pr);
  const desiredLabel = desiredPromotionLabel(live.labels);
  if (!desiredLabel) return { active: false };

  const releases = candidateReleases(await client.releases());
  const found = [];
  for (const release of releases) {
    const raw = await client.releaseAsset(release.asset);
    let metadata;
    try {
      metadata = parseCandidateMetadata(raw);
    } catch {
      continue;
    }
    if (!isActiveCandidate(release, metadata)) continue;
    if (metadata.label !== desiredLabel) continue;
    found.push(metadata);
  }
  const metadata = selectPromotionCandidate(found, pr);
  assertPromotableMetadata(metadata, { pr });

  await downloadReleaseAssets(client, `v${metadata.version}`, assetDir);
  await verifyCandidateAssets(join(assetDir, "candidate.json"), assetDir);

  // This pass establishes the head and merge identities the later stable mutations pin against, so
  // it validates the contract using the live values rather than pre-existing expectations.
  const current = await client.promotionPullRequest(pr);
  const validated = validatePromotionPullRequest({
    ...current,
    expectedHeadSha: current.headSha,
    expectedMergeSha: current.mergeSha,
    expectedLabel: metadata.label,
  });

  if (await client.tagCommitSha(`v${metadata.version}`) !== metadata.sourceSha) {
    throw new Error(`tag v${metadata.version} does not point at the candidate source`);
  }

  // The merged head must be the frozen source plus exactly the bot's finalize commit, and that
  // commit may only touch release metadata.
  const comparison = await client.compare(metadata.sourceSha, validated.headSha);
  if (comparison.commits.length !== 1) throw new Error("merged head must add exactly one finalize commit");
  if (!isMetadataOnly(comparison.files)) throw new Error("finalize commit touched more than release metadata");
  const headCommit = await client.commit(validated.headSha);
  if (headCommit.commit?.author?.email !== botEmail) throw new Error("finalize commit was not authored by the release bot");
  if ((headCommit.commit?.message ?? "").split("\n")[0] !== `chore(release): finalize ${metadata.version} metadata`) {
    throw new Error("finalize commit subject does not match the candidate version");
  }
  if (!await client.isAncestor(validated.headSha, validated.mergeSha)) {
    throw new Error("merged head is not an ancestor of the merge commit");
  }

  return {
    active: true,
    version: metadata.version,
    kind: metadata.kind,
    initiator: metadata.initiator,
    head_sha: validated.headSha,
    merge_sha: validated.mergeSha,
    label: metadata.label,
  };
}

async function cancelCandidate(values) {
  const pr = Number(values.pr);
  const inputs = parseCancellationInputs({
    version: values.version,
    expectedSha: values["expected-sha"],
    expectedLiveHeadSha: values["expected-live-head-sha"],
    desiredLabels: values["desired-labels"],
    expectedPrState: values["expected-pr-state"],
    disposition: values.disposition,
  });
  const { version } = inputs;
  const client = releaseClient();
  await assertTrustedTools(client, values["trusted-tools"]);

  const release = await downloadReleaseAssets(client, `v${version}`, values["candidate-dir"]);
  const metadata = await readCandidate(join(values["candidate-dir"], "candidate.json"), version);
  assertCandidateOwnership(metadata, { version, pr, sourceSha: inputs.expectedSha });
  if (release.prerelease !== true) throw new Error(`v${version} must remain a prerelease`);

  const revalidate = async () => {
    const live = await client.pullRequest(pr);
    assertCancelPullRequestState(live, inputs);
    return live;
  };
  let live = await revalidate();

  const store = await cwsClient();
  const before = assertNotPublished(await store.status(), version);
  if (cancelAction(before, version) === "cancel") {
    await revalidate();
    try {
      await store.cancelSubmission();
    } catch (error) {
      throw new Error(`Chrome Web Store could not cancel ${version} from ${before.submittedItemRevisionStatus.state}. Use the Developer Dashboard to resolve it before replacing or abandoning this candidate: ${error.message}`);
    }
    await waitForCancellation(store, version);
  }
  assertCancelledTerminal(await store.status(), version);

  if (inputs.expectedPrState === "open" && live.draft !== true) {
    live = await revalidate();
    await client.convertToDraft(live.node_id);
  }

  await revalidate();
  await client.updateRelease(release.id, {
    name: `v${version} cancelled`,
    prerelease: true,
    make_latest: "false",
    body: `Candidate v${version} was cancelled and retained with its tag and assets for audit.`,
  });

  if (inputs.disposition === "retire") {
    const owner = required("GITHUB_REPOSITORY_OWNER").toLowerCase();
    const { path, versions } = await client.containerVersions(owner, "lurkloot-cli");
    const id = selectRetirableContainerVersion(versions, version);
    if (id) {
      await revalidate();
      await client.deleteContainerVersion(path, id);
    }
  }
}

async function uploadAssets(client, release, directory, names) {
  for (const name of names) {
    await client.uploadReleaseAsset(release, name, await readFile(join(directory, name)));
  }
}

/**
 * Resolves candidate identity either from controller inputs or, for PR-number-only recovery, from
 * the existing candidate's own metadata.
 *
 * Recovery must never accept an operator-supplied version or source: the whole point is that the
 * frozen candidate describes itself, so a mistyped recovery cannot retarget a different commit.
 */
/**
 * Opens the main to develop synchronization PR after a stable release.
 *
 * The merge itself runs server-side via the merges API, which is the API equivalent of
 * `git merge --no-ff` and reports conflicts as a distinct outcome. main is re-resolved before every
 * mutation so a release landing mid-run cannot be silently skipped over.
 */
async function forwardRelease(values) {
  const { version, kind } = values;
  const expectedMainSha = values["expected-main-sha"];
  assertForwardInputs({ kind, expectedMainSha, version });
  const client = releaseClient();
  const branch = forwardBranch(version);

  const assertMain = async () => {
    if (await client.refSha("main") !== expectedMainSha) throw new Error("live main changed before forward merge");
  };
  await assertMain();

  const summary = async (text) => {
    process.stdout.write(text);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  };

  const existing = await client.pullRequests({ head: branch, base: "develop" });
  if (existing.length || await client.branchShaOrNull(branch)) {
    await summary(forwardSummary({ version, outcome: "exists", pr: existing[0]?.number ?? null }));
    return;
  }

  await client.createBranch(branch, await client.refSha("develop"));
  const outcome = await client.mergeBranches(branch, "main", forwardMergeMessage({ kind, version }));
  if (outcome === "conflict") {
    const issue = await client.createIssue({
      ...forwardConflictIssue({ kind, version }),
      labels: ["release-forward-merge"],
    });
    await summary(forwardSummary({ version, outcome: "conflict", issueUrl: issue.html_url }));
    return;
  }

  await assertMain();
  const created = await client.createPullRequest({
    base: "develop",
    head: branch,
    ...forwardPullRequest({ kind, version }),
  });
  await client.addLabels(created.number, ["release-forward-merge"]);
  await summary(forwardSummary({ version, outcome: "opened", pr: created.number }));
}

async function prepareResolve(values) {
  const pr = Number(values.pr);
  if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
  const client = releaseClient();
  const trustedMain = await client.refSha("main");

  if (values["expected-sha"]) {
    if (values["trusted-tools"] !== trustedMain) {
      throw new Error("trusted_tools_ref does not match independently resolved main");
    }
    const stableVersion = values["stable-version"]
      || JSON.parse(await client.fileAtRef("package.json", values["stable-sha"])).version;
    await emitOutputs({
      pr,
      candidate_sha: values["expected-sha"],
      version: values.version,
      kind: values.kind,
      release_label: values.label,
      authorized_by: values["authorized-by"],
      stable_sha: values["stable-sha"],
      stable_version: stableVersion,
      develop_sha: values["develop-sha"],
      trusted_tools_ref: trustedMain,
    });
    return;
  }

  const found = await findCandidateForPr(client, pr);
  if (!found) throw new Error(`No schema v2 candidate found for PR #${pr}`);
  const { metadata } = found;
  await emitOutputs({
    pr,
    candidate_sha: metadata.sourceSha,
    version: metadata.version,
    kind: metadata.kind,
    release_label: metadata.label,
    authorized_by: metadata.authorizedBy,
    stable_sha: metadata.stableSha,
    stable_version: metadata.stableVersion,
    develop_sha: metadata.developSha ?? "",
    trusted_tools_ref: trustedMain,
  });
}

async function preparePublish(values) {
  const pr = Number(values.pr);
  const { version, label } = values;
  const expectedSha = values["expected-sha"];
  const stagingId = values["staging-id"];
  const assetDir = values["assets"];
  const stateDir = values["state-dir"];
  const client = releaseClient();
  const tag = `v${version}`;

  const revalidate = async ({ requireOpen = true } = {}) => {
    const live = await client.pullRequest(pr);
    assertPreparePullRequest(live, { expectedSha, expectedLabel: label, requireOpen });
    return live;
  };

  const live = await revalidate();
  assertSameRepository(live, client.repo);
  assertDigestFilenames(await readdir(values["digests"]));

  // The metadata is built and validated before anything is staged, so an invalid candidate never
  // reaches even the run-scoped references.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const metadata = buildCandidateMetadata({
    version,
    kind: values.kind,
    label,
    stableVersion: values["stable-version"],
    stableSha: values["stable-sha"],
    developSha: values["develop-sha"] || null,
    sourceSha: expectedSha,
    authorizedSha: expectedSha,
    releasePr: pr,
    initiator: values.initiator,
    authorizedBy: values["authorized-by"],
    trustedToolsSha: values["trusted-tools"],
    createdAt: now,
    reconciledAt: now,
    checksumsText: await readFile(join(assetDir, "SHA256SUMS"), "utf8"),
    digestNames: await readdir(values["digests"]),
    previewUrl: values["preview-url"],
  });
  await writeFile(join(assetDir, "candidate.json"), renderCandidateMetadata(metadata));
  await verifyCandidateAssets(join(assetDir, "candidate.json"), assetDir);

  // Stage everything under an immutable run-scoped identity first, so the canonical references are
  // only touched once a complete, verified artifact set already exists.
  await revalidate();
  await client.createTag(stagingId, expectedSha);
  await revalidate();
  const staging = await client.createRelease({
    tag_name: stagingId,
    name: stagingId,
    prerelease: true,
    make_latest: "false",
    body: stagingReleaseNotes({ version, runId: values["run-id"], runAttempt: values["run-attempt"] }),
  });
  await revalidate();
  const assetNames = (await readdir(assetDir)).sort();
  await uploadAssets(client, staging, assetDir, assetNames);

  // Capture prior canonical state before overwriting it; rollback restores exactly this.
  await mkdir(stateDir, { recursive: true });
  const priorTagSha = await client.tagShaOrNull(tag);
  const priorRelease = await client.releaseByTagOrNull(tag);
  const priorLatest = await client.latestReleaseTag() === tag;
  const rollbackDir = join(stateDir, "rollback-assets");
  let priorCandidate = null;
  if (priorRelease) {
    await downloadReleaseAssets(client, tag, rollbackDir);
    priorCandidate = await readCandidate(join(rollbackDir, "candidate.json")).catch(() => null);
  }
  await writeFile(join(stateDir, "backup.json"), `${JSON.stringify({
    tag,
    priorTagSha,
    priorReleaseId: priorRelease?.id ?? null,
    priorReleaseName: priorRelease?.name ?? null,
    priorReleaseBody: priorRelease?.body ?? null,
    priorReleasePrerelease: priorRelease?.prerelease ?? null,
    priorReleaseDraft: priorRelease?.draft ?? null,
    priorLatest,
    priorCandidateVersion: priorCandidate?.version ?? null,
    priorAssetNames: priorRelease ? (await readdir(rollbackDir)).sort() : [],
  }, null, 2)}\n`);

  const store = await cwsClient();
  const priorCws = normalizeStatus(await store.status());
  if (priorCandidate && priorCws.submittedVersion && priorCws.submittedVersion !== priorCandidate.version) {
    throw new Error("canonical package does not own the existing CWS revision");
  }

  // Canonical mutations begin here; a failure past this point triggers rollback.
  await revalidate();
  // uploadAction refuses to replace a revision that is already frozen in review, which is the
  // guard that keeps a rebuild from clobbering a candidate Google is actively looking at.
  const action = uploadAction(await store.status(), version);
  if (action === "frozen") {
    throw new Error(`Chrome Web Store revision ${version} is frozen in review. Cancel review before replacing the candidate`);
  }
  const packageName = `lurkloot-${version}-chrome.zip`;
  const packageBytes = await readFile(join(assetDir, packageName));
  const upload = await waitForUpload(store, await store.upload(packageBytes, packageName));
  if (upload.uploadState !== "SUCCEEDED" && upload.uploadState !== "SUCCESS") {
    throw new Error(`Chrome Web Store upload did not complete: ${upload.uploadState}`);
  }
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`Chrome Web Store accepted ${upload.crxVersion}; expected ${version}`);
  }

  await revalidate();
  await (priorTagSha ? client.moveTag(tag, expectedSha) : client.createTag(tag, expectedSha));

  await revalidate();
  const notes = canonicalReleaseNotes({ pr, sourceSha: expectedSha, stagingId });
  const canonical = priorRelease
    ? await client.updateRelease(priorRelease.id, { name: `${tag} prerelease`, prerelease: true, make_latest: "false", body: notes })
    : await client.createRelease({ tag_name: tag, name: `${tag} prerelease`, prerelease: true, make_latest: "false", body: notes });

  await revalidate();
  const current = await client.releaseByTag(tag);
  for (const asset of current.assets ?? []) {
    if (assetNames.includes(asset.name)) await client.deleteReleaseAsset(asset.id);
  }
  await uploadAssets(client, canonical.upload_url ? canonical : current, assetDir, assetNames);

  await emitOutputs({
    candidate_sha: expectedSha,
    release_url: `https://github.com/${client.repo}/releases/tag/${tag}`,
    preview_url: values["preview-url"],
    chrome_zip_sha256: createHash("sha256").update(packageBytes).digest("hex"),
    docker_tag: `${values.image}:${version}`,
  });
}

/**
 * Restores the canonical references this run overwrote.
 *
 * Rollback is deliberately conservative: it proves this run still owns each reference before
 * touching it, and reports a blocked reconciliation rather than guessing when ownership is
 * ambiguous. Restoring blindly would destroy a concurrent release's work.
 */
async function prepareRollback(values) {
  const { version } = values;
  const expectedSha = values["expected-sha"];
  const stagingId = values["staging-id"];
  const stateDir = values["state-dir"];
  const client = releaseClient();
  const backup = JSON.parse(await readFile(join(stateDir, "backup.json"), "utf8"));
  const { tag } = backup;
  const rollbackDir = join(stateDir, "rollback-assets");
  let failed = false;
  const fail = (message) => { console.error(message); failed = true; };

  const currentTagSha = await client.tagShaOrNull(tag);
  const currentRelease = await client.releaseByTagOrNull(tag);
  let currentCandidateSource = null;
  const currentAsset = currentRelease?.assets?.find((asset) => asset.name === "candidate.json");
  if (currentAsset) {
    try {
      currentCandidateSource = parseCandidateMetadata(await client.releaseAsset(currentAsset.url)).sourceSha;
    } catch { /* an unreadable candidate simply fails the ownership proof below */ }
  }

  if (ownsCanonicalReferences({
    currentTagSha,
    expectedSha,
    candidateSourceSha: currentCandidateSource,
    releaseBody: currentRelease?.body,
    stagingId,
  })) {
    if (backup.priorReleaseId && currentRelease) {
      try {
        for (const asset of currentRelease.assets ?? []) await client.deleteReleaseAsset(asset.id);
        await client.updateRelease(currentRelease.id, {
          name: backup.priorReleaseName,
          body: backup.priorReleaseBody,
          prerelease: backup.priorReleasePrerelease,
          draft: backup.priorReleaseDraft,
          make_latest: String(backup.priorLatest),
        });
        const restored = await client.releaseByTag(tag);
        await uploadAssets(client, restored, rollbackDir, backup.priorAssetNames);
      } catch (error) {
        fail(`release rollback failed: ${error.message}`);
      }
    } else if (currentRelease) {
      await client.deleteRelease(currentRelease.id).catch((error) => fail(`release delete failed: ${error.message}`));
    }
    const restoreTag = backup.priorTagSha
      ? client.moveTag(tag, backup.priorTagSha)
      : client.deleteTag(tag);
    await restoreTag.catch((error) => fail(`tag rollback failed: ${error.message}`));
  }

  if (parseBooleanEvidence(values["cws-attempted"], "cws-attempted")) {
    const store = await cwsClient();
    const current = normalizeStatus(await store.status());
    const action = cwsRollbackAction({
      currentSubmittedVersion: current.submittedVersion ?? "none",
      version,
      priorExisted: Boolean(backup.priorCandidateVersion),
    });
    if (action === "stale") {
      console.error(`CWS ownership changed to ${current.submittedVersion}; refusing stale rollback`);
    } else if (action === "blocked") {
      fail("CWS_RECONCILIATION_BLOCKED: no exact prior draft package can be restored");
    } else {
      try {
        const priorPackage = `lurkloot-${backup.priorCandidateVersion}-chrome.zip`;
        const bytes = await readFile(join(rollbackDir, priorPackage));
        await waitForUpload(store, await store.upload(bytes, priorPackage));
      } catch (error) {
        fail(`CWS_RECONCILIATION_BLOCKED: prior draft restore failed: ${error.message}`);
      }
    }
  }

  if (failed) process.exitCode = 1;
}

async function promotePublish(values) {
  const client = releaseClient();
  await assertTrustedTools(client, values["trusted-tools"]);
  const { version } = values;
  await revalidatePromotion(client, {
    pr: Number(values.pr),
    expectedHeadSha: values["expected-head-sha"],
    expectedMergeSha: values["expected-merge-sha"],
    expectedLabel: values.label,
  });

  const metadata = await verifyCandidateAssets(join(values["asset-dir"], "candidate.json"), values["asset-dir"]);
  if (await client.tagCommitSha(`v${version}`) !== metadata.sourceSha) {
    throw new Error(`tag v${version} does not point at the candidate source`);
  }

  // Compare the artifact this job carries against what the release currently serves, so a release
  // whose assets were replaced after approval cannot be promoted.
  const liveDir = `${values["asset-dir"]}-live`;
  await downloadReleaseAssets(client, `v${version}`, liveDir);
  const liveMetadata = await verifyCandidateAssets(join(liveDir, "candidate.json"), liveDir);
  if (renderCandidateMetadata(liveMetadata) !== renderCandidateMetadata(metadata)) {
    throw new Error("live release candidate metadata differs from the approved artifact");
  }

  const store = await cwsClient();
  const storeStatus = normalizeStatus(await store.status());
  const action = promotionCwsAction({
    version,
    submittedVersion: storeStatus.submittedVersion,
    submittedState: storeStatus.submittedState,
    publishedVersion: storeStatus.publishedVersion,
  });
  if (action === "continue") {
    console.log(`CWS v${version} is already published; continuing idempotent stable recovery`);
    return;
  }
  const result = await store.publishStaged();
  if (result.state !== "PUBLISHED") throw new Error(`Chrome Web Store publish returned ${result.state}; expected PUBLISHED`);
}

async function cwsClient() {
  return new ChromeWebStoreClient({
    publisherId: required("CWS_PUBLISHER_ID"),
    extensionId: required("CWS_EXTENSION_ID"),
    accessToken: await serviceAccountToken(JSON.parse(required("CWS_SERVICE_ACCOUNT_JSON"))),
  });
}

async function submitCandidate(values) {
  const pr = Number(values.pr);
  const { version } = values;
  const expectedSha = values["expected-sha"];
  const client = releaseClient();
  await assertTrustedTools(client, values["trusted-tools"]);

  const metadata = await verifyCandidateAssets(join(values["candidate-dir"], "candidate.json"), values["candidate-dir"]);
  assertCandidateOwnership(metadata, { version, pr, sourceSha: expectedSha });

  // Re-read the PR before every mutation so a head, draft, or label change mid-run aborts the
  // remaining steps rather than applying them to a candidate nobody authorized.
  const revalidate = async () => {
    const live = await client.pullRequest(pr);
    assertPullRequestState(live, { expectedSha, expectedLabel: metadata.label });
    return live;
  };
  const live = await revalidate();

  assertEvidenceMatches(JSON.parse(await readFile(values.evidence, "utf8")), {
    version,
    sourceSha: expectedSha,
    headSha: live.head.sha,
    label: metadata.label,
    trustedToolsSha: values["trusted-tools"],
    chromeZipSha256: metadata.chromeZipSha256,
    assetChecksums: metadata.artifactChecksums,
  });

  const release = await client.releaseByTag(`v${version}`);
  if (release.prerelease !== true) throw new Error(`v${version} must remain a prerelease`);
  if (await client.tagCommitSha(`v${version}`) !== expectedSha) {
    throw new Error(`tag v${version} does not point at the authorized head`);
  }

  // Everything above is verification. The CWS submission below is the first irreversible act, so
  // it revalidates immediately beforehand and nothing may be inserted between the two.
  await revalidate();
  const store = await cwsClient();
  const storeAction = submitAction(await store.status(), version);
  if (storeAction === "submit") {
    const result = await store.submitStaged();
    if (result.state !== "PENDING_REVIEW" && result.state !== "STAGED") {
      throw new Error(`Chrome Web Store submission returned ${result.state}; expected PENDING_REVIEW or STAGED`);
    }
  }
  const action = assertSubmitAction(submittedAction(storeAction));
  const narrative = submissionNarrative(action, { version, pr });
  const check = submitCandidateCheck(action, version);

  await revalidate();
  await client.createCheckRun({
    name: "cws-release-ready",
    head_sha: expectedSha,
    status: check.status,
    output: { title: check.title, summary: check.summary },
  });

  await revalidate();
  await client.updateRelease(release.id, { prerelease: true, make_latest: "false", body: narrative.notes });

  await revalidate();
  const comments = await client.issueComments(pr);
  await upsertComment(client, pr, {
    marker: statusMarker(pr),
    comments,
    body: renderReleaseStatus({
      pr,
      version,
      kind: metadata.kind,
      state: narrative.statusState,
      sourceSha: expectedSha,
      checksum: metadata.chromeZipSha256,
      activity: narrative.activity,
      action: narrative.nextAction,
    }),
  });

  await revalidate();
  await ensureComment(client, pr, {
    marker: milestoneMarker(version, narrative.milestone),
    comments,
    body: renderMilestone({
      metadata,
      milestone: narrative.milestone,
      guidance: lifecycleMilestoneGuidance(narrative.milestone),
    }),
  });
}

// Downloads the frozen release assets the way `gh release download` did, but through the API so a
// partial or failed fetch raises instead of leaving a half-populated directory behind.
async function downloadReleaseAssets(client, tag, directory) {
  const release = await client.releaseByTag(tag);
  await mkdir(directory, { recursive: true });
  for (const asset of release.assets ?? []) {
    await writeFile(join(directory, asset.name), await client.assetBytes(asset.url));
  }
  return release;
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

async function buildCwsReport(client, values) {
  const { metadata, status, headSha, reportDir } = values;
  const { version, sourceSha, releasePr: pr } = metadata;
  const recoveryRequested = values.recovery === true || values.recovery === "true";
  const probe = deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested });
  const headEvidence = values.headEvidence;
  const candidateHeadValid = probe.state === "STAGED" || probe.state === "PENDING_REVIEW"
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
  await mkdir(reportDir, { recursive: true });
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
  const existingBodies = (values.comments ?? []).map((comment) => comment.body ?? "");
  const report = {
    state,
    status: check.status,
    conclusion,
    title: checkTitle(state, { recovery }),
    summary,
    pr,
    finalize: state === "STAGED" && !changelogHasDate(values.changelog, version),
    shouldComment: shouldComment(existingBodies, version, state),
    shouldMilestone: state === "STAGED" && shouldComment(existingBodies, version, "milestone:cws-staged"),
  };
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderStepSummary({ version, pr, state, conclusion, summary }));
  }
  return report;
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
  "inspect": {
    usage: "inspect --pr NUMBER --event ACTION [--actor LOGIN] [--label NAME]",
    options: {
      pr: { type: "string" },
      event: { type: "string" },
      actor: { type: "string", default: "" },
      label: { type: "string", default: "" },
    },
    requires: ["pr", "event"],
    run: async ({ values }) => {
      if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
      await emitOutputs(await inspectReleasePr(releaseClient(), {
        pr: Number(values.pr),
        event: { action: values.event, actor: values.actor, label: values.label },
      }));
    },
  },
  "release download": {
    usage: "release download --tag TAG --dir DIR",
    options: { tag: { type: "string" }, dir: { type: "string" } },
    requires: ["tag", "dir"],
    run: async ({ values }) => { await downloadReleaseAssets(releaseClient(), values.tag, values.dir); },
  },
  "resolve-ref": {
    usage: "resolve-ref --ref NAME",
    options: { ref: { type: "string" } },
    requires: ["ref"],
    run: async ({ values }) => emitOutputs({ sha: await releaseClient().refSha(values.ref) }),
  },
  "trusted-tools": {
    usage: "trusted-tools --expected SHA",
    options: { expected: { type: "string" } },
    requires: ["expected"],
    run: async ({ values }) => {
      await emitOutputs({ sha: await assertTrustedTools(releaseClient(), values.expected) });
    },
  },
  "policy ancestry": {
    usage: "policy ancestry --pr NUMBER",
    options: { pr: { type: "string" } },
    requires: ["pr"],
    run: async ({ values }) => {
      if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
      const client = releaseClient();
      const state = await gatherRepositoryState(client, { pr: Number(values.pr) });
      const labels = recognizedReleaseLabels(state.labels);
      if (labels.length === 0) {
        console.log("no release label; ancestry policy does not apply");
        return;
      }
      // Authorization is the controller's job on pull_request_target; this check runs on the
      // untrusted pull_request event and only reports the ancestry facts a contributor can fix.
      const policy = deriveReleasePolicy({
        labels: state.labels,
        baseRef: state.baseRef,
        sameRepository: state.sameRepository,
        labelActorPermission: "admin",
        mainAncestor: state.mainAncestor,
        developAncestor: state.developAncestor,
        leakedDevelopCommit: state.leakedDevelopCommit,
        stableVersion: state.stableVersion,
        headSha: state.headSha,
      });
      if (policy.state === "blocked") throw new Error(policy.reason);
      console.log(`${policy.kind} release ancestry is valid for ${policy.version}`);
    },
  },
  "forward run": {
    usage: "forward run --version VERSION --kind KIND --expected-main-sha SHA",
    options: { version: { type: "string" }, kind: { type: "string" }, "expected-main-sha": { type: "string" } },
    requires: ["version", "kind", "expected-main-sha"],
    run: ({ values }) => forwardRelease(values),
  },
  "prepare resolve": {
    usage: "prepare resolve --pr N [--expected-sha SHA --version V ...] --trusted-tools SHA",
    options: {
      pr: { type: "string" },
      "expected-sha": { type: "string", default: "" },
      version: { type: "string", default: "" },
      kind: { type: "string", default: "" },
      label: { type: "string", default: "" },
      "authorized-by": { type: "string", default: "" },
      "stable-sha": { type: "string", default: "" },
      "stable-version": { type: "string", default: "" },
      "develop-sha": { type: "string", default: "" },
      "trusted-tools": { type: "string", default: "" },
    },
    requires: ["pr"],
    run: ({ values }) => prepareResolve(values),
  },
  "prepare validate": {
    usage: "prepare validate --pr N --expected-sha SHA --label L --version V --kind K --trusted-tools SHA",
    options: {
      pr: { type: "string" },
      "expected-sha": { type: "string" },
      label: { type: "string" },
      version: { type: "string" },
      kind: { type: "string" },
      "trusted-tools": { type: "string" },
    },
    requires: ["pr", "expected-sha", "label", "version", "kind", "trusted-tools"],
    run: async ({ values }) => {
      assertPrepareInputs({
        expectedSha: values["expected-sha"],
        trustedTools: values["trusted-tools"],
        version: values.version,
        kind: values.kind,
        label: values.label,
      });
      const client = releaseClient();
      const live = await client.pullRequest(Number(values.pr));
      assertPreparePullRequest(live, { expectedSha: values["expected-sha"], expectedLabel: values.label });
      assertSameRepository(live, client.repo);
    },
  },
  "prepare approval": {
    usage: "prepare approval --run-id ID",
    options: { "run-id": { type: "string" } },
    requires: ["run-id"],
    run: async ({ values }) => {
      const client = releaseClient();
      const approver = await client.latestApprover(values["run-id"]);
      if (await client.collaboratorPermission(approver) !== "admin") {
        throw new Error(`environment approver ${approver} is not a repository administrator`);
      }
      await emitOutputs({ authorized_by: approver });
    },
  },
  "prepare pr-assert": {
    usage: "prepare pr-assert --pr NUMBER --expected-sha SHA --label LABEL",
    options: { pr: { type: "string" }, "expected-sha": { type: "string" }, label: { type: "string" } },
    requires: ["pr", "expected-sha", "label"],
    run: async ({ values }) => {
      const client = releaseClient();
      assertPreparePullRequest(await client.pullRequest(Number(values.pr)), {
        expectedSha: values["expected-sha"],
        expectedLabel: values.label,
      });
    },
  },
  "prepare publish": {
    usage: "prepare publish --pr N --version V --kind K --label L --expected-sha SHA --staging-id ID --assets DIR --digests DIR --state-dir DIR ...",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      kind: { type: "string" },
      label: { type: "string" },
      "expected-sha": { type: "string" },
      "staging-id": { type: "string" },
      assets: { type: "string" },
      digests: { type: "string" },
      "state-dir": { type: "string" },
      "stable-sha": { type: "string" },
      "stable-version": { type: "string" },
      "develop-sha": { type: "string", default: "" },
      "trusted-tools": { type: "string" },
      "authorized-by": { type: "string" },
      initiator: { type: "string" },
      "preview-url": { type: "string" },
      image: { type: "string" },
      "run-id": { type: "string" },
      "run-attempt": { type: "string" },
    },
    requires: [
      "pr", "version", "kind", "label", "expected-sha", "staging-id", "assets", "digests",
      "state-dir", "stable-sha", "stable-version", "trusted-tools", "authorized-by", "initiator",
      "preview-url", "image", "run-id", "run-attempt",
    ],
    run: ({ values }) => preparePublish(values),
  },
  "prepare rollback": {
    usage: "prepare rollback --pr N --version V --expected-sha SHA --staging-id ID --state-dir DIR --cws-attempted true|false",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-sha": { type: "string" },
      "staging-id": { type: "string" },
      "state-dir": { type: "string" },
      "cws-attempted": { type: "string", default: "false" },
    },
    requires: ["pr", "version", "expected-sha", "staging-id", "state-dir"],
    run: ({ values }) => prepareRollback(values),
  },
  "promote begin": {
    usage: "promote begin --pr NUMBER",
    options: { pr: { type: "string" } },
    requires: ["pr"],
    run: async ({ values }) => {
      if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
      const client = releaseClient();
      const live = await client.promotionPullRequest(Number(values.pr));
      if (live.state !== "MERGED" || !live.mergedAt) throw new Error(`pull request #${values.pr} is not merged`);
      await emitOutputs({ pr: values.pr, trusted_tools_ref: await client.refSha("main") });
    },
  },
  "promote resolve": {
    usage: "promote resolve --pr NUMBER --trusted-tools SHA --asset-dir DIR",
    options: { pr: { type: "string" }, "trusted-tools": { type: "string" }, "asset-dir": { type: "string" } },
    requires: ["pr", "trusted-tools", "asset-dir"],
    run: async ({ values }) => {
      if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
      const client = releaseClient();
      await assertTrustedTools(client, values["trusted-tools"]);
      const resolved = await resolvePromotionCandidate(client, {
        pr: Number(values.pr),
        assetDir: values["asset-dir"],
      });
      if (!resolved.active) {
        await emitOutputs({ active: false });
        if (process.env.GITHUB_STEP_SUMMARY) {
          await appendFile(process.env.GITHUB_STEP_SUMMARY, "No matching authorized staged candidate; no release action was performed\n");
        }
        return;
      }
      await emitOutputs(resolved);
    },
  },
  "promote publish": {
    usage: "promote publish --pr N --version V --expected-head-sha SHA --expected-merge-sha SHA --label L --trusted-tools SHA --asset-dir DIR",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-head-sha": { type: "string" },
      "expected-merge-sha": { type: "string" },
      label: { type: "string" },
      "trusted-tools": { type: "string" },
      "asset-dir": { type: "string" },
    },
    requires: ["pr", "version", "expected-head-sha", "expected-merge-sha", "label", "trusted-tools", "asset-dir"],
    run: ({ values }) => promotePublish(values),
  },
  "promote docker-tags": {
    usage: "promote docker-tags --pr N --version V --expected-head-sha SHA --expected-merge-sha SHA --label L --asset-dir DIR --image NAME",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-head-sha": { type: "string" },
      "expected-merge-sha": { type: "string" },
      label: { type: "string" },
      "asset-dir": { type: "string" },
      image: { type: "string" },
    },
    requires: ["pr", "version", "expected-head-sha", "expected-merge-sha", "label", "asset-dir", "image"],
    run: async ({ values }) => {
      const client = releaseClient();
      await revalidatePromotion(client, {
        pr: Number(values.pr),
        expectedHeadSha: values["expected-head-sha"],
        expectedMergeSha: values["expected-merge-sha"],
        expectedLabel: values.label,
      });
      const metadata = await verifyCandidateAssets(join(values["asset-dir"], "candidate.json"), values["asset-dir"]);
      const digests = [...metadata.dockerDigests].sort();
      await emitOutputs({
        tags: dockerPromotionTags(values.image, values.version).map((tag) => `--tag ${tag}`).join(" "),
        sources: digests.map((digest) => `${values.image}@${digest}`).join(" "),
      });
    },
  },
  "promote release": {
    usage: "promote release --pr N --version V --expected-head-sha SHA --expected-merge-sha SHA --label L --asset-dir DIR",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-head-sha": { type: "string" },
      "expected-merge-sha": { type: "string" },
      label: { type: "string" },
      "asset-dir": { type: "string" },
    },
    requires: ["pr", "version", "expected-head-sha", "expected-merge-sha", "label", "asset-dir"],
    run: async ({ values }) => {
      const client = releaseClient();
      await revalidatePromotion(client, {
        pr: Number(values.pr),
        expectedHeadSha: values["expected-head-sha"],
        expectedMergeSha: values["expected-merge-sha"],
        expectedLabel: values.label,
      });
      await verifyCandidateAssets(join(values["asset-dir"], "candidate.json"), values["asset-dir"]);
      const release = await client.releaseByTag(`v${values.version}`);
      // Promotion is idempotent: an already-stable release is left exactly as it is.
      if (release.prerelease !== true) return;
      await client.updateRelease(release.id, {
        name: `v${values.version}`,
        prerelease: false,
        make_latest: "true",
        body: stableReleaseNotes(values.version),
      });
    },
  },
  "promote notify": {
    usage: "promote notify --pr NUMBER --version VERSION --initiator LOGIN",
    options: { pr: { type: "string" }, version: { type: "string" }, initiator: { type: "string" } },
    requires: ["pr", "version", "initiator"],
    run: async ({ values }) => {
      const pr = Number(values.pr);
      const client = releaseClient();
      const marker = milestoneMarker(values.version, "stable");
      await upsertComment(client, pr, {
        marker,
        body: stableMilestoneBody(marker, { version: values.version, initiator: values.initiator }),
      });
    },
  },
  "cancel run": {
    usage: "cancel run --pr N --version V --expected-sha SHA --expected-live-head-sha SHA --desired-labels JSON --expected-pr-state STATE --disposition D --trusted-tools SHA --candidate-dir DIR",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-sha": { type: "string" },
      "expected-live-head-sha": { type: "string" },
      "desired-labels": { type: "string" },
      "expected-pr-state": { type: "string" },
      disposition: { type: "string" },
      "trusted-tools": { type: "string" },
      "candidate-dir": { type: "string" },
    },
    requires: [
      "pr", "version", "expected-sha", "expected-live-head-sha",
      "desired-labels", "expected-pr-state", "disposition", "trusted-tools", "candidate-dir",
    ],
    run: ({ values }) => cancelCandidate(values),
  },
  "cancel finalize": {
    usage: "cancel finalize --pr N --version V --expected-sha SHA --succeeded true|false",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-sha": { type: "string" },
      succeeded: { type: "string" },
    },
    requires: ["pr", "version", "expected-sha", "succeeded"],
    run: async ({ values }) => {
      const pr = Number(values.pr);
      const { version } = values;
      const outcome = cancellationOutcome(parseBooleanEvidence(values.succeeded, "succeeded"), version);
      const client = releaseClient();
      await emitOutputs({
        cancelled: outcome.cancelled,
        safe_to_replace: outcome.safeToReplace,
        reason: outcome.reason,
      });
      await client.createCheckRun({
        name: "release-candidate",
        head_sha: values["expected-sha"],
        status: "completed",
        conclusion: outcome.conclusion,
        output: { title: outcome.title, summary: outcome.summary },
      });
      const comments = await client.issueComments(pr);
      await upsertComment(client, pr, {
        marker: statusMarker(pr),
        comments,
        body: renderReleaseStatus({
          pr,
          version,
          state: outcome.state,
          sourceSha: values["expected-sha"],
          ...(outcome.safeToReplace ? { action: outcome.summary } : { recovery: outcome.summary }),
        }),
      });
      if (outcome.safeToReplace) return;
      await ensureComment(client, pr, {
        marker: milestoneMarker(version, "reconciliation-blocked"),
        comments,
        body: [
          milestoneMarker(version, "reconciliation-blocked"),
          `Candidate **v${version}** reached **reconciliation-blocked**. ${lifecycleMilestoneGuidance("reconciliation-blocked")}`,
        ].join("\n"),
      });
      process.exitCode = 1;
    },
  },
  "submission verify": {
    usage: "submission verify --pr NUMBER --version VERSION --expected-sha SHA --trusted-tools SHA --candidate-dir DIR --fresh-zip FILE --evidence-dir DIR",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-sha": { type: "string" },
      "trusted-tools": { type: "string" },
      "candidate-dir": { type: "string" },
      "fresh-zip": { type: "string" },
      "evidence-dir": { type: "string" },
    },
    requires: ["pr", "version", "expected-sha", "trusted-tools", "candidate-dir", "fresh-zip", "evidence-dir"],
    run: async ({ values }) => {
      const pr = Number(values.pr);
      const version = values.version;
      const expectedSha = values["expected-sha"];
      const client = releaseClient();
      await assertTrustedTools(client, values["trusted-tools"]);

      const release = await downloadReleaseAssets(client, `v${version}`, values["candidate-dir"]);
      if (release.prerelease !== true) throw new Error(`v${version} must remain a prerelease`);
      if (await client.tagCommitSha(`v${version}`) !== expectedSha) {
        throw new Error(`tag v${version} does not point at the authorized head`);
      }

      const metadata = await verifyCandidateAssets(join(values["candidate-dir"], "candidate.json"), values["candidate-dir"]);
      assertCandidateOwnership(metadata, { version, pr, sourceSha: expectedSha });
      assertPullRequestState(await client.pullRequest(pr), { expectedSha, expectedLabel: metadata.label });

      const freshChromeSha256 = createHash("sha256").update(await readFile(values["fresh-zip"])).digest("hex");
      if (freshChromeSha256 !== metadata.chromeZipSha256) {
        throw new Error("independent rebuild does not reproduce the frozen Chrome ZIP checksum");
      }
      const evidence = buildSubmissionEvidence({
        version,
        sourceSha: expectedSha,
        headSha: expectedSha,
        label: metadata.label,
        trustedToolsSha: values["trusted-tools"],
        freshChromeSha256,
        assetChecksums: metadata.artifactChecksums,
      });
      await mkdir(values["evidence-dir"], { recursive: true });
      await writeFile(join(values["evidence-dir"], "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    },
  },
  "submission submit": {
    usage: "submission submit --pr NUMBER --version VERSION --expected-sha SHA --trusted-tools SHA --candidate-dir DIR --evidence FILE",
    options: {
      pr: { type: "string" },
      version: { type: "string" },
      "expected-sha": { type: "string" },
      "trusted-tools": { type: "string" },
      "candidate-dir": { type: "string" },
      evidence: { type: "string" },
    },
    requires: ["pr", "version", "expected-sha", "trusted-tools", "candidate-dir", "evidence"],
    run: ({ values }) => submitCandidate(values),
  },
  "submission blocked": {
    usage: "submission blocked --pr NUMBER --version VERSION --expected-sha SHA",
    options: { pr: { type: "string" }, version: { type: "string" }, "expected-sha": { type: "string" } },
    requires: ["pr", "version", "expected-sha"],
    run: async ({ values }) => {
      const pr = Number(values.pr);
      const { version } = values;
      const summary = "Submission did not complete from the sealed candidate evidence. Reconcile GitHub and CWS state before retrying.";
      const client = releaseClient();
      await client.createCheckRun({
        name: "cws-release-ready",
        head_sha: values["expected-sha"],
        status: "completed",
        conclusion: "failure",
        output: { title: "CWS submission blocked", summary },
      });
      const comments = await client.issueComments(pr);
      await upsertComment(client, pr, {
        marker: statusMarker(pr),
        comments,
        body: renderReleaseStatus({
          pr,
          version,
          state: "blocked",
          sourceSha: values["expected-sha"],
          recovery: summary,
        }),
      });
      await ensureComment(client, pr, {
        marker: milestoneMarker(version, "reconciliation-blocked"),
        comments,
        body: [
          milestoneMarker(version, "reconciliation-blocked"),
          `Candidate **v${version}** reached **reconciliation-blocked**. ${lifecycleMilestoneGuidance("reconciliation-blocked")}`,
        ].join("\n"),
      });
      process.exitCode = 1;
    },
  },
  "notify": {
    usage: "notify --pr NUMBER --state STATE [--version V] [--source-sha SHA] [--activity TEXT] [--blocker TEXT] [--milestone NAME]",
    options: {
      pr: { type: "string" },
      state: { type: "string" },
      version: { type: "string", default: "" },
      "source-sha": { type: "string", default: "" },
      activity: { type: "string", default: "" },
      blocker: { type: "string", default: "" },
      milestone: { type: "string", default: "" },
    },
    requires: ["pr", "state"],
    run: async ({ values }) => {
      if (!/^[1-9][0-9]*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
      const pr = Number(values.pr);
      const client = releaseClient();
      const comments = await client.issueComments(pr);
      await upsertComment(client, pr, {
        marker: statusMarker(pr),
        comments,
        body: renderReleaseStatus({
          pr,
          state: values.state,
          version: values.version,
          sourceSha: values["source-sha"],
          activity: values.activity || null,
          blocker: values.blocker || null,
        }),
      });
      if (!values.milestone || !values.version) return;
      await ensureComment(client, pr, {
        marker: milestoneMarker(values.version, values.milestone),
        comments,
        body: [
          milestoneMarker(values.version, values.milestone),
          `Candidate **v${values.version}** reached **${values.milestone}**. ${lifecycleMilestoneGuidance(values.milestone)}`,
        ].join("\n"),
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
  "monitor run": {
    usage: "monitor run [--version VERSION] [--recovery true|false] [--report-dir DIR]",
    options: {
      version: { type: "string", default: "" },
      recovery: { type: "string", default: "false" },
      "report-dir": { type: "string", default: "report" },
    },
    run: async ({ values }) => {
      const requested = assertMonitorVersion(values.version);
      const recovery = parseBooleanEvidence(values.recovery, "recovery");
      const client = releaseClient();
      const versions = requested ? [requested] : activeCandidateVersions(await client.releases());
      for (const version of versions) {
        await monitorCandidate(client, {
          version,
          recovery,
          reportDir: join(values["report-dir"], version),
        });
      }
    },
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
