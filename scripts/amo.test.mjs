import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  AddonsClient,
  addonsToken,
  plainReleaseNotes,
  publishVersion,
  uploadState,
  validationErrors,
  versionAction,
} from "./amo.mjs";

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

test("signs a short-lived HS256 token AMO accepts", () => {
  const token = addonsToken({
    issuer: "user:1:2",
    secret: "s3cret",
    now: 1_700_000_000_000,
    nonce: "n-1",
  });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(decode(payload), {
    iss: "user:1:2",
    jti: "n-1",
    iat: 1_700_000_000,
    exp: 1_700_000_060,
  });
  assert.equal(
    signature,
    createHmac("sha256", "s3cret").update(`${header}.${payload}`).digest("base64url"),
  );
  assert.ok(decode(payload).exp - decode(payload).iat <= 300, "AMO rejects tokens over 5 minutes");
});

test("uploads a new version and leaves a listed one alone", () => {
  assert.equal(versionAction(null), "upload");
  assert.equal(versionAction({ version: "1.2.0", channel: "listed" }), "already-submitted");
});

test("refuses a version number already taken by an unlisted upload", () => {
  assert.throws(
    () => versionAction({ version: "1.2.0", channel: "unlisted" }),
    /already exists on the unlisted channel/,
  );
});

test("reports validator errors with their location", () => {
  const validation = {
    messages: [
      { type: "warning", message: "Unsafe assignment" },
      { type: "error", message: "Bad manifest", file: "manifest.json" },
      { type: "error", message: "Broken script", file: "background.js", line: 4 },
    ],
  };
  assert.deepEqual(validationErrors(validation), [
    "Bad manifest (manifest.json)",
    "Broken script (background.js:4)",
  ]);
  assert.deepEqual(validationErrors(undefined), []);
});

test("waits for processing and fails an invalid upload", () => {
  assert.equal(uploadState({ processed: false }), "processing");
  assert.equal(uploadState({ processed: true, valid: true }), "valid");
  assert.throws(
    () =>
      uploadState({
        processed: true,
        valid: false,
        validation: { messages: [{ type: "error", message: "Bad manifest" }] },
      }),
    /rejected the upload: Bad manifest/,
  );
});

test("turns changelog Markdown headings into plain lines", () => {
  assert.equal(
    plainReleaseNotes("## New\n- One\n\n## Fixed\n- Two\n"),
    "New\n- One\n\nFixed\n- Two",
  );
});

// A fake AMO: records every request and answers from a route table.
function fakeAmo(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, pathname, init });
    const handler = routes[`${method} ${pathname}`];
    if (!handler) return new Response(JSON.stringify({ detail: "Not found." }), { status: 404 });
    const [status, body] = handler(init, calls);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  const client = new AddonsClient({
    issuer: "user:1:2",
    secret: "s3cret",
    addonId: "lurkloot@jamezrin.name",
    fetchImpl,
  });
  return { client, calls };
}

const addon = "/api/v5/addons/addon/lurkloot%40jamezrin.name";
const publishArgs = (client) => ({
  client,
  version: "1.25.0",
  packageBytes: Buffer.from("pkg"),
  packageName: "lurkloot-1.25.0-firefox.zip",
  sourceBytes: Buffer.from("src"),
  sourceName: "lurkloot-1.25.0-firefox-sources.zip",
  approvalNotes: "notes for reviewers",
  releaseNotes: "New\n- One",
  delay: async () => undefined,
});

test("publishes a new version with its source, notes and desktop compatibility", async () => {
  let polls = 0;
  const { client, calls } = fakeAmo({
    [`GET ${addon}/`]: () => [200, { id: 7 }],
    "POST /api/v5/addons/upload/": () => [201, { uuid: "u-1", processed: false }],
    "GET /api/v5/addons/upload/u-1/": () => {
      polls += 1;
      return [200, { uuid: "u-1", processed: polls > 1, valid: true, version: "1.25.0" }];
    },
    [`POST ${addon}/versions/`]: () => [201, { id: 99, file: { status: "unreviewed" } }],
    [`PATCH ${addon}/versions/99/`]: () => [200, { id: 99 }],
  });

  assert.deepEqual(await publishVersion(publishArgs(client)), {
    action: "submitted",
    status: "unreviewed",
  });

  for (const call of calls)
    assert.match(call.init.headers.authorization, /^JWT [^.]+\.[^.]+\.[^.]+$/);
  const upload = calls.find((call) => call.pathname === "/api/v5/addons/upload/");
  assert.equal(upload.init.body.get("channel"), "listed");
  assert.equal(upload.init.body.get("upload").name, "lurkloot-1.25.0-firefox.zip");
  const created = calls.find(
    (call) => call.method === "POST" && call.pathname === `${addon}/versions/`,
  );
  assert.equal(created.init.body.get("upload"), "u-1");
  assert.equal(created.init.body.get("source").name, "lurkloot-1.25.0-firefox-sources.zip");
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(JSON.parse(patch.init.body), {
    approval_notes: "notes for reviewers",
    release_notes: { "en-US": "New\n- One" },
    compatibility: ["firefox"],
  });
});

test("a rerun leaves an existing version in place and only refreshes its notes", async () => {
  const { client, calls } = fakeAmo({
    [`GET ${addon}/`]: () => [200, { id: 7 }],
    [`GET ${addon}/versions/v1.25.0/`]: () => [
      200,
      { id: 99, version: "1.25.0", channel: "listed", file: { status: "public" } },
    ],
    [`PATCH ${addon}/versions/99/`]: () => [200, { id: 99 }],
  });

  assert.deepEqual(await publishVersion(publishArgs(client)), {
    action: "already-submitted",
    status: "public",
  });
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
    "nothing is uploaded again",
  );
});

test("asks for the first manual submission when the listing does not exist", async () => {
  const { client } = fakeAmo({});
  await assert.rejects(publishVersion(publishArgs(client)), /Submit the first version by hand/);
});

test("refuses a package whose manifest carries another version", async () => {
  const { client, calls } = fakeAmo({
    [`GET ${addon}/`]: () => [200, { id: 7 }],
    "POST /api/v5/addons/upload/": () => [
      201,
      { uuid: "u-1", processed: true, valid: true, version: "1.24.0" },
    ],
  });
  await assert.rejects(publishVersion(publishArgs(client)), /read version 1.24.0/);
  assert.equal(
    calls.some((call) => call.pathname === `${addon}/versions/` && call.method === "POST"),
    false,
  );
});

test("stops on a rejected upload before creating a version", async () => {
  const { client, calls } = fakeAmo({
    [`GET ${addon}/`]: () => [200, { id: 7 }],
    "POST /api/v5/addons/upload/": () => [
      201,
      {
        uuid: "u-1",
        processed: true,
        valid: false,
        validation: { messages: [{ type: "error", message: "Bad manifest" }] },
      },
    ],
  });
  await assert.rejects(publishVersion(publishArgs(client)), /Bad manifest/);
  assert.equal(
    calls.some((call) => call.pathname === `${addon}/versions/` && call.method === "POST"),
    false,
  );
});
