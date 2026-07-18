import { latestVersion, nextVersion, parseManifestVersion } from "./version.mjs";

export const recognizedReleaseLabels = ["release/patch", "release/minor", "release/major"];
const recognized = new Set(recognizedReleaseLabels);
const generatedHead = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const markerPattern = /<!-- lurkloot-release-candidate:([^\n]+) -->/;

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

export function candidateTag(version) {
  parseManifestVersion(version);
  return `candidate-v${version}`;
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
