const loginPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;

function validatedUrl(value, name) {
  if (value === undefined || value === null || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  return value;
}

export function statusMarker(pr) {
  return `<!-- lurkloot-release-pr:${pr}:status -->`;
}

export function milestoneMarker(version, milestone) {
  return `<!-- lurkloot-release:${version}:milestone:${milestone} -->`;
}

export function renderReleaseStatus(status) {
  const links = [
    ["GitHub release", validatedUrl(status.releaseUrl, "releaseUrl")],
    ["Preview", validatedUrl(status.previewUrl, "previewUrl")],
    ["CWS", validatedUrl(status.cwsUrl, "cwsUrl")],
    ["Workflow", validatedUrl(status.workflowUrl, "workflowUrl")],
  ].filter(([, url]) => url);
  const details = [
    `- Candidate: \`v${status.version}\` (${status.kind})`,
    `- Source: \`${status.sourceSha}\``,
  ];
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
  if (state === "PENDING_REVIEW") return `v${version} remains frozen while Google reviews it.`;
  if (state === "PUBLISHED" && recovery) {
    return `v${version} matches an explicitly requested partial-publication recovery. Rerun stable promotion for the merged PR.`;
  }
  if (state === "REJECTED") {
    return `v${version} was rejected. Correct the issues in the CWS dashboard, cancel or abandon this candidate, then prepare and submit a replacement.`;
  }
  if (state === "CANCELLED") {
    return `v${version} is cancelled. Return the PR to draft and run Prepare prerelease again, or abandon it before choosing a higher version.`;
  }
  if (state === "POLICY_BLOCKED") {
    return "CWS reports a warning or takedown. Resolve the policy action in the dashboard before any release operation.";
  }
  if (state === "VERSION_MISMATCH") {
    return `CWS reports version ${submittedVersion} instead of v${version}. Stop and reconcile the active CWS submission before retrying.`;
  }
  if (state === "CANDIDATE_CHANGED") {
    return `Release PR #${pr} no longer matches frozen source ${sourceSha}. Cancel CWS review, restore or replace the candidate through Prepare prerelease, and do not merge this head.`;
  }
  if (state === "none") {
    return `CWS has no submitted v${version} revision. Run Submit candidate again against the frozen GitHub prerelease.`;
  }
  return `v${version} reported ${state}. Inspect the CWS dashboard and use Cancel candidate before replacing or abandoning it.`;
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
