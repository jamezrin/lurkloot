import {
  authorizationMatchesEvent,
  authorizationMatchesSnapshot,
  buildAuthorizationRecord,
  decodeAuthorization,
  deriveLabelEventAuthorization,
  encodeAuthorization,
  findAuthorizationComment,
  latestReleaseLabelEvent,
  recognizedReleaseLabels,
  AUTHORIZATION_MARKER,
} from "./authorization.mjs";
import { findCandidateForPr } from "./candidates.mjs";
import { upsertComment } from "./comments.mjs";
import { deriveReleasePolicy } from "./policy.mjs";
import { deriveReconciliation } from "./reconcile.mjs";

const labelTransitions = new Set(["labeled", "unlabeled"]);

/**
 * Reads the live repository state a release PR decision depends on.
 *
 * The ancestry facts here were previously produced by a full-history checkout plus git plumbing on
 * a pull_request_target run. Sourcing them from the compare API keeps untrusted candidate history
 * off the privileged runner entirely.
 */
export async function gatherRepositoryState(client, { pr, stableRef = "main", developRef = "develop" }) {
  const pull = await client.pullRequest(pr);
  const headSha = pull.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(headSha ?? "")) throw new Error(`PR #${pr} head did not resolve to a commit SHA`);

  const [stableSha, developSha] = await Promise.all([client.refSha(stableRef), client.refSha(developRef)]);
  const stableVersion = JSON.parse(await client.fileAtRef("package.json", stableSha)).version;

  const [mainAncestor, developAncestor, developRange, candidateRange] = await Promise.all([
    client.isAncestor(stableSha, headSha),
    client.isAncestor(developSha, headSha),
    client.compare(stableSha, developSha),
    client.compare(stableSha, headSha),
  ]);

  const developCommits = new Set(developRange.commits);
  const leakedDevelopCommit = candidateRange.commits.find((sha) => developCommits.has(sha)) ?? "";

  return {
    headSha,
    baseRef: pull.base?.ref,
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged_at),
    closed: pull.state === "closed",
    labels: (pull.labels ?? []).map((label) => label.name),
    sameRepository: pull.head?.repo?.full_name === client.repo,
    stableSha,
    stableVersion,
    developSha,
    // main is both the release base and the source of the trusted release tooling; the shell
    // asserted these matched, and they resolve from one ref here so they cannot diverge.
    trustedToolsRef: stableSha,
    mainAncestor,
    developAncestor,
    leakedDevelopCommit,
  };
}

async function resolveAuthorization(client, { pr, event, state, labels, candidate, comments }) {
  const events = await client.issueEvents(pr);
  const latestEvent = latestReleaseLabelEvent(events);

  if (labelTransitions.has(event.action)) {
    const permission = await client.collaboratorPermission(event.actor);
    const outcome = deriveLabelEventAuthorization({
      actorPermission: permission,
      latestEvent,
      eventAction: event.action,
      eventActor: event.actor,
      eventLabel: event.label,
    });
    if (!outcome.authorized) {
      return {
        permission: "none",
        authorizedBy: "",
        authorizedSha: "",
        snapshotAuthorized: false,
        unauthorizedTransition: true,
        reason: outcome.reason,
      };
    }
    const record = buildAuthorizationRecord({
      pr,
      headSha: state.headSha,
      labels,
      authorizedBy: event.actor,
      event: outcome.event,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    await upsertComment(client, pr, { marker: AUTHORIZATION_MARKER, body: encodeAuthorization(record), comments });
    // A newly authorized label carries no approved SHA, so the caller still demands a fresh
    // environment approval for this head before any mutation runs.
    return {
      permission: "admin",
      authorizedBy: event.actor,
      authorizedSha: "",
      snapshotAuthorized: true,
      unauthorizedTransition: false,
    };
  }

  const stored = decodeAuthorization(findAuthorizationComment(comments)?.body);
  const current = authorizationMatchesEvent(stored, latestEvent);
  let permission = "none";
  let authorizedBy = candidate?.metadata.authorizedBy ?? "";
  let snapshotAuthorized = false;

  // A frozen candidate keeps its own authorization while the label set still matches the one it
  // was built for; this is what lets pushes and ready_for_review reconcile without re-labelling.
  if (current && candidate && labels.length === 1 && candidate.metadata.label === labels[0]) {
    permission = "admin";
  }
  if (current && authorizationMatchesSnapshot(stored, { pr, headSha: state.headSha, labels })) {
    authorizedBy = stored.authorizedBy;
    if (await client.collaboratorPermission(authorizedBy) === "admin") {
      permission = "admin";
      snapshotAuthorized = true;
    }
  }
  return {
    permission,
    authorizedBy,
    authorizedSha: candidate?.metadata.authorizedSha ?? "",
    snapshotAuthorized,
    unauthorizedTransition: false,
  };
}

export async function inspectReleasePr(client, { pr, event }) {
  const state = await gatherRepositoryState(client, { pr });
  const labels = recognizedReleaseLabels(state.labels);
  const [candidate, comments] = await Promise.all([findCandidateForPr(client, pr), client.issueComments(pr)]);
  const auth = await resolveAuthorization(client, { pr, event, state, labels, candidate, comments });

  const policy = deriveReleasePolicy({
    labels: state.labels,
    baseRef: state.baseRef,
    sameRepository: state.sameRepository,
    labelActorPermission: auth.permission,
    mainAncestor: state.mainAncestor,
    developAncestor: state.developAncestor,
    leakedDevelopCommit: state.leakedDevelopCommit,
    stableVersion: state.stableVersion,
    headSha: state.headSha,
  });

  const reconciliation = deriveReconciliation({
    policy: {
      state: policy.state,
      kind: policy.kind ?? "",
      label: policy.label ?? "",
      version: policy.version ?? "",
      authorizedSha: policy.authorizedSha ?? "",
      reason: policy.reason,
    },
    draft: state.draft,
    closed: state.closed && !state.merged,
    merged: state.merged,
    headSha: state.headSha,
    candidate: candidate
      ? {
        version: candidate.metadata.version,
        label: candidate.metadata.label,
        sourceSha: candidate.metadata.sourceSha,
        state: candidate.metadata.cwsState,
      }
      : null,
    cwsState: candidate?.metadata.cwsState ?? "none",
  });

  return finalize({ state, labels, policy, reconciliation, candidate, auth, pr });
}

// The shell applied these overrides after the pure reconciler had already spoken. They stay
// separate for the same reason: they are authorization vetoes, not lifecycle transitions.
export function finalize({ state, labels, policy, reconciliation, candidate, auth, pr }) {
  let { action, convertToDraft, reason } = reconciliation;

  if (policy.state === "blocked") {
    action = "block";
    convertToDraft = false;
  }
  if (auth.unauthorizedTransition) {
    action = "block";
    convertToDraft = false;
    reason = auth.reason;
  }
  const candidateSnapshot = candidate ? [candidate.metadata.label] : [];
  const snapshotDiffers = labels.length !== candidateSnapshot.length
    || labels.some((label, index) => label !== candidateSnapshot[index]);
  if (!auth.snapshotAuthorized && candidate && snapshotDiffers) {
    action = "block";
    convertToDraft = false;
    reason = "label snapshot lacks current administrator authorization";
  }

  // An active policy whose head is not the already-approved SHA needs a fresh environment approval
  // before any release mutation runs against it. A freshly authorized label recovers no approved
  // SHA at all, so it always lands here.
  let controllerState = policy.state;
  let milestone = "";
  if (policy.state === "active" && state.headSha !== auth.authorizedSha) {
    if (!auth.authorizedBy) throw new Error("active policy requires a recovered authorizing administrator");
    controllerState = "awaiting-approval";
    milestone = "environment-approval";
  }

  return {
    action,
    convert_to_draft: convertToDraft,
    reason,
    state: controllerState,
    pr_number: pr,
    head_sha: state.headSha,
    version: policy.version ?? "",
    kind: policy.kind ?? "",
    release_label: policy.label ?? "",
    authorized_by: auth.authorizedBy,
    stable_sha: state.stableSha,
    stable_version: state.stableVersion,
    develop_sha: state.developSha,
    trusted_tools_ref: state.trustedToolsRef,
    candidate_version: candidate?.metadata.version ?? "",
    candidate_sha: candidate?.metadata.sourceSha ?? "",
    candidate_label: candidate?.metadata.label ?? "",
    desired_release_labels: JSON.stringify(labels),
    closed: state.closed && !state.merged,
    milestone,
  };
}
