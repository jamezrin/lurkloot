import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, reconcilePrerelease, retirePrerelease, upsertComment } from "./github.mjs";
import { candidateMarker } from "./pipeline.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return body === undefined ? "" : JSON.stringify(body); },
  };
}

function recordingFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push({ method, path, init });
    const key = `${method} ${path}`;
    const result = routes[key];
    if (!result) throw new Error(`unexpected request ${key}`);
    return typeof result === "function" ? result({ url, init, calls }) : result;
  };
  return { calls, fetchImpl };
}

test("creates a missing owned candidate prerelease", async () => {
  const routes = recordingFetch({
    "GET /repos/jamezrin/lurkloot/git/ref/tags/candidate-v1.6.0": response(404, { message: "Not Found" }),
    "GET /repos/jamezrin/lurkloot/releases/tags/candidate-v1.6.0": response(404, { message: "Not Found" }),
    "POST /repos/jamezrin/lurkloot/git/refs": response(201, {}),
    "POST /repos/jamezrin/lurkloot/releases": response(201, {
      id: 12,
      upload_url: "https://uploads.github.com/repos/jamezrin/lurkloot/releases/12/assets{?name,label}",
      assets: [],
    }),
    "POST /repos/jamezrin/lurkloot/releases/12/assets": response(201, {}),
  });
  const client = new GitHubClient({ repository: "jamezrin/lurkloot", token: "token", fetchImpl: routes.fetchImpl });
  await reconcilePrerelease({
    client,
    pr: 132,
    version: "1.6.0",
    sha: "abc123",
    notes: "## New\n- Candidate",
    assets: [{ name: "lurkloot.zip", bytes: Buffer.from("zip") }],
  });
  assert.deepEqual(routes.calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /repos/jamezrin/lurkloot/git/ref/tags/candidate-v1.6.0",
    "GET /repos/jamezrin/lurkloot/releases/tags/candidate-v1.6.0",
    "POST /repos/jamezrin/lurkloot/git/refs",
    "POST /repos/jamezrin/lurkloot/releases",
    "POST /repos/jamezrin/lurkloot/releases/12/assets",
  ]);
});

test("moves only an owned prerelease candidate", async () => {
  const marker = candidateMarker({ pr: 132, version: "1.6.0", head: "release/1.6.0" });
  const routes = recordingFetch({
    "GET /repos/jamezrin/lurkloot/git/ref/tags/candidate-v1.6.0": response(200, { object: { sha: "old" } }),
    "GET /repos/jamezrin/lurkloot/releases/tags/candidate-v1.6.0": response(200, {
      id: 12,
      prerelease: true,
      body: marker,
      upload_url: "https://uploads.github.com/repos/jamezrin/lurkloot/releases/12/assets{?name,label}",
      assets: [],
    }),
    "PATCH /repos/jamezrin/lurkloot/git/refs/tags/candidate-v1.6.0": response(200, {}),
    "PATCH /repos/jamezrin/lurkloot/releases/12": response(200, {
      id: 12,
      upload_url: "https://uploads.github.com/repos/jamezrin/lurkloot/releases/12/assets{?name,label}",
      assets: [],
    }),
  });
  const client = new GitHubClient({ repository: "jamezrin/lurkloot", token: "token", fetchImpl: routes.fetchImpl });
  await reconcilePrerelease({ client, pr: 132, version: "1.6.0", sha: "new", notes: "notes", assets: [] });
  assert.equal(routes.calls.some(({ path }) => path.endsWith("candidate-v1.6.0")), true);
});

test("refuses stable or foreign candidate releases", async () => {
  for (const release of [
    { id: 12, prerelease: false, body: "" },
    { id: 12, prerelease: true, body: candidateMarker({ pr: 999, version: "1.6.0", head: "release/1.6.0" }) },
  ]) {
    const routes = recordingFetch({
      "GET /repos/jamezrin/lurkloot/git/ref/tags/candidate-v1.6.0": response(200, { object: { sha: "old" } }),
      "GET /repos/jamezrin/lurkloot/releases/tags/candidate-v1.6.0": response(200, release),
    });
    const client = new GitHubClient({ repository: "jamezrin/lurkloot", token: "token", fetchImpl: routes.fetchImpl });
    await assert.rejects(
      reconcilePrerelease({ client, pr: 132, version: "1.6.0", sha: "new", notes: "", assets: [] }),
      /refusing to modify/,
    );
  }
});

test("updates one sticky release status comment", async () => {
  const routes = recordingFetch({
    "GET /repos/jamezrin/lurkloot/issues/132/comments": response(200, [{ id: 7, body: "<!-- lurkloot-release-status -->\nold" }]),
    "PATCH /repos/jamezrin/lurkloot/issues/comments/7": response(200, {}),
  });
  const client = new GitHubClient({ repository: "jamezrin/lurkloot", token: "token", fetchImpl: routes.fetchImpl });
  await upsertComment({ client, pr: 132, body: "ready" });
  assert.equal(routes.calls.at(-1).method, "PATCH");
});

test("retires only the matching owned prerelease", async () => {
  const marker = candidateMarker({ pr: 132, version: "1.6.0", head: "release/1.6.0" });
  const routes = recordingFetch({
    "GET /repos/jamezrin/lurkloot/releases/tags/candidate-v1.6.0": response(200, { id: 12, prerelease: true, body: marker }),
    "DELETE /repos/jamezrin/lurkloot/releases/12": response(204),
    "DELETE /repos/jamezrin/lurkloot/git/refs/tags/candidate-v1.6.0": response(204),
  });
  const client = new GitHubClient({ repository: "jamezrin/lurkloot", token: "token", fetchImpl: routes.fetchImpl });
  await retirePrerelease({ client, pr: 132, version: "1.6.0" });
  assert.deepEqual(routes.calls.slice(-2).map(({ method, path }) => `${method} ${path}`), [
    "DELETE /repos/jamezrin/lurkloot/git/refs/tags/candidate-v1.6.0",
    "DELETE /repos/jamezrin/lurkloot/releases/12",
  ]);
});
