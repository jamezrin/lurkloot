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

  deleteRef(tag) {
    return this.request(this.repoPath(`/git/refs/tags/${encodeURIComponent(tag)}`), {
      method: "DELETE",
      allowNotFound: true,
    });
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

  deleteRelease(id) {
    return this.request(this.repoPath(`/releases/${id}`), { method: "DELETE" });
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

function assertOwnedPrerelease(release, { pr, version }) {
  const ownership = parseCandidateMarker(release.body);
  if (!release.prerelease || ownership?.pr !== Number(pr) || ownership.version !== version) {
    throw new Error(`refusing to modify candidate-v${version}: release is stable or owned by another pull request`);
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
  if (existingRelease) assertOwnedPrerelease(existingRelease, { pr, version });

  if (existingRelease && !ref) await client.createRef(tag, sha);
  else if (existingRelease && ref.object?.sha !== sha) await client.updateRef(tag, sha);

  const body = {
    tag_name: tag,
    name: `${version} candidate`,
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

export async function retirePrerelease({ client, pr, version }) {
  const tag = candidateTag(version);
  const release = await client.releaseByTag(tag);
  if (!release) return "absent";
  assertOwnedPrerelease(release, { pr, version });
  await client.deleteRef(tag);
  await client.deleteRelease(release.id);
  return "retired";
}

export async function upsertComment({ client, pr, body }) {
  const rendered = `${statusMarker}\n${body}`;
  const comments = await client.comments(pr);
  const existing = comments.find((comment) => comment.body?.startsWith(statusMarker));
  if (existing) return client.updateComment(existing.id, rendered);
  return client.createComment(pr, rendered);
}
