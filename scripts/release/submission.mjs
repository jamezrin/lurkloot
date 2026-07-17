import { RELEASE_LABELS } from "./policy.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function recognizedLabel(labels) {
  const recognized = labels.filter((label) => RELEASE_LABELS.includes(label));
  invariant(recognized.length === 1, "pull request must have exactly one recognized release label");
  return recognized[0];
}

/**
 * Asserts the PR still looks exactly as it did when the candidate was authorized.
 *
 * The shell re-ran this immediately before every mutation, and so does the caller here: CWS
 * submission, check-run creation, release edits, and comments each revalidate first, so a PR that
 * drifts mid-run cannot have a later mutation land against the stale identity.
 */
export function assertPullRequestState(live, { expectedSha, expectedLabel }) {
  invariant(live.head?.sha === expectedSha, "candidate head identity changed");
  invariant(live.state === "open", "pull request must remain open");
  invariant(live.draft === false, "pull request must remain ready for review");
  const label = recognizedLabel((live.labels ?? []).map((entry) => entry.name));
  invariant(label === expectedLabel, `pull request label ${label} does not match candidate label ${expectedLabel}`);
  return label;
}

export function assertCandidateOwnership(metadata, { version, pr, sourceSha }) {
  invariant(metadata.schemaVersion === 2, "candidate metadata must be schema version 2");
  invariant(metadata.version === version, `candidate metadata version ${metadata.version} does not match v${version}`);
  invariant(metadata.releasePr === pr, `candidate metadata claims PR #${metadata.releasePr}, expected #${pr}`);
  invariant(metadata.sourceSha === sourceSha, "candidate metadata source SHA does not match the authorized head");
  return metadata;
}

export function buildSubmissionEvidence({ version, sourceSha, headSha, label, trustedToolsSha, freshChromeSha256, assetChecksums }) {
  return {
    schemaVersion: 2,
    version,
    sourceSha,
    headSha,
    label,
    trustedToolsSha,
    freshChromeSha256,
    // Every frozen asset is pinned here, not just the Chrome ZIP. Re-verifying the re-downloaded
    // assets against candidate.json alone would pass if both were swapped together after approval;
    // these checksums were sealed before it, so such a swap cannot survive.
    assetChecksums,
  };
}

function sameChecksums(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

// The evidence sealed before environment approval must still describe the candidate being
// submitted after approval; any divergence means the approved artifact is not this one.
export function assertEvidenceMatches(evidence, { version, sourceSha, headSha, label, trustedToolsSha, chromeZipSha256, assetChecksums }) {
  invariant(evidence.schemaVersion === 2, "submission evidence must be schema version 2");
  invariant(evidence.version === version, "sealed evidence version does not match the candidate");
  invariant(evidence.sourceSha === sourceSha, "sealed evidence source SHA does not match the candidate");
  invariant(evidence.headSha === headSha, "sealed evidence head SHA does not match the live pull request");
  invariant(evidence.label === label, "sealed evidence label does not match the candidate");
  invariant(evidence.trustedToolsSha === trustedToolsSha, "sealed evidence trusted tooling SHA changed");
  invariant(evidence.freshChromeSha256 === chromeZipSha256, "sealed evidence rebuild checksum does not match the candidate");
  invariant(sameChecksums(evidence.assetChecksums, assetChecksums), "frozen release assets changed after evidence was sealed");
  return evidence;
}

const submitActions = new Set(["submitted", "already-submitted", "already-staged"]);

export function assertSubmitAction(action) {
  invariant(submitActions.has(action), `unexpected Chrome Web Store submit action ${action}`);
  return action;
}

export function submissionNarrative(action, { version, pr }) {
  if (action === "already-staged") {
    return {
      notes: `Candidate for release PR #${pr}. Chrome Web Store version ${version} is STAGED and awaits monitor finalization and release metadata validation. Source, tag, and downloadable assets remain frozen.`,
      statusState: "staged validation pending",
      activity: "CWS already reports staged publishing approval.",
      nextAction: "Monitor finalization and release metadata validation remain pending; the cws-release-ready check remains in progress.",
      milestone: "cws-staged-validation",
    };
  }
  return {
    notes: `Candidate for release PR #${pr}. Chrome Web Store version ${version} is PENDING_REVIEW with deferred publishing. Source, tag, and downloadable assets remain frozen.`,
    statusState: "cws pending",
    activity: "Submitted to CWS with staged publishing.",
    nextAction: "Wait for Google review; the cws-release-ready check remains pending.",
    milestone: "cws-pending",
  };
}
