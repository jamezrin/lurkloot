function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("candidate head evidence must be valid JSON");
  }
}

export function parseCandidateHeadEvidence(text) {
  const evidence = parseJson(text);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("candidate head evidence must be an object");
  }
  if (evidence.schemaVersion !== 1) throw new Error("candidate head evidence schemaVersion must be 1");
  if (typeof evidence.descendsFromSource !== "boolean") {
    throw new Error("candidate head evidence descendsFromSource must be a boolean");
  }
  if (typeof evidence.metadataOnly !== "boolean") {
    throw new Error("candidate head evidence metadataOnly must be a boolean");
  }
  if (!Number.isInteger(evidence.commitCount) || evidence.commitCount < 0) {
    throw new Error("candidate head evidence commitCount must be a non-negative integer");
  }
  if (typeof evidence.authorEmail !== "string") {
    throw new Error("candidate head evidence authorEmail must be a string");
  }
  if (typeof evidence.subject !== "string") {
    throw new Error("candidate head evidence subject must be a string");
  }
  return evidence;
}
