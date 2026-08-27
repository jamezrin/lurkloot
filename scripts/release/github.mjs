import { candidateMarker, candidateTag, parseCandidateMarker } from "./pipeline.mjs";
import { candidateStatusContext, requiredMainStatusContexts } from "./checks.mjs";

const apiOrigin = "https://api.github.com";
const statusMarker = "<!-- lurkloot-release-status -->";

export class GitHubClient {
  constructor({ repository, token, fetchImpl = fetch }) {
    if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.repository = repository;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(path, { allowNotFound = false, body, headers, ...init } = {}) {
    const url = path.startsWith("https://") ? path : `${apiOrigin}${path}`;
    const response = await this.fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2026-03-10",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return undefined;
    const text = await response.text();
    let value;
    if (text) {
      try { value = JSON.parse(text); } catch { value = text; }
    }
    if (!response.ok) {
      throw new Error(`GitHub API failed (${response.status}): ${value?.message ?? value ?? "unknown error"}`);
    }
    return value;
  }

  repoPath(path) {
    return `/repos/${this.repository}${path}`;
  }

  ref(tag) {
    return this.request(this.repoPath(`/git/ref/tags/${encodeURIComponent(tag)}`), { allowNotFound: true });
  }

  createRef(tag, sha) {
    return this.request(this.repoPath("/git/refs"), {
      method: "POST",
      body: { ref: `refs/tags/${tag}`, sha },
    });
  }

  updateRef(tag, sha) {
    return this.request(this.repoPath(`/git/refs/tags/${encodeURIComponent(tag)}`), {
      method: "PATCH",
      body: { sha, force: true },
    });
  }

  releases() {
    return this.request(this.repoPath("/releases?per_page=100"));
  }

  releaseByTag(tag) {
    return this.request(this.repoPath(`/releases/tags/${encodeURIComponent(tag)}`), { allowNotFound: true });
  }

  createRelease(body) {
    return this.request(this.repoPath("/releases"), { method: "POST", body });
  }

  updateRelease(id, body) {
    return this.request(this.repoPath(`/releases/${id}`), { method: "PATCH", body });
  }

  deleteAsset(id) {
    return this.request(this.repoPath(`/releases/assets/${id}`), { method: "DELETE" });
  }

  uploadAsset(uploadUrl, { name, bytes }) {
    const base = uploadUrl.replace(/\{.*$/, "");
    return this.request(`${base}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
  }

  comments(pr) {
    return this.request(this.repoPath(`/issues/${pr}/comments`));
  }

  createComment(pr, body) {
    return this.request(this.repoPath(`/issues/${pr}/comments`), { method: "POST", body: { body } });
  }

  updateComment(id, body) {
    return this.request(this.repoPath(`/issues/comments/${id}`), { method: "PATCH", body: { body } });
  }

  createStatus(sha, body) {
    return this.request(this.repoPath(`/statuses/${encodeURIComponent(sha)}`), { method: "POST", body });
  }
}

// The prerelease check is what stops a late candidate build from overwriting a release that has
// already been promoted: promotion clears the flag, so every later reconcile against it fails here.
// A candidate belongs to its release branch, not to whichever pull request published it first.
// Merge-first has two legitimate publishers: the labelled source pull request builds the candidate
// at label time, and the generated release pull request rebuilds and promotes it after the cut.
// Scoping ownership to `head` lets the second take over from the first while still rejecting a
// release for another version, an unmarked release, and anything already promoted.
function assertOwnedPrerelease(release, { version }) {
  const ownership = parseCandidateMarker(release.body);
  if (!release.prerelease) {
    throw new Error(`refusing to modify v${version}: release is already promoted`);
  }
  if (ownership?.version !== version || ownership.head !== `release/${version}`) {
    throw new Error(`refusing to modify v${version}: release does not belong to release/${version}`);
  }
}

function releaseBody({ notes, pr, version }) {
  const marker = candidateMarker({ pr, version, head: `release/${version}` });
  return [notes.trim(), marker].filter(Boolean).join("\n\n");
}

export async function reconcilePrerelease({ client, pr, version, sha, notes, assets }) {
  const tag = candidateTag(version);
  const [ref, existingRelease] = await Promise.all([client.ref(tag), client.releaseByTag(tag)]);
  if (ref && !existingRelease && ref.object?.sha !== sha) {
    throw new Error(`refusing to recover ${tag}: it points to another commit`);
  }
  if (existingRelease) assertOwnedPrerelease(existingRelease, { version });

  if (existingRelease && !ref) await client.createRef(tag, sha);
  else if (existingRelease && ref.object?.sha !== sha) await client.updateRef(tag, sha);

  const body = {
    tag_name: tag,
    // The title is the stable one from the outset. Promotion is a state change on the same release,
    // so nothing about how it reads should differ between the prerelease and the final release.
    name: `v${version}`,
    body: releaseBody({ notes, pr, version }),
    draft: false,
    prerelease: true,
    make_latest: "false",
  };
  const release = existingRelease
    ? await client.updateRelease(existingRelease.id, body)
    : await client.createRelease({ ...body, target_commitish: sha });
  const existingAssets = new Map((release.assets ?? existingRelease?.assets ?? []).map((asset) => [asset.name, asset]));
  for (const asset of assets) {
    const existing = existingAssets.get(asset.name);
    if (existing) await client.deleteAsset(existing.id);
    await client.uploadAsset(release.upload_url ?? existingRelease.upload_url, asset);
  }
  return { release, tag };
}

export async function setCommitStatus({ client, sha, state, targetUrl = "", context = candidateStatusContext }) {
  const descriptions = {
    pending: "Release candidate is building",
    success: "Release candidate is ready",
    failure: "Release candidate failed",
  };
  if (!descriptions[state]) throw new Error(`unsupported commit status: ${state}`);
  return client.createStatus(sha, {
    state,
    context,
    description: descriptions[state],
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

export async function setCandidateStatuses(options) {
  return Promise.all(requiredMainStatusContexts.map((context) => setCommitStatus({ ...options, context })));
}

// The tags of every release still marked as a prerelease. These are candidates that have not been
// promoted, so they must not count toward the next version derivation.
export async function prereleaseTags({ client }) {
  const releases = await client.releases();
  return (releases ?? []).filter((release) => release.prerelease).map((release) => release.tag_name);
}

// Promotion is the terminal transition for a candidate: the same release object and the same tag
// become the stable release. It is deliberately not creatable from nothing — a version with no
// candidate has no reviewed artifacts to publish.
export async function promotePrerelease({ client, pr, version, notes }) {
  const tag = candidateTag(version);
  const release = await client.releaseByTag(tag);
  if (!release) throw new Error(`cannot promote ${tag}: no candidate release exists`);
  if (!release.prerelease) {
    const ownership = parseCandidateMarker(release.body);
    // Promotion writes notes without the candidate marker. A stable release at this
    // tag is the terminal state; recovery must no-op even when that marker is gone.
    if (ownership && (ownership.version !== version || ownership.head !== `release/${version}`)) {
      throw new Error(`refusing to promote ${tag}: release does not belong to release/${version}`);
    }
    return { release, tag, promoted: false };
  }
  assertOwnedPrerelease(release, { version });
  const promoted = await client.updateRelease(release.id, {
    name: `v${version}`,
    body: notes.trim(),
    draft: false,
    prerelease: false,
    make_latest: "true",
  });
  return { release: promoted, tag, promoted: true };
}

export async function upsertComment({ client, pr, body }) {
  const rendered = `${statusMarker}\n${body}`;
  const comments = await client.comments(pr);
  const existing = comments.find((comment) => comment.body?.startsWith(statusMarker));
  if (existing) return client.updateComment(existing.id, rendered);
  return client.createComment(pr, rendered);
}
