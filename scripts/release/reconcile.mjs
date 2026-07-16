const frozen = new Set(["PENDING_REVIEW", "STAGED"]);

export function deriveReconciliation(input) {
  const result = (action, reason, convertToDraft = false) => ({ action, reason, convertToDraft });
  const candidate = input.candidate;
  if (["VERSION_MISMATCH", "POLICY_BLOCKED"].includes(input.cwsState)) {
    return result("block", `CWS reconciliation blocked by ${input.cwsState}`);
  }
  if (candidate?.state === "PUBLISHED" && !input.merged) {
    return result("block", "published candidate cannot be mutated");
  }
  if (input.merged) {
    if (input.policy.state === "active" && candidate?.state === "STAGED") return result("promote", "staged candidate merged");
    return result("none", "merged PR has no matching staged release");
  }
  if (input.closed) return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", "release PR closed")
    : result("none", "closed PR has no candidate");
  if (input.policy.state !== "active") return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", input.policy.reason, frozen.has(candidate.state))
    : result(input.policy.state === "blocked" ? "block" : "none", input.policy.reason);
  const matches = candidate
    && candidate.version === input.policy.version
    && candidate.label === input.policy.label
    && candidate.sourceSha === input.policy.authorizedSha;
  if (!candidate) return result("prepare", "active PR has no candidate");
  if (!matches) return frozen.has(candidate.state)
    ? result("cancel-and-prepare", "frozen candidate differs from desired candidate", true)
    : result("prepare", "mutable candidate differs from desired candidate");
  if (input.draft) return result("none", "mutable candidate is current");
  if (candidate.state === "DRAFT") return result("submit", "ready PR has a current mutable candidate");
  return result("none", "submitted candidate is current");
}
