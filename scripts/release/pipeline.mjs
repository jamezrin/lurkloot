import { latestVersion, nextVersion, parseManifestVersion } from "./version.mjs";

export const recognizedReleaseLabels = ["release/patch", "release/minor", "release/major"];
const recognized = new Set(recognizedReleaseLabels);
const generatedHead = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const markerPattern = /<!-- lurkloot-release-candidate:([^\n]+) -->\s*$/;

function labelNames(labels) {
  return (labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
}

export function selectReleaseLabel(labels) {
  const selected = labelNames(labels).filter((label) => recognized.has(label));
  if (selected.length > 1) throw new Error("only one release label can be specified");
  return selected[0];
}

export function isGeneratedReleaseHead(head) {
  return generatedHead.test(head ?? "");
}

// `exclude` carries the tags of releases that are still prereleases. A candidate publishes vX.Y.Z
// before the version is final, so that tag sits in the stable namespace while it is only a
// candidate; counting it would make the next derivation skip a version. See version.mjs.
export function releasePolicy({ labels, head, tags, exclude = [] }) {
  if (isGeneratedReleaseHead(head)) return { action: "ignore" };
  const label = selectReleaseLabel(labels);
  if (!label) return { action: "orphan" };
  const bump = label.slice("release/".length);
  const stableTags = (tags ?? []).filter((tag) => !exclude.includes(tag));
  return {
    action: "prepare",
    bump,
    label,
    version: nextVersion(latestVersion(stableTags), bump),
  };
}

// One tag spans candidacy and stable publication. The candidate publishes it as a prerelease at the
// release branch head; merging flips that same release to latest without ever moving the tag.
export function candidateTag(version) {
  parseManifestVersion(version);
  return `v${version}`;
}

export function candidateMarker({ pr, version, head }) {
  if (!Number.isInteger(Number(pr)) || Number(pr) < 1)
    throw new Error("candidate PR must be a positive integer");
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

// The standalone `lurkloot` executables (#1022), one archive per target. Each target is built on
// a runner of its own OS and architecture (.github/workflows/build-cli-executables.yml), and
// packages/cli/scripts/buildExecutable.mjs names its archive with cliArchiveName.
export const cliExecutableTargets = [
  { id: "linux-x64", platform: "linux", arch: "x64", archive: "tar.gz" },
  { id: "linux-arm64", platform: "linux", arch: "arm64", archive: "tar.gz" },
  { id: "macos-arm64", platform: "darwin", arch: "arm64", archive: "tar.gz" },
  { id: "macos-x64", platform: "darwin", arch: "x64", archive: "tar.gz" },
  { id: "windows-x64", platform: "win32", arch: "x64", archive: "zip" },
];

/** Selects the archive target matching the build runner. */
export function cliExecutableTarget(platform, arch) {
  const target = cliExecutableTargets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) throw new Error(`no lurkloot executable target for ${platform}-${arch}`);
  return target;
}

/** Names the archive's top-level directory. */
export function cliArchiveBase(version, target) {
  parseManifestVersion(version);
  return `lurkloot-cli-${version}-${target.id}`;
}

/** Adds the target's archive extension to the release asset name. */
export function cliArchiveName(version, target) {
  return `${cliArchiveBase(version, target)}.${target.archive}`;
}

// The desktop app's unsigned installers (#1025). Each target is built on a runner of its own OS and
// architecture (.github/workflows/build-desktop-installers.yml), and
// packages/desktop/scripts/collectInstallers.mjs renames Tauri's bundles with desktopInstallerName.
// `bundle` is the folder under target/release/bundle/ that Tauri writes and `suffix` the end of the
// file name there; `asset` is what follows the target id in the release asset's name.
export const desktopInstallerTargets = [
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    installers: [
      { bundle: "appimage", suffix: ".AppImage", asset: ".AppImage" },
      { bundle: "deb", suffix: ".deb", asset: ".deb" },
    ],
  },
  {
    id: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    installers: [
      { bundle: "appimage", suffix: ".AppImage", asset: ".AppImage" },
      { bundle: "deb", suffix: ".deb", asset: ".deb" },
    ],
  },
  {
    id: "macos-arm64",
    platform: "darwin",
    arch: "arm64",
    installers: [{ bundle: "dmg", suffix: ".dmg", asset: ".dmg" }],
  },
  {
    id: "macos-x64",
    platform: "darwin",
    arch: "x64",
    installers: [{ bundle: "dmg", suffix: ".dmg", asset: ".dmg" }],
  },
  {
    id: "windows-x64",
    platform: "win32",
    arch: "x64",
    installers: [
      { bundle: "msi", suffix: ".msi", asset: ".msi" },
      { bundle: "nsis", suffix: "-setup.exe", asset: "-setup.exe" },
    ],
  },
];

/** Selects the installer target matching the build runner. */
export function desktopInstallerTarget(platform, arch) {
  const target = desktopInstallerTargets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) throw new Error(`no desktop installer target for ${platform}-${arch}`);
  return target;
}

/** Names one installer's release asset. */
export function desktopInstallerName(version, target, installer) {
  parseManifestVersion(version);
  return `lurkloot-desktop-${version}-${target.id}${installer.asset}`;
}

/** Every installer's release asset name for one version. */
export function desktopInstallerNames(version) {
  return desktopInstallerTargets.flatMap((target) =>
    target.installers.map((installer) => desktopInstallerName(version, target, installer)),
  );
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
    ...cliExecutableTargets.map((target) => cliArchiveName(version, target)),
    ...desktopInstallerNames(version),
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
