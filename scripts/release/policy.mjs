import { parseVersion } from "./model.mjs";

export const RELEASE_LABELS = Object.freeze([
  "release/patch", "release/minor", "release/major", "release/hotfix",
]);

export function deriveVersion(stableVersion, label) {
  const [major, minor, patch] = parseVersion(stableVersion);
  if (label === "release/major") return `${major + 1}.0.0`;
  if (label === "release/minor") return `${major}.${minor + 1}.0`;
  if (label === "release/patch" || label === "release/hotfix") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported release label ${label}`);
}

export function deriveReleasePolicy(input) {
  const selected = input.labels.filter((label) => RELEASE_LABELS.includes(label));
  if (selected.length === 0) return { state: "inactive", reason: "no release label" };
  const blocked = (reason) => ({ state: "blocked", reason });
  if (selected.length !== 1) return blocked("exactly one release label is required");
  if (input.baseRef !== "main" || !input.sameRepository) return blocked("release PR must be a same-repository PR to main");
  if (input.labelActorPermission !== "admin") return blocked("release label must be authorized by a repository administrator");
  const label = selected[0];
  const kind = label === "release/hotfix" ? "hotfix" : "normal";
  if (!input.mainAncestor) return blocked(`${kind} candidate must descend from main`);
  if (kind === "normal" && !input.developAncestor) return blocked("normal candidate must derive from develop");
  if (kind === "hotfix" && input.leakedDevelopCommit) return blocked(`hotfix contains unreleased develop commit ${input.leakedDevelopCommit}`);
  return {
    state: "active", kind, label, version: deriveVersion(input.stableVersion, label),
    authorizedSha: input.headSha, reason: `${kind} release candidate`,
  };
}
