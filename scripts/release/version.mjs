const stable = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const bumps = new Set(["patch", "minor", "major"]);

export function parseVersion(value) {
  const match = stable.exec(value ?? "");
  if (!match) throw new Error(`${value} is not stable SemVer X.Y.Z`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// Git tags carry a v prefix, package manifests must not, so manifest validation is strict.
export function parseManifestVersion(value) {
  if (typeof value === "string" && value.startsWith("v")) throw new Error(`${value} is not stable SemVer X.Y.Z`);
  return parseVersion(value);
}

export function nextVersion(current, bump) {
  if (!bumps.has(bump)) throw new Error(`bump must be one of ${[...bumps].join(", ")}`);
  const { major, minor, patch } = parseVersion(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Staging candidates and prereleases must never influence the next version. This function only
// filters by tag shape, and a candidate is now published as `vX.Y.Z`, which is stable-shaped — so
// that guarantee lives in `releasePolicy`, which excludes the tags of unpromoted prereleases before
// calling here. Do not rely on the tag name alone to keep a candidate out of a bump.
export function latestVersion(tags) {
  const versions = tags.filter((tag) => stable.test(tag)).map(parseVersion);
  if (versions.length === 0) return "0.0.0";
  versions.sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch);
  const top = versions.at(-1);
  return `${top.major}.${top.minor}.${top.patch}`;
}
