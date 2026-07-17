import assert from "node:assert/strict";
import test from "node:test";
import { candidateReleases, findCandidateForPr, isActiveCandidate } from "./candidates.mjs";
import { candidateMetadata } from "./fixtures/candidate.mjs";

const release = (overrides = {}) => ({
  tag_name: "v1.5.0",
  name: "v1.5.0",
  draft: false,
  prerelease: true,
  assets: [{ name: "candidate.json", url: "https://api.github.com/asset/1" }],
  ...overrides,
});

const clientFor = (releases, assets) => ({
  releases: async () => releases,
  releaseAsset: async (url) => assets[url],
});

test("only non-draft prereleases with a semver tag and candidate asset are considered", () => {
  assert.equal(candidateReleases([release()]).length, 1);
  assert.equal(candidateReleases([release({ draft: true })]).length, 0);
  assert.equal(candidateReleases([release({ prerelease: false })]).length, 0);
  assert.equal(candidateReleases([release({ tag_name: "v1.5" })]).length, 0);
  assert.equal(candidateReleases([release({ tag_name: "nightly" })]).length, 0);
  assert.equal(candidateReleases([release({ assets: [] })]).length, 0);
});

test("cancelled tombstones and tag/version disagreement are not active candidates", () => {
  const entry = { tag: "v1.5.0", name: "v1.5.0", version: "1.5.0", asset: "u" };
  assert.equal(isActiveCandidate(entry, candidateMetadata()), true);
  assert.equal(isActiveCandidate({ ...entry, name: "v1.5.0 cancelled" }, candidateMetadata()), false);
  assert.equal(isActiveCandidate(entry, candidateMetadata({ version: "1.6.0" })), false);
});

test("finds the single candidate claiming a PR", async () => {
  const client = clientFor([release()], { "https://api.github.com/asset/1": JSON.stringify(candidateMetadata()) });
  const found = await findCandidateForPr(client, 120);
  assert.equal(found.metadata.version, "1.5.0");
  assert.equal(found.release.tag, "v1.5.0");
});

test("candidates claiming another PR are ignored", async () => {
  const client = clientFor([release()], {
    "https://api.github.com/asset/1": JSON.stringify(candidateMetadata({ releasePr: 999 })),
  });
  assert.equal(await findCandidateForPr(client, 120), null);
});

test("two candidates claiming one PR is a hard error", async () => {
  const releases = [
    release(),
    release({ tag_name: "v1.6.0", name: "v1.6.0", assets: [{ name: "candidate.json", url: "https://api.github.com/asset/2" }] }),
  ];
  const client = clientFor(releases, {
    "https://api.github.com/asset/1": JSON.stringify(candidateMetadata()),
    "https://api.github.com/asset/2": JSON.stringify(candidateMetadata({ version: "1.6.0" })),
  });
  await assert.rejects(findCandidateForPr(client, 120), /multiple active candidates claim PR #120/);
});

test("unreadable candidate metadata is skipped, not fatal", async () => {
  const releases = [
    release({ tag_name: "v1.4.5", name: "v1.4.5", assets: [{ name: "candidate.json", url: "https://api.github.com/asset/bad" }] }),
    release(),
  ];
  const client = clientFor(releases, {
    "https://api.github.com/asset/bad": "{not json",
    "https://api.github.com/asset/1": JSON.stringify(candidateMetadata()),
  });
  assert.equal((await findCandidateForPr(client, 120)).metadata.version, "1.5.0");
});

// The shell loop read releases through a process substitution, where neither `set -e` nor
// pipefail propagates failure. A transient API error yielded "no candidate", which reconciles
// as `prepare` and rebuilds a candidate that may already be frozen in CWS review.
test("a transport failure during discovery throws instead of reporting no candidate", async () => {
  const client = {
    releases: async () => { throw new Error("GitHub API /releases failed (503): Service Unavailable"); },
    releaseAsset: async () => "",
  };
  await assert.rejects(findCandidateForPr(client, 120), /failed \(503\)/);
});

test("a transport failure fetching an asset throws instead of skipping the candidate", async () => {
  const client = {
    releases: async () => [release()],
    releaseAsset: async () => { throw new Error("GitHub API /asset/1 failed (503): Service Unavailable"); },
  };
  await assert.rejects(findCandidateForPr(client, 120), /failed \(503\)/);
});
