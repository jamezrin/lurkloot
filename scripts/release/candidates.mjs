import { parseCandidateMetadata } from "./model.mjs";

const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function candidateReleases(releases) {
  return releases
    .filter((release) => release.draft === false && release.prerelease === true && tagPattern.test(release.tag_name ?? ""))
    .map((release) => ({
      tag: release.tag_name,
      name: release.name,
      version: release.tag_name.slice(1),
      asset: release.assets?.find((asset) => asset.name === "candidate.json")?.url ?? null,
    }))
    .filter((release) => release.asset);
}

// A release whose name is "vX.Y.Z cancelled" is a tombstone, and metadata whose version disagrees
// with its own tag is not trustworthy. Both are ignored rather than treated as active candidates.
export function isActiveCandidate(release, metadata) {
  if (release.name === `v${release.version} cancelled`) return false;
  return metadata?.version === release.version;
}

/**
 * Locates the single active candidate claiming a PR.
 *
 * Unlike the shell loop this replaces, a transport failure propagates instead of yielding an empty
 * result. Discovery returning "no candidate" is what drives the controller to build a fresh one, so
 * a swallowed API error there would rebuild a candidate that is already frozen in CWS review.
 */
export async function findCandidateForPr(client, pr) {
  const releases = candidateReleases(await client.releases());
  let found = null;
  for (const release of releases) {
    // Transport errors propagate; only unreadable metadata is skipped.
    const raw = await client.releaseAsset(release.asset);
    let metadata;
    try {
      metadata = parseCandidateMetadata(raw);
    } catch {
      continue;
    }
    if (!isActiveCandidate(release, metadata)) continue;
    if (metadata.schemaVersion !== 2 || metadata.releasePr !== pr) continue;
    if (found) throw new Error(`multiple active candidates claim PR #${pr}`);
    found = { release, metadata };
  }
  return found;
}
