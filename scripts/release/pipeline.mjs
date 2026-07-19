import { latestVersion, nextVersion, parseManifestVersion } from "./version.mjs";

export const recognizedReleaseLabels = ["release/patch", "release/minor", "release/major"];
const recognized = new Set(recognizedReleaseLabels);
const generatedHead = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const markerPattern = /<!-- lurkloot-release-candidate:([^\n]+) -->\s*$/;

function labelNames(labels) {
  return (labels ?? []).map((label) => typeof label === "string" ? label : label.name);
}

export function selectReleaseLabel(labels) {
  const selected = labelNames(labels).filter((label) => recognized.has(label));
  if (selected.length > 1) throw new Error("only one release label can be specified");
  return selected[0];
}

export function isGeneratedReleaseHead(head) {
  return generatedHead.test(head ?? "");
}

export function releasePolicy({ labels, head, tags }) {
  if (isGeneratedReleaseHead(head)) return { action: "ignore" };
  const label = selectReleaseLabel(labels);
  if (!label) return { action: "orphan" };
  const bump = label.slice("release/".length);
  return {
    action: "prepare",
    bump,
    label,
    version: nextVersion(latestVersion(tags ?? []), bump),
  };
}

// One tag spans candidacy and stable publication. The candidate publishes it as a prerelease at the
// release branch head; merging flips that same release to latest without ever moving the tag.
export function candidateTag(version) {
  parseManifestVersion(version);
  return `v${version}`;
}

export function candidateMarker({ pr, version, head }) {
  if (!Number.isInteger(Number(pr)) || Number(pr) < 1) throw new Error("candidate PR must be a positive integer");
  parseManifestVersion(version);
  if (!isGeneratedReleaseHead(head) || head !== `release/${version}`) {
    throw new Error(`candidate head must be release/${version}`);
  }
  return `<!-- lurkloot-release-candidate:${JSON.stringify({ pr: Number(pr), version, head })} -->`;
}

export function parseCandidateMarker(body) {
  const match = markerPattern.exec(body ?? "");
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]);
    candidateMarker(value);
    return value;
  } catch {
    throw new Error("candidate release has invalid ownership metadata");
  }
}

export function validatePromotion({ stableVersion, version, label }) {
  parseManifestVersion(stableVersion);
  parseManifestVersion(version);
  if (!recognized.has(label)) throw new Error(`unrecognized release label ${label ?? "none"}`);
  const bump = label.slice("release/".length);
  const expected = nextVersion(stableVersion, bump);
  if (version !== expected) throw new Error(`${label} expected ${expected}, received ${version}`);
  return { bump, version };
}

// The upload steps glob their assets directory, so anything a build step leaves behind would be
// published. Both the candidate prerelease and the stable release must carry exactly this set.
export function expectedReleaseAssets(version) {
  return [
    "SHA256SUMS",
    `lurkloot-${version}-chrome.crx`,
    `lurkloot-${version}-chrome.zip`,
    `lurkloot-${version}-firefox-sources.zip`,
    `lurkloot-${version}-firefox.zip`,
  ];
}

export function assertReleaseAssets({ names, version }) {
  const expected = expectedReleaseAssets(version);
  const actual = [...names].sort();
  for (const name of actual) {
    if (!expected.includes(name)) throw new Error(`unexpected release asset: ${name}`);
  }
  for (const name of expected) {
    if (!actual.includes(name)) throw new Error(`missing release asset: ${name}`);
  }
  return expected;
}
