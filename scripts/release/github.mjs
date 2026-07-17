const loginPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;

function validatedUrl(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (/[\x00-\x20\x7f[\]()]|[<>]/.test(value)) {
    throw new Error(`${name} must be a Markdown-safe URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  return value;
}

export function statusMarker(pr) {
  return `<!-- lurkloot-release-pr:${pr}:status -->`;
}

export function milestoneMarker(version, milestone) {
  return `<!-- lurkloot-release:${version}:milestone:${milestone} -->`;
}

export function lifecycleMilestoneGuidance(milestone) {
  const guidance = {
    "candidate-rebuilding": "The old candidate is cancelled; replacement artifacts are rebuilding.",
    "environment-approval": "Approve the cws-review environment after checking this exact SHA.",
    "cws-pending": "Google is reviewing the frozen candidate with deferred publishing.",
    "cws-staged-validation": "CWS already reports the frozen candidate as staged; monitor finalization and release metadata validation remain pending.",
    "reconciliation-blocked": "CWS state is uncertain; reconcile it in the dashboard before retrying.",
  };
  if (!guidance[milestone]) throw new Error(`unknown automatic lifecycle milestone: ${milestone}`);
  return guidance[milestone];
}

export function renderReleaseStatus(status) {
  const links = [
    ["GitHub release", validatedUrl(status.releaseUrl, "releaseUrl")],
    ["Preview", validatedUrl(status.previewUrl, "previewUrl")],
    ["CWS", validatedUrl(status.cwsUrl, "cwsUrl")],
    ["Workflow", validatedUrl(status.workflowUrl, "workflowUrl")],
  ].filter(([, url]) => url);
  // An inert PR has no candidate to name yet, so the identity line is omitted rather than
  // rendered as an empty version.
  const details = [];
  if (status.version) {
    details.push(status.kind ? `- Candidate: \`v${status.version}\` (${status.kind})` : `- Candidate: \`v${status.version}\``);
  }
  if (status.sourceSha) details.push(`- Source: \`${status.sourceSha}\``);
  if (status.checksum) details.push(`- Chrome ZIP: \`${status.checksum}\``);
  if (status.dockerTag) details.push(`- Docker: \`${status.dockerTag}\``);
  if (links.length) details.push(`- Links: ${links.map(([label, url]) => `[${label}](${url})`).join(" · ")}`);
  const sections = [
    statusMarker(status.pr),
    `## Release status: ${status.state.replaceAll("-", " ")}`,
    "",
    ...details,
  ];
  if (status.activity) sections.push("", `**Activity:** ${status.activity}`);
  if (status.action) sections.push("", `**Next action:** ${status.action}`);
  if (status.blocker) sections.push("", `**Blocker:** ${status.blocker}`);
  if (status.recovery) sections.push("", `**Recovery:** ${status.recovery}`);
  return sections.join("\n");
}

export function renderMilestone({ metadata, milestone, guidance }) {
  if (!loginPattern.test(metadata.initiator ?? "")) throw new Error("candidate initiator must be a valid GitHub login");
  return [
    milestoneMarker(metadata.version, milestone),
    `@${metadata.initiator}, candidate **v${metadata.version}** reached **${milestone}**. ${guidance}`,
  ].join("\n");
}

export function commentMarker(version, state) {
  return `<!-- lurkloot-release:${version}:cws:${state} -->`;
}

export function checkConclusion(state, { recovery = false } = {}) {
  if (state === "PENDING_REVIEW") return { status: "in_progress" };
  if (state === "STAGED" || (state === "PUBLISHED" && recovery)) {
    return { status: "completed", conclusion: "success" };
  }
  return { status: "completed", conclusion: "failure" };
}

export function checkTitle(state, { recovery = false } = {}) {
  if (state === "STAGED") return "CWS candidate staged";
  if (state === "PENDING_REVIEW") return "CWS review pending";
  if (state === "PUBLISHED" && recovery) return "CWS candidate already published";
  return "CWS candidate blocked";
}

export function submitCandidateCheck(action, version) {
  if (action === "already-staged") {
    return {
      status: "in_progress",
      title: "CWS candidate staged; validation pending",
      summary: `v${version} is staged in CWS and awaits monitor finalization and release metadata validation.`,
    };
  }
  return {
    status: "in_progress",
    title: "CWS review pending",
    summary: `v${version} is frozen and submitted with staged publishing.`,
  };
}

export function stateGuidance(state, { version, pr, sourceSha, submittedVersion, recovery = false } = {}) {
  if (state === "STAGED") return `v${version} is approved and ready for final PR approval and merge.`;
  if (state === "PENDING_REVIEW") {
    return `v${version} remains frozen while Google reviews it. To replace or abandon it, convert PR #${pr} to draft or remove or change its release label so automation cancels and reconciles the candidate.`;
  }
  if (state === "PUBLISHED" && recovery) {
    return `v${version} matches an explicitly requested partial-publication recovery. Rerun stable promotion for the merged PR.`;
  }
  if (state === "REJECTED") {
    return `v${version} was rejected. Automation has stopped; resolve the rejection in the CWS dashboard and have a repository administrator reconcile the candidate before changing the PR.`;
  }
  if (state === "CANCELLED") {
    return `v${version} is cancelled. Convert PR #${pr} to draft, then remove and reapply or change its release label to trigger automatic reconciliation.`;
  }
  if (state === "POLICY_BLOCKED") {
    return "CWS reports a warning or takedown. Automation has stopped; resolve the policy action in the dashboard and have a repository administrator reconcile the candidate.";
  }
  if (state === "VERSION_MISMATCH") {
    return `CWS reports version ${submittedVersion} instead of v${version}. Automation has stopped; inspect the CWS dashboard and have a repository administrator reconcile the active submission.`;
  }
  if (state === "CANDIDATE_CHANGED") {
    return `Release PR #${pr} no longer matches frozen source ${sourceSha}. Do not merge this head; convert the PR to draft or remove, reapply, or change its release label to trigger automatic reconciliation.`;
  }
  if (state === "none") {
    return `CWS has no submitted v${version} revision. Convert PR #${pr} to draft, verify the frozen GitHub prerelease, then mark it ready to reconcile submission.`;
  }
  if (state === "DRAFT") {
    return `v${version} reported mutable state DRAFT. Convert PR #${pr} to draft or remove, reapply, or change its release label to trigger automatic reconciliation.`;
  }
  return `v${version} reported unexpected state ${state}. Automation has stopped; inspect the CWS dashboard and have a repository administrator reconcile the candidate.`;
}

export function renderReleaseComment({ metadata, state, summary }) {
  if (!loginPattern.test(metadata.initiator ?? "")) throw new Error("candidate initiator must be a valid GitHub login");
  return [
    commentMarker(metadata.version, state),
    `@${metadata.initiator}, candidate **v${metadata.version}** is now **${state}**. ${summary}`,
  ].join("\n");
}

export function renderReleaseNotes({ version, pr, state, summary }) {
  return `Candidate for release PR #${pr}. Chrome Web Store version ${version} last reported ${state}. Source, tag, and downloadable assets remain frozen. ${summary}`;
}

export function renderStepSummary({ version, pr, state, conclusion, summary }) {
  return [
    `## CWS status for v${version}`,
    "",
    `- PR: #${pr}`,
    `- State: \`${state}\``,
    `- Check: \`${conclusion || "pending"}\``,
    `- Guidance: ${summary}`,
    "",
  ].join("\n");
}

export function shouldComment(existingBodies, version, state) {
  const marker = commentMarker(version, state);
  return !existingBodies.some((body) => body.includes(marker));
}
