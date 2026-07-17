import { revisionVersion } from "../cws.mjs";
import { RELEASE_LABELS } from "./policy.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const prStates = new Set(["open", "closed-unmerged"]);
const dispositions = new Set(["retire", "replace"]);

export function parseCancellationInputs({ version, expectedSha, expectedLiveHeadSha, desiredLabels, expectedPrState, disposition }) {
  invariant(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? ""), "candidate version must be a stable semantic version");
  invariant(/^[0-9a-f]{40}$/.test(expectedSha ?? ""), "expected candidate SHA must be a commit SHA");
  invariant(/^[0-9a-f]{40}$/.test(expectedLiveHeadSha ?? ""), "expected live head SHA must be a commit SHA");
  invariant(prStates.has(expectedPrState), "expected PR state must be open or closed-unmerged");
  invariant(dispositions.has(disposition), "disposition must be retire or replace");
  const labels = JSON.parse(desiredLabels);
  invariant(Array.isArray(labels), "desired release labels must be a JSON array");
  // The caller passes a sorted set; anything else means the controller and this workflow disagree
  // about which labels were authorized.
  invariant(
    JSON.stringify(labels) === JSON.stringify([...labels].sort()),
    "desired release labels must be sorted",
  );
  return { version, expectedSha, expectedLiveHeadSha, labels, expectedPrState, disposition };
}

// Cancellation is only ever safe for a revision that never reached the public store.
export function assertNotPublished(status, version) {
  invariant(revisionVersion(status.publishedItemRevisionStatus) !== version, "PUBLISHED candidates cannot be cancelled");
  return status;
}

// After cancelling, the store must show either nothing submitted or this exact version parked in
// CANCELLED. Anything else means the revision we cancelled was not the one we meant to.
export function assertCancelledTerminal(status, version) {
  const submitted = status.submittedItemRevisionStatus;
  if (!submitted) return "cancelled";
  const submittedVersion = revisionVersion(submitted);
  invariant(
    submittedVersion === version && submitted.state === "CANCELLED",
    `Chrome Web Store did not reach a cancelled terminal state for ${version}`,
  );
  return "cancelled";
}

export function assertCancelPullRequestState(live, { expectedLiveHeadSha, expectedPrState, labels }) {
  invariant(live.head?.sha === expectedLiveHeadSha, "live pull request head changed during cancellation");
  invariant(live.merged_at === null || live.merged_at === undefined, "merged pull requests cannot have candidates cancelled");
  invariant(
    live.state === (expectedPrState === "open" ? "open" : "closed"),
    `pull request state ${live.state} does not match expected ${expectedPrState}`,
  );
  const recognized = (live.labels ?? []).map((label) => label.name).filter((name) => RELEASE_LABELS.includes(name)).sort();
  invariant(
    JSON.stringify(recognized) === JSON.stringify(labels),
    "release labels changed during cancellation",
  );
  return recognized;
}

export function cancellationOutcome(succeeded, version) {
  if (succeeded) {
    return {
      cancelled: true,
      safeToReplace: true,
      reason: "confirmed-cancelled",
      conclusion: "success",
      title: "Candidate cancellation confirmed",
      summary: `CWS cancellation for v${version} is confirmed and its GitHub prerelease is retained for audit.`,
      state: "cancelled",
    };
  }
  return {
    cancelled: false,
    safeToReplace: false,
    reason: "reconciliation-blocked",
    conclusion: "failure",
    title: "Candidate cancellation blocked",
    summary: "Cancellation did not reach a confirmed safe terminal state. Reconcile the exact CWS revision and retry.",
    state: "blocked",
  };
}

/**
 * Finds the container version to retire.
 *
 * Only a version tagged exclusively with this candidate's tags is deletable. A version also
 * carrying an unrelated tag is shared with another release and must be left alone, so an
 * ambiguous match resolves to null rather than guessing.
 */
export function selectRetirableContainerVersion(versions, version) {
  const matches = versions.filter((entry) => {
    const tags = entry?.metadata?.container?.tags ?? [];
    return tags.includes(version) && tags.every((tag) => tag === version || tag === "next");
  });
  return matches.length === 1 ? matches[0].id : null;
}
