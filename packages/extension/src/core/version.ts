// Tiny semver-ish helper for deciding whether an extension update is worth
// surfacing to the user. We only care about major/minor: patch bumps are
// typically bugfixes and shouldn't steal a tab.

interface ParsedVersion {
  major: number;
  minor: number;
}

// Parse "major.minor.patch" leniently. Missing trailing parts default to 0
// (so "1" === "1.0.0"). Returns null when major/minor aren't real numbers.
function parse(version: string | undefined): ParsedVersion | null {
  if (!version) return null;
  const [rawMajor = "0", rawMinor = "0"] = version.trim().split(".");
  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

// True when `next` is a higher major or minor than `prev`. Patch-only bumps,
// equal versions, downgrades, and unparseable input all return false.
export function isMinorOrMajorBump(prev: string | undefined, next: string | undefined): boolean {
  const a = parse(prev);
  const b = parse(next);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  return b.minor > a.minor;
}
