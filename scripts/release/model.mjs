const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const loginPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const metadataFields = new Set([
  "schemaVersion",
  "version",
  "kind",
  "label",
  "stableVersion",
  "stableSha",
  "developSha",
  "sourceSha",
  "authorizedSha",
  "releasePr",
  "initiator",
  "authorizedBy",
  "trustedToolsSha",
  "createdAt",
  "reconciledAt",
  "chromeZipSha256",
  "artifactChecksums",
  "dockerDigests",
  "cwsState",
  "previewUrl",
]);
const candidateKinds = new Set(["normal", "hotfix"]);
const normalLabels = new Set(["release/patch", "release/minor", "release/major"]);
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
  const newerActiveVersion = activeVersions.find(
    (activeVersion) => activeVersion !== replacingVersion && compareVersions(activeVersion, version) > 0,
  );
  invariant(!newerActiveVersion, `${version} cannot supersede newer active candidate ${newerActiveVersion}`);
  return version;
}

export function candidateAction({ exists, stable, submittedState }) {
  if (stable) return "immutable";
  if (submittedState === "PENDING_REVIEW" || submittedState === "STAGED") return "frozen";
  return exists ? "replace" : "create";
}

const recognizedReleaseLabels = new Set(["release/patch", "release/minor", "release/major", "release/hotfix"]);

export function promotionCwsAction({ version, submittedVersion, submittedState, publishedVersion }) {
  if (submittedState === "STAGED" && submittedVersion === version) return "publish";
  if (submittedState === "PUBLISHED" && publishedVersion === version) return "continue";
  throw new Error("CWS state and version must identify the exact candidate version");
}

export function validatePromotionPullRequest(value) {
  invariant(value.state === "MERGED" && value.mergedAt, "pull request must remain merged");
  invariant(value.headSha === value.expectedHeadSha, "candidate head identity changed");
  invariant(value.mergeSha === value.expectedMergeSha, "candidate merge identity changed");
  const releaseLabels = value.labels.filter((label) => recognizedReleaseLabels.has(label));
  invariant(releaseLabels.length === 1 && releaseLabels[0] === value.expectedLabel, "pull request must have exactly one recognized release label");
  invariant(
    value.checks.some((check) => check.name === "cws-release-ready" && check.conclusion === "SUCCESS")
      && value.checks.every((check) => check.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)),
    "required checks must remain successful",
  );
  return value;
}

export function selectPromotionCandidate(releases, releasePr) {
  const matches = releases.filter((release) => release.schemaVersion === 2 && release.releasePr === releasePr);
  invariant(matches.length > 0, `no candidate claims PR #${releasePr}`);
  invariant(matches.length === 1, `multiple candidates claim PR #${releasePr}`);
  return matches[0];
}

function validateChecksums(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "artifactChecksums must be an object");
  for (const [name, checksum] of Object.entries(value)) {
    invariant(name.length > 0 && !name.includes("/") && !name.includes("\\"), `invalid artifact name ${name}`);
    invariant(sha256Pattern.test(checksum), `invalid checksum for ${name}`);
  }
}

function validateCommonMetadata(value, fields, schemaVersion) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "candidate metadata must be an object");
  invariant(value.schemaVersion === schemaVersion, `schemaVersion must be ${schemaVersion}`);
  for (const field of Object.keys(value)) invariant(fields.has(field), `unexpected field ${field}`);
  for (const field of fields) invariant(Object.hasOwn(value, field), `missing field ${field}`);
  parseVersion(value.version);
  invariant(candidateKinds.has(value.kind), "kind must be normal or hotfix");
  invariant(shaPattern.test(value.sourceSha), "sourceSha must be a lowercase 40-character commit SHA");
  invariant(Number.isSafeInteger(value.releasePr) && value.releasePr > 0, "releasePr must be a positive integer");
  invariant(loginPattern.test(value.initiator), "initiator must be a GitHub login");
  invariant(sha256Pattern.test(value.chromeZipSha256), "chromeZipSha256 must be a SHA-256 value");
  validateChecksums(value.artifactChecksums);
  invariant(
    Array.isArray(value.dockerDigests)
      && value.dockerDigests.length === 2
      && new Set(value.dockerDigests).size === 2
      && value.dockerDigests.every((item) => digestPattern.test(item)),
    "dockerDigests must contain two distinct SHA-256 digests",
  );
  invariant(cwsStates.has(value.cwsState), "cwsState is unsupported");
  const previewUrl = new URL(value.previewUrl);
  invariant(previewUrl.protocol === "https:", "previewUrl must use HTTPS");
}

function validateMetadata(value) {
  validateCommonMetadata(value, metadataFields, 2);
  parseVersion(value.stableVersion);
  invariant(shaPattern.test(value.stableSha), "stableSha must be a lowercase 40-character commit SHA");
  invariant(
    (value.kind === "normal" && shaPattern.test(value.developSha))
      || (value.kind === "hotfix" && value.developSha === null),
    "developSha must be a commit SHA for normal candidates and null for hotfix candidates",
  );
  invariant(
    (value.kind === "normal" && normalLabels.has(value.label))
      || (value.kind === "hotfix" && value.label === "release/hotfix"),
    "label does not match candidate kind",
  );
  invariant(shaPattern.test(value.authorizedSha), "authorizedSha must be a lowercase 40-character commit SHA");
  invariant(value.sourceSha === value.authorizedSha, "sourceSha must equal authorizedSha");
  invariant(loginPattern.test(value.authorizedBy), "authorizedBy must be a GitHub login");
  invariant(shaPattern.test(value.trustedToolsSha), "trustedToolsSha must be a lowercase 40-character commit SHA");
  invariant(typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)), "createdAt must be a timestamp");
  invariant(typeof value.reconciledAt === "string" && !Number.isNaN(Date.parse(value.reconciledAt)), "reconciledAt must be a timestamp");
  return value;
}

const legacyMetadataFields = new Set([
  "schemaVersion", "version", "kind", "sourceSha", "releasePr", "initiator",
  "chromeZipSha256", "artifactChecksums", "dockerDigests", "cwsState", "previewUrl",
]);

export function renderCandidateMetadata(metadata) {
  validateMetadata(metadata);
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function parseCandidateMetadata(json) {
  return validateMetadata(JSON.parse(json));
}

export function parseLegacyCandidateMetadata(json) {
  const value = JSON.parse(json);
  validateCommonMetadata(value, legacyMetadataFields, 1);
  return value;
}
