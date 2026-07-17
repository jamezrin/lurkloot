const apiOrigin = "https://api.github.com";

// The compare endpoint returns at most 250 commits per page. Silently accepting a truncated
// list would let a hotfix smuggle unreleased develop commits past the leak check, so callers
// paginate and assert the full set was collected.
const comparePageSize = 100;

function linkHasNext(header) {
  return typeof header === "string" && /<[^>]+>;\s*rel="next"/.test(header);
}

export class GitHubClient {
  constructor({ token, repo, fetchImpl = fetch, origin = apiOrigin, graphqlOrigin }) {
    if (!token) throw new Error("GitHub token is required");
    if (!repo) throw new Error("GitHub repository is required");
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl;
    this.origin = origin;
    // api.github.com serves GraphQL at /graphql; GHES serves it alongside the REST root.
    this.graphqlOrigin = graphqlOrigin ?? `${origin}/graphql`;
  }

  async requestText(path, init = {}) {
    const response = await this.fetch(path.startsWith("http") ? path : `${this.origin}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text)?.message ?? text;
      } catch { /* non-JSON error bodies are reported verbatim */ }
      throw new Error(`GitHub API ${path} failed (${response.status}): ${message || "unknown error"}`);
    }
    return { text, headers: response.headers };
  }

  async request(path, init = {}) {
    const { text, headers } = await this.requestText(path, init);
    if (!text) return { body: undefined, headers };
    try {
      return { body: JSON.parse(text), headers };
    } catch {
      throw new Error(`GitHub API returned invalid JSON for ${path}`);
    }
  }

  async json(path, init) {
    return (await this.request(path, init)).body;
  }

  // Every list this controller reads is security relevant, so pagination failures must surface
  // as exceptions rather than a short list that reads as "nothing found".
  async paginate(path) {
    const items = [];
    let page = 1;
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const { body, headers } = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(body)) throw new Error(`GitHub API ${path} did not return a list`);
      items.push(...body);
      if (!linkHasNext(headers?.get?.("link"))) return items;
      page += 1;
    }
  }

  pullRequest(pr) {
    return this.json(`/repos/${this.repo}/pulls/${pr}`);
  }

  async refSha(ref) {
    const body = await this.json(`/repos/${this.repo}/git/ref/heads/${ref}`);
    const sha = body?.object?.sha;
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`ref heads/${ref} did not resolve to a commit SHA`);
    return sha;
  }

  async fileAtRef(path, ref) {
    const body = await this.json(`/repos/${this.repo}/contents/${path}?ref=${ref}`);
    if (body?.encoding !== "base64" || typeof body.content !== "string") {
      throw new Error(`${path}@${ref} did not return base64 content`);
    }
    return Buffer.from(body.content, "base64").toString("utf8");
  }

  async compare(base, head) {
    const commits = [];
    const files = new Set();
    let page = 1;
    let total = 0;
    let status;
    for (;;) {
      const body = await this.json(
        `/repos/${this.repo}/compare/${base}...${head}?per_page=${comparePageSize}&page=${page}`,
      );
      status = body.status;
      total = body.total_commits ?? 0;
      commits.push(...(body.commits ?? []));
      for (const file of body.files ?? []) {
        files.add(file.filename);
        // A rename removes the old path as well; both sides matter when deciding whether a diff
        // touched only release metadata.
        if (file.previous_filename) files.add(file.previous_filename);
      }
      if (commits.length >= total || !body.commits?.length) break;
      page += 1;
    }
    if (commits.length !== total) {
      throw new Error(`compare ${base}...${head} returned ${commits.length} of ${total} commits`);
    }
    return { status, commits: commits.map((commit) => commit.sha), files: [...files] };
  }

  // git merge-base --is-ancestor base head
  async isAncestor(base, head) {
    const { status } = await this.compare(base, head);
    return status === "identical" || status === "ahead";
  }

  collaboratorPermission(login) {
    return this.json(`/repos/${this.repo}/collaborators/${login}/permission`)
      .then((body) => body?.permission ?? "none");
  }

  issueEvents(pr) {
    return this.paginate(`/repos/${this.repo}/issues/${pr}/events`);
  }

  issueComments(pr) {
    return this.paginate(`/repos/${this.repo}/issues/${pr}/comments`);
  }

  createComment(pr, body) {
    return this.json(`/repos/${this.repo}/issues/${pr}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  updateComment(id, body) {
    return this.json(`/repos/${this.repo}/issues/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  releases() {
    return this.paginate(`/repos/${this.repo}/releases`);
  }

  async releaseAsset(url) {
    const { text } = await this.requestText(url, { headers: { accept: "application/octet-stream" } });
    return text;
  }

  releaseByTag(tag) {
    return this.json(`/repos/${this.repo}/releases/tags/${tag}`);
  }

  // Absent references are an expected state during preparation, so a 404 resolves to null while
  // any other failure still propagates.
  async optional(promise) {
    try {
      return await promise;
    } catch (error) {
      if (/ failed \(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  releaseByTagOrNull(tag) {
    return this.optional(this.releaseByTag(tag));
  }

  tagShaOrNull(tag) {
    return this.optional(this.json(`/repos/${this.repo}/git/ref/tags/${tag}`).then((body) => body?.object?.sha ?? null));
  }

  latestReleaseTag() {
    return this.optional(this.json(`/repos/${this.repo}/releases/latest`).then((body) => body?.tag_name ?? null));
  }

  branchShaOrNull(branch) {
    return this.optional(this.refSha(branch));
  }

  createBranch(branch, sha) {
    return this.json(`/repos/${this.repo}/git/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
  }

  /**
   * Performs a server-side merge, the API equivalent of `git merge --no-ff`.
   *
   * Returns "merged" on success, "up-to-date" when there is nothing to bring across, and
   * "conflict" on a 409 — which is the case the caller escalates to a human.
   */
  async mergeBranches(base, head, message) {
    const { text, headers } = await this.requestText(`/repos/${this.repo}/merges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, head, commit_message: message }),
    }).catch((error) => {
      if (/ failed \(409\)/.test(error.message)) return { text: "", headers: null, conflict: true };
      throw error;
    });
    if (headers === null) return "conflict";
    return text ? "merged" : "up-to-date";
  }

  pullRequests({ head, base, state = "open" }) {
    return this.paginate(`/repos/${this.repo}/pulls?state=${state}&head=${encodeURIComponent(`${this.repo.split("/")[0]}:${head}`)}&base=${base}`);
  }

  createPullRequest(fields) {
    return this.json(`/repos/${this.repo}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  addLabels(issue, labels) {
    return this.json(`/repos/${this.repo}/issues/${issue}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    });
  }

  createIssue(fields) {
    return this.json(`/repos/${this.repo}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  createTag(tag, sha) {
    return this.json(`/repos/${this.repo}/git/refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    });
  }

  moveTag(tag, sha) {
    return this.json(`/repos/${this.repo}/git/refs/tags/${tag}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, force: true }),
    });
  }

  deleteTag(tag) {
    return this.requestText(`/repos/${this.repo}/git/refs/tags/${tag}`, { method: "DELETE" });
  }

  createRelease(fields) {
    return this.json(`/repos/${this.repo}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  deleteRelease(id) {
    return this.requestText(`/repos/${this.repo}/releases/${id}`, { method: "DELETE" });
  }

  deleteReleaseAsset(id) {
    return this.requestText(`/repos/${this.repo}/releases/assets/${id}`, { method: "DELETE" });
  }

  async uploadReleaseAsset(release, name, bytes) {
    const url = `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`;
    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    if (!response.ok) throw new Error(`GitHub asset upload for ${name} failed (${response.status})`);
    return response.json?.() ?? undefined;
  }

  // Binds the protected-environment approval to a real administrator. The approvals endpoint is
  // the only record of who released the run, so an unapproved run must never proceed.
  async latestApprover(runId) {
    const approvals = await this.paginate(`/repos/${this.repo}/actions/runs/${runId}/approvals`);
    const approved = approvals.filter((approval) => approval.state === "approved").at(-1);
    const login = approved?.user?.login;
    if (!login) throw new Error("no environment approval is recorded for this run");
    return login;
  }

  updateRelease(id, fields) {
    return this.json(`/repos/${this.repo}/releases/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  createCheckRun(fields) {
    return this.json(`/repos/${this.repo}/check-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  // Releases are cut with lightweight tags, so the ref points straight at the candidate commit.
  // An annotated tag would resolve to a tag object instead, which must never pass as a source SHA.
  async tagCommitSha(tag) {
    const body = await this.json(`/repos/${this.repo}/git/ref/tags/${tag}`);
    if (body?.object?.type !== "commit") throw new Error(`tag ${tag} does not point directly at a commit`);
    return body.object.sha;
  }

  // Container packages live under either a user or an organization namespace depending on who owns
  // the repository, and only one of the two endpoints exists. A 404 selects the other; any other
  // failure propagates rather than being read as "no packages".
  async containerVersions(owner, packageName) {
    const paths = [
      `/users/${owner}/packages/container/${packageName}/versions`,
      `/orgs/${owner}/packages/container/${packageName}/versions`,
    ];
    let lastError;
    for (const path of paths) {
      try {
        return { path, versions: await this.paginate(path) };
      } catch (error) {
        if (!/ failed \(404\)/.test(error.message)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  deleteContainerVersion(path, id) {
    return this.json(`${path}/${id}`, { method: "DELETE" });
  }

  commit(sha) {
    return this.json(`/repos/${this.repo}/commits/${sha}`);
  }

  /**
   * Reads a merged pull request together with its full check rollup.
   *
   * This is GraphQL because the rollup has no REST equivalent that merges check runs and commit
   * statuses. Commit statuses are deliberately reported without a `status` field, exactly as the
   * shell's `gh pr view --json statusCheckRollup` did: the promotion validator requires every
   * check to be COMPLETED, so a legacy commit status fails closed rather than being waved through.
   */
  async promotionPullRequest(pr) {
    const [owner, name] = this.repo.split("/");
    const data = await this.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            state
            mergedAt
            headRefOid
            mergeCommit { oid }
            labels(first: 100) { nodes { name } }
            commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            } } } } } }
          }
        }
      }`,
      { owner, name, number: pr },
    );
    const pull = data?.repository?.pullRequest;
    if (!pull) throw new Error(`pull request #${pr} was not found`);
    const contexts = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    return {
      state: pull.state,
      mergedAt: pull.mergedAt,
      headSha: pull.headRefOid,
      mergeSha: pull.mergeCommit?.oid,
      labels: (pull.labels?.nodes ?? []).map((label) => label.name),
      checks: contexts.map((context) => (context.__typename === "CheckRun"
        ? { name: context.name, status: context.status, conclusion: context.conclusion }
        : { name: context.context, conclusion: context.state })),
    };
  }

  async createBlob(content) {
    const body = await this.json(`/repos/${this.repo}/git/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(content).toString("base64"), encoding: "base64" }),
    });
    return body.sha;
  }

  async createTree(baseTree, entries) {
    const body = await this.json(`/repos/${this.repo}/git/trees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: baseTree, tree: entries }),
    });
    return body.sha;
  }

  async createCommit({ message, tree, parents, author }) {
    const body = await this.json(`/repos/${this.repo}/git/commits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree, parents, author, committer: author }),
    });
    return body.sha;
  }

  // Fast-forward only. A rejected update means the branch moved under us, which must abort the
  // finalize rather than overwrite whatever landed there.
  updateBranch(branch, sha) {
    return this.json(`/repos/${this.repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, force: false }),
    });
  }

  dispatchWorkflow(workflow, ref) {
    return this.requestText(`/repos/${this.repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref }),
    });
  }

  async graphql(query, variables) {
    const body = await this.json(this.graphqlOrigin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (body?.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${body.errors.map((error) => error.message).join("; ")}`);
    }
    return body.data;
  }

  // Converting a pull request back to draft has no REST equivalent; only this GraphQL mutation
  // does it, which is why the node id is threaded through rather than the PR number.
  async convertToDraft(nodeId) {
    const data = await this.graphql(
      "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      { id: nodeId },
    );
    if (data?.convertPullRequestToDraft?.pullRequest?.isDraft !== true) {
      throw new Error("pull request did not convert to draft");
    }
  }

  async assetBytes(url) {
    const response = await this.fetch(url, {
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${url} failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
}
