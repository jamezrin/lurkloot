export function parseStatusOutputs(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    publishedVersion: values.published_version ?? "none",
    submittedVersion: values.submitted_version ?? "none",
    submittedState: values.submitted_state ?? "none",
    warned: values.warned === "true",
    takenDown: values.taken_down === "true",
  };
}

export function deriveCwsState({ status, version, sourceSha, headSha, recoveryRequested = false, candidateHeadValid = true }) {
  let state = status.submittedState;
  if (status.warned || status.takenDown) state = "POLICY_BLOCKED";
  if (status.submittedVersion !== version && state !== "none") state = "VERSION_MISMATCH";
  if (state === "PENDING_REVIEW" && headSha !== sourceSha) state = "CANDIDATE_CHANGED";
  if (state === "STAGED" && !candidateHeadValid) state = "CANDIDATE_CHANGED";
  const recovery = state === "none" && status.publishedVersion === version && recoveryRequested;
  if (recovery) state = "PUBLISHED";
  return { state, recovery };
}
