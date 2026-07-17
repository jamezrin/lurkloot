import { RELEASE_LABELS } from "./policy.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Asserts the release PR still matches the authorized candidate identity.
 *
 * The shell repeated this same block before every single mutation in the publish transaction. It
 * stays a discrete call for the same reason: each canonical write must be preceded by a fresh read,
 * so a head or label change mid-transaction stops the next write instead of racing it.
 */
export function assertPreparePullRequest(live, { expectedSha, expectedLabel, requireOpen = true }) {
  invariant(live.head?.sha === expectedSha, "candidate head identity changed");
  if (requireOpen) {
    invariant(live.state === "open", "pull request must remain open");
    invariant(live.base?.ref === "main", "release PR must target main");
  }
  const recognized = (live.labels ?? []).map((label) => label.name).filter((name) => RELEASE_LABELS.includes(name));
  invariant(recognized.length === 1, "pull request must have exactly one recognized release label");
  invariant(recognized[0] === expectedLabel, `pull request label ${recognized[0]} does not match ${expectedLabel}`);
  return recognized[0];
}

const kindLabels = new Map([
  ["normal", new Set(["release/patch", "release/minor", "release/major"])],
  ["hotfix", new Set(["release/hotfix"])],
]);

// Guards the controller inputs before any build runs: a kind and label that disagree would build a
// candidate whose metadata could never validate.
export function assertPrepareInputs({ expectedSha, trustedTools, version, kind, label }) {
  invariant(/^[0-9a-f]{40}$/.test(expectedSha ?? ""), "expected head SHA must be a commit SHA");
  invariant(/^[0-9a-f]{40}$/.test(trustedTools ?? ""), "trusted tools ref must be a commit SHA");
  invariant(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? ""), "version must be stable SemVer");
  invariant(kindLabels.get(kind)?.has(label), `kind ${kind} does not permit label ${label}`);
}

export function assertSameRepository(live, repo) {
  invariant(live.head?.repo?.full_name === repo, "release PR must be a same-repository PR");
}

export function assertDigestFilenames(names) {
  invariant(names.length === 1, `expected exactly one Docker digest artifact, found ${names.length}`);
  invariant(/^[0-9a-f]{64}$/.test(names[0]), `Docker digest filename ${names[0]} is not a SHA-256 value`);
  return names[0];
}

export function stagingReleaseNotes({ version, runId, runAttempt }) {
  return `Immutable staging candidate for v${version} from run ${runId}/${runAttempt}.`;
}

export function canonicalReleaseNotes({ pr, sourceSha, stagingId }) {
  return `Mutable candidate from PR #${pr} at ${sourceSha} (staged as ${stagingId}).`;
}

/**
 * Decides whether the canonical references still belong to this run.
 *
 * Rollback may only touch references this run created. If another run has already taken ownership
 * of the tag or release, restoring our backup would destroy their work, so ownership is proven
 * before anything is reverted.
 */
export function ownsCanonicalReferences({ currentTagSha, expectedSha, candidateSourceSha, releaseBody, stagingId }) {
  if (currentTagSha !== expectedSha) return false;
  return candidateSourceSha === expectedSha || (releaseBody ?? "").includes(stagingId);
}

/**
 * Selects the run-owned container version to delete during rollback.
 *
 * The version must carry this run's staging tag, must carry every alias being removed, and must
 * carry no tag beyond this run's own. Anything else is shared with another release, so rollback
 * refuses rather than guessing.
 */
export function selectRunOwnedContainerVersion(versions, { stagedDigest, version, stagingId, aliases }) {
  const matches = versions.filter((entry) => {
    if (entry?.name !== stagedDigest) return false;
    const tags = entry?.metadata?.container?.tags ?? [];
    return tags.includes(stagingId)
      && tags.every((tag) => tag === version || tag === "next" || tag === stagingId)
      && aliases.every((alias) => tags.includes(alias));
  });
  return matches.length === 1 ? matches[0].id : null;
}

// A prior CWS draft may only be restored when the store still holds nothing or this run's own
// version. If ownership moved on, the rollback is stale and must not fire.
export function cwsRollbackAction({ currentSubmittedVersion, version, priorExisted }) {
  if (currentSubmittedVersion !== "none" && currentSubmittedVersion !== version) return "stale";
  return priorExisted ? "restore" : "blocked";
}
