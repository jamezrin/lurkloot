const loginPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;

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

const messages = {
  PENDING_REVIEW: "is pending Chrome Web Store review. The candidate is frozen until review is cancelled or completed.",
  STAGED: "is approved and staged in Chrome Web Store. The release PR is ready for final approval and merge.",
  REJECTED: "was rejected by Chrome Web Store. Resolve the rejection, cancel or replace the candidate, and submit again.",
  CANCELLED: "has been cancelled in Chrome Web Store. Return the PR to draft before replacing or abandoning it.",
  PUBLISHED: "is already published in Chrome Web Store. Continue only as an idempotent recovery of the same candidate.",
};

export function renderReleaseComment({ metadata, state }) {
  if (!loginPattern.test(metadata.initiator ?? "")) throw new Error("candidate initiator must be a valid GitHub login");
  const message = messages[state] ?? `reported unexpected Chrome Web Store state ${state}. Publication remains blocked.`;
  return [
    commentMarker(metadata.version, state),
    `@${metadata.initiator}, candidate **v${metadata.version}** ${message}`,
    "",
    `Source: \`${metadata.sourceSha}\``,
  ].join("\n");
}

export function shouldComment(existingBodies, version, state) {
  const marker = commentMarker(version, state);
  return !existingBodies.some((body) => body.includes(marker));
}
