import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "./github-api.mjs";

const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] ?? null });
const ok = (body, headerMap) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: headers(headerMap) });
const fail = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body), headers: headers() });

const client = (fetchImpl) => new GitHubClient({ token: "t", repo: "owner/repo", fetchImpl });

test("requires a token and a repository", () => {
  assert.throws(() => new GitHubClient({ repo: "owner/repo" }), /token is required/);
  assert.throws(() => new GitHubClient({ token: "t" }), /repository is required/);
});

test("API failures surface as errors carrying the status and message", async () => {
  const api = client(async () => fail(503, { message: "Service Unavailable" }));
  await assert.rejects(api.pullRequest(120), /failed \(503\): Service Unavailable/);
});

test("a non-JSON error body is reported verbatim rather than masked", async () => {
  const api = client(async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>", headers: headers() }));
  await assert.rejects(api.pullRequest(120), /failed \(502\): <html>bad gateway<\/html>/);
});

test("pagination follows link headers and concatenates every page", async () => {
  const pages = [
    ok([{ id: 1 }], { link: '<https://api.github.com/x?page=2>; rel="next"' }),
    ok([{ id: 2 }], {}),
  ];
  let call = 0;
  const api = client(async () => pages[call++]);
  assert.deepEqual(await api.issueComments(120), [{ id: 1 }, { id: 2 }]);
  assert.equal(call, 2);
});

test("a failure mid-pagination throws instead of returning a short list", async () => {
  let call = 0;
  const api = client(async () => {
    call += 1;
    return call === 1 ? ok([{ id: 1 }], { link: '<https://api.github.com/x?page=2>; rel="next"' }) : fail(503, { message: "nope" });
  });
  await assert.rejects(api.issueComments(120), /failed \(503\)/);
});

test("a paginated endpoint returning a non-list is rejected", async () => {
  const api = client(async () => ok({ message: "unexpected" }));
  await assert.rejects(api.issueComments(120), /did not return a list/);
});

test("refSha rejects anything that is not a commit SHA", async () => {
  await assert.rejects(client(async () => ok({ object: { sha: "abc" } })).refSha("main"), /did not resolve/);
  assert.equal(await client(async () => ok({ object: { sha: "a".repeat(40) } })).refSha("main"), "a".repeat(40));
});

test("fileAtRef decodes base64 content", async () => {
  const content = Buffer.from('{"version":"1.4.0"}').toString("base64");
  const api = client(async () => ok({ encoding: "base64", content }));
  assert.equal(await api.fileAtRef("package.json", "a".repeat(40)), '{"version":"1.4.0"}');
});

test("fileAtRef rejects unexpected encodings rather than guessing", async () => {
  const api = client(async () => ok({ encoding: "none", content: "" }));
  await assert.rejects(api.fileAtRef("package.json", "a".repeat(40)), /base64 content/);
});

test("compare paginates commits and reports ancestry status", async () => {
  const pages = [
    ok({ status: "ahead", total_commits: 2, commits: [{ sha: "a" }], files: [{ filename: "package.json" }] }),
    ok({ status: "ahead", total_commits: 2, commits: [{ sha: "b" }], files: [{ filename: "README.md" }] }),
  ];
  let call = 0;
  const api = client(async () => pages[call++]);
  assert.deepEqual(await api.compare("base", "head"), {
    status: "ahead",
    commits: ["a", "b"],
    files: ["package.json", "README.md"],
  });
});

// A rename hides a source change behind a metadata-looking destination path unless both sides of
// the rename are reported.
test("compare reports both sides of a rename", async () => {
  const api = client(async () => ok({
    status: "ahead",
    total_commits: 1,
    commits: [{ sha: "a" }],
    files: [{ filename: "package.json", previous_filename: "packages/core/src/scheduler.ts" }],
  }));
  assert.deepEqual((await api.compare("base", "head")).files, ["package.json", "packages/core/src/scheduler.ts"]);
});

// A truncated compare would hide a leaked develop commit from the hotfix check.
test("a truncated compare throws instead of under-reporting commits", async () => {
  const api = client(async () => ok({ status: "ahead", total_commits: 400, commits: [] }));
  await assert.rejects(api.compare("base", "head"), /returned 0 of 400 commits/);
});

test("isAncestor maps compare status to merge-base semantics", async () => {
  const withStatus = (status) => client(async () => ok({ status, total_commits: 0, commits: [] }));
  assert.equal(await withStatus("identical").isAncestor("a", "b"), true);
  assert.equal(await withStatus("ahead").isAncestor("a", "b"), true);
  assert.equal(await withStatus("behind").isAncestor("a", "b"), false);
  assert.equal(await withStatus("diverged").isAncestor("a", "b"), false);
});

test("releaseAsset returns raw text for validated parsing", async () => {
  const api = client(async () => ({ ok: true, status: 200, text: async () => '{"schemaVersion":2}', headers: headers() }));
  assert.equal(await api.releaseAsset("https://api.github.com/asset/1"), '{"schemaVersion":2}');
});

test("collaboratorPermission defaults to none when absent", async () => {
  assert.equal(await client(async () => ok({})).collaboratorPermission("someone"), "none");
  assert.equal(await client(async () => ok({ permission: "admin" })).collaboratorPermission("someone"), "admin");
});
