const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const loginPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const metadataFields = new Set([
  "schemaVersion",
  "version",
  "kind",
  "sourceSha",
  "releasePr",
  "initiator",
  "chromeZipSha256",
  "artifactChecksums",
  "dockerDigests",
  "cwsState",
  "previewUrl",
]);
const candidateKinds = new Set(["normal", "hotfix"]);
const cwsStates = new Set([
  "DRAFT",
  "PENDING_REVIEW",
  "STAGED",
  "PUBLISHED",
  "REJECTED",
  "CANCELLED",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseVersion(value) {
  const match = semverPattern.exec(value ?? "");
  invariant(match, `${value ?? ""} is not a stable semantic version`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function assertCandidateVersion({ version, stableVersion, activeVersions, replacingVersion }) {
  parseVersion(version);
  invariant(compareVersions(version, stableVersion) > 0, `${version} must be greater than stable version ${stableVersion}`);
  invariant(
    !activeVersions.includes(version) || replacingVersion === version,
    `${version} already has an active candidate`,
  );
  return version;
}

export function candidateAction({ exists, stable, submittedState }) {
  if (stable) return "immutable";
  if (submittedState === "PENDING_REVIEW" || submittedState === "STAGED") return "frozen";
  return exists ? "replace" : "create";
}

function validateChecksums(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "artifactChecksums must be an object");
  for (const [name, checksum] of Object.entries(value)) {
    invariant(name.length > 0 && !name.includes("/") && !name.includes("\\"), `invalid artifact name ${name}`);
    invariant(sha256Pattern.test(checksum), `invalid checksum for ${name}`);
  }
}

function validateMetadata(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "candidate metadata must be an object");
  for (const field of Object.keys(value)) invariant(metadataFields.has(field), `unexpected field ${field}`);
  for (const field of metadataFields) invariant(Object.hasOwn(value, field), `missing field ${field}`);
  invariant(value.schemaVersion === 1, "schemaVersion must be 1");
  parseVersion(value.version);
  invariant(candidateKinds.has(value.kind), "kind must be normal or hotfix");
  invariant(shaPattern.test(value.sourceSha), "sourceSha must be a lowercase 40-character commit SHA");
  invariant(Number.isSafeInteger(value.releasePr) && value.releasePr > 0, "releasePr must be a positive integer");
  invariant(loginPattern.test(value.initiator), "initiator must be a GitHub login");
  invariant(sha256Pattern.test(value.chromeZipSha256), "chromeZipSha256 must be a SHA-256 value");
  validateChecksums(value.artifactChecksums);
  invariant(Array.isArray(value.dockerDigests) && value.dockerDigests.every((item) => digestPattern.test(item)), "dockerDigests must contain SHA-256 digests");
  invariant(cwsStates.has(value.cwsState), "cwsState is unsupported");
  const previewUrl = new URL(value.previewUrl);
  invariant(previewUrl.protocol === "https:", "previewUrl must use HTTPS");
  return value;
}

export function renderCandidateMetadata(metadata) {
  validateMetadata(metadata);
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function parseCandidateMetadata(json) {
  return validateMetadata(JSON.parse(json));
}
