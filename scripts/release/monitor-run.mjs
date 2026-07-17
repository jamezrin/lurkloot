import { packagePaths, changelogPath } from "../release.mjs";
import { RELEASE_LABELS } from "./policy.mjs";

const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// The finalize commit may only touch release metadata. Any other path in the diff means the head
// carries real source changes and is no longer the reviewed candidate.
export const metadataPaths = new Set([...packagePaths, changelogPath]);

export function activeCandidateVersions(releases) {
  return releases
    .filter((release) => release.prerelease
      && tagPattern.test(release.tag_name ?? "")
      && !(release.name ?? "").endsWith("cancelled"))
    .map((release) => release.tag_name.slice(1));
}

export function assertMonitorVersion(version) {
  if (version && !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error("version must be blank or stable SemVer X.Y.Z");
  }
  return version;
}

export function isMetadataOnly(files) {
  return files.every((file) => metadataPaths.has(file));
}

export function countLabel(labels, label) {
  return labels.filter((name) => name === label).length;
}

export function recognizedCount(labels) {
  return labels.filter((name) => RELEASE_LABELS.includes(name)).length;
}

/**
 * Derives the head evidence the candidate-head check consumes.
 *
 * The shell produced this with a detached checkout plus merge-base, diff pathspecs, rev-list and
 * show. The compare API reports the same facts — ancestry, changed paths, and commit count —
 * without putting candidate history on the runner.
 */
export function deriveHeadEvidence({ comparison, headCommit, labelValid, readyValid }) {
  const descendsFromSource = comparison.status === "identical" || comparison.status === "ahead";
  const metadataOnly = descendsFromSource
    && labelValid
    && readyValid
    && isMetadataOnly(comparison.files);
  return {
    schemaVersion: 1,
    descendsFromSource,
    metadataOnly,
    commitCount: comparison.commits.length,
    authorEmail: headCommit.authorEmail,
    subject: headCommit.subject,
  };
}
