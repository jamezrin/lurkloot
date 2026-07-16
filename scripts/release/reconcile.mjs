const frozen = new Set(["PENDING_REVIEW", "STAGED"]);
const safeCwsStates = new Set(["none", "DRAFT", "PENDING_REVIEW", "STAGED"]);

function cwsStateMatchesCandidate(candidate, cwsState) {
  if (!candidate) return cwsState === "none";
  if (candidate.state === "DRAFT") return cwsState === "none" || cwsState === "DRAFT";
  if (candidate.state === "PENDING_REVIEW") return cwsState === "PENDING_REVIEW";
  if (candidate.state === "STAGED") return cwsState === "STAGED";
  return false;
}

export function deriveReconciliation(input) {
  const result = (action, reason, convertToDraft = false) => ({ action, reason, convertToDraft });
  const candidate = input.candidate;

  if (!safeCwsStates.has(input.cwsState)) {
    return result("block", `CWS reconciliation blocked by unexpected state ${input.cwsState ?? "missing"}`);
  }
  if (!cwsStateMatchesCandidate(candidate, input.cwsState)) {
    return result("block", "candidate and CWS states are inconsistent");
  }
  if (input.policy.state === "active" && input.headSha !== input.policy.authorizedSha) {
    return result("block", "current PR head differs from the authorized policy SHA");
  }

  const matches = input.policy.state === "active"
    && candidate
    && candidate.version === input.policy.version
    && candidate.label === input.policy.label
    && candidate.sourceSha === input.policy.authorizedSha;

  if (input.merged) {
    if (matches && candidate.state === "STAGED" && input.cwsState === "STAGED") {
      return result("promote", "matching staged candidate merged");
    }
    return input.policy.state === "active"
      ? result("block", "merged release does not match the authorized staged candidate")
      : result("none", "merged PR has no active release policy");
  }
  if (input.closed) return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", "release PR closed")
    : result("none", "closed PR has no candidate");
  if (input.policy.state !== "active") return candidate
    ? result(frozen.has(candidate.state) ? "cancel" : "retire", input.policy.reason, frozen.has(candidate.state))
    : result(input.policy.state === "blocked" ? "block" : "none", input.policy.reason);
  if (!candidate) return result("prepare", "active PR has no candidate");
  if (!matches) return frozen.has(candidate.state)
    ? result("cancel-and-prepare", "frozen candidate differs from desired candidate", true)
    : result("prepare", "mutable candidate differs from desired candidate");
  if (input.draft && frozen.has(candidate.state)) {
    return result("cancel", "draft PR cannot retain a frozen candidate", true);
  }
  if (input.draft) return result("none", "mutable candidate is current");
  if (candidate.state === "DRAFT") return result("submit", "ready PR has a current mutable candidate");
  return result("none", "submitted candidate is current");
}
