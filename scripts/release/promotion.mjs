import { RELEASE_LABELS } from "./policy.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function desiredPromotionLabel(labels) {
  const recognized = labels.filter((label) => RELEASE_LABELS.includes(label));
  // No release label at all means this merge was an ordinary PR, not a release. That is inert
  // rather than an error, so the caller reports "inactive" and stops.
  if (recognized.length === 0) return null;
  invariant(recognized.length === 1, "merged PR must have exactly one recognized release label");
  return recognized[0];
}

// A promotable candidate is still a DRAFT in its own metadata: the monitor freezes and stages it in
// CWS, but the metadata records the state it was published to GitHub with.
export function assertPromotableMetadata(metadata, { pr }) {
  invariant(metadata.schemaVersion === 2, "candidate metadata must be schema version 2");
  invariant(metadata.releasePr === pr, `candidate metadata claims PR #${metadata.releasePr}, expected #${pr}`);
  invariant(metadata.sourceSha === metadata.authorizedSha, "candidate source SHA must equal its authorized SHA");
  invariant(metadata.cwsState === "DRAFT", `candidate metadata cwsState ${metadata.cwsState} is not promotable`);
  invariant(Object.keys(metadata.artifactChecksums ?? {}).length > 0, "candidate metadata has no artifact checksums");
  invariant(metadata.dockerDigests?.length === 2, "candidate metadata must carry two Docker digests");
  return metadata;
}

export function dockerPromotionTags(imageName, version) {
  const [major, minor] = version.split(".");
  return [
    `${imageName}:${version}`,
    `${imageName}:${major}.${minor}`,
    `${imageName}:${major}`,
    `${imageName}:latest`,
  ];
}

export function stableReleaseNotes(version) {
  return `Stable release v${version} from reviewed candidate.`;
}

export function stableMilestoneBody(marker, { version, initiator }) {
  return [
    marker,
    `@${initiator}, candidate **v${version}** reached **stable**. CWS, immutable release assets, Docker aliases, and production deployment are promoted.`,
  ].join("\n");
}
