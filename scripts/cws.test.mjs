import assert from "node:assert/strict";
import test from "node:test";
import { cancelAction, ChromeWebStoreClient, normalizeStatus, prereleaseAction, publishAction, revisionVersion, stableAction, submitAction, submittedAction, waitForCancellation } from "./cws.mjs";

const revision = (state, version) => ({ state, distributionChannels: [{ deployPercentage: 100, crxVersion: version }] });
const status = ({ published = "1.3.0", submitted, warned = false, takenDown = false } = {}) => ({
  publishedItemRevisionStatus: published ? revision("PUBLISHED", published) : undefined,
  submittedItemRevisionStatus: submitted,
  warned,
  takenDown,
});

test("revisionVersion reads the submitted package version", () => {
  assert.equal(revisionVersion(revision("STAGED", "1.4.0")), "1.4.0");
});

test("reports a completed submission separately from staged retry state", () => {
  assert.equal(submittedAction("submit"), "submitted");
  assert.equal(submittedAction("already-staged"), "already-staged");
  assert.equal(submittedAction("already-submitted"), "already-submitted");
});

test("normalizes store status for workflow decisions", () => {
  assert.deepEqual(normalizeStatus(status({ submitted: revision("PENDING_REVIEW", "1.5.0"), published: "1.4.0", warned: true })), {
    publishedVersion: "1.4.0",
    submittedVersion: "1.5.0",
    submittedState: "PENDING_REVIEW",
    warned: true,
    takenDown: false,
  });
});

test("pre-release uploads replace an unsubmitted draft", () => {
  assert.equal(prereleaseAction(status(), "1.4.0"), "upload");
});

test("pre-release upload freezes during review and staging", () => {
  assert.equal(prereleaseAction(status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), "1.4.0"), "frozen");
  assert.equal(prereleaseAction(status({ submitted: revision("STAGED", "1.4.0") }), "1.4.0"), "frozen");
});

test("pre-release upload resumes after cancellation", () => {
  assert.equal(prereleaseAction(status({ submitted: revision("CANCELLED", "1.4.0") }), "1.4.0"), "upload");
  assert.equal(prereleaseAction(status({ submitted: revision("CANCELLED", "1.4.0") }), "1.5.0"), "upload");
});

test("pre-release rejects conflicting or unhealthy store state", () => {
  assert.throws(() => prereleaseAction(status({ submitted: revision("STAGED", "1.3.1") }), "1.4.0"), /expected 1.4.0/);
  assert.throws(() => prereleaseAction(status({ submitted: revision("REJECTED", "1.4.0") }), "1.4.0"), /REJECTED/);
  assert.throws(() => prereleaseAction(status({ warned: true }), "1.4.0"), /policy warning/);
  assert.throws(() => prereleaseAction(status({ takenDown: true }), "1.4.0"), /taken down/);
});

test("stable promotion publishes only a matching staged revision", () => {
  assert.equal(stableAction(status({ submitted: revision("STAGED", "1.4.0") }), "1.4.0"), "publish");
  assert.throws(() => stableAction(status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), "1.4.0"), /expected STAGED/);
  assert.throws(() => stableAction(status({ submitted: revision("STAGED", "1.5.0") }), "1.4.0"), /expected 1.4.0/);
});

test("stable promotion is idempotent after CWS publication", () => {
  assert.equal(stableAction(status({ published: "1.4.0" }), "1.4.0"), "already-published");
});

test("submits only an unsubmitted matching draft", () => {
  assert.equal(submitAction(status(), "1.4.0"), "submit");
  assert.equal(submitAction(status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), "1.4.0"), "already-submitted");
  assert.equal(submitAction(status({ submitted: revision("STAGED", "1.4.0") }), "1.4.0"), "already-staged");
  assert.throws(() => submitAction(status({ submitted: revision("PENDING_REVIEW", "1.5.0") }), "1.4.0"), /expected 1.4.0/);
});

test("cancels only an active matching review", () => {
  assert.equal(cancelAction(status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), "1.4.0"), "cancel");
  assert.equal(cancelAction(status(), "1.4.0"), "already-cancelled");
  assert.equal(cancelAction(status({ submitted: revision("CANCELLED", "1.4.0") }), "1.4.0"), "already-cancelled");
  assert.equal(cancelAction(status({ submitted: revision("STAGED", "1.4.0") }), "1.4.0"), "cancel");
});

test("publishes immediately so approval goes live unattended", async () => {
  const requests = [];
  const client = new ChromeWebStoreClient({
    publisherId: "publisher",
    extensionId: "extension",
    accessToken: "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ state: "PENDING_REVIEW" }) };
    },
  });
  await client.publish();
  await client.cancelSubmission();
  assert.deepEqual(JSON.parse(requests[0].init.body), { publishType: "PUBLISH_IMMEDIATELY", blockOnWarnings: true });
  assert.match(requests[0].url, /:publish$/);
  assert.match(requests[1].url, /:cancelSubmission$/);
  assert.equal(requests[1].init.body, undefined);
  assert.deepEqual(requests[1].init.headers, { authorization: "Bearer token" });
});

test("reports plaintext API failures with their HTTP status", async () => {
  const client = new ChromeWebStoreClient({
    publisherId: "publisher",
    extensionId: "extension",
    accessToken: "token",
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => "upstream unavailable" }),
  });
  await assert.rejects(client.status(), /502.*upstream unavailable/);
});

test("accepts the empty cancellation response required by CWS v2", async () => {
  const client = new ChromeWebStoreClient({
    publisherId: "publisher",
    extensionId: "extension",
    accessToken: "token",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
  });
  assert.equal(await client.cancelSubmission(), undefined);
});

test("waits until CWS reports a cancelled submission", async () => {
  const states = [status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), status({ submitted: revision("CANCELLED", "1.4.0") })];
  const result = await waitForCancellation({ status: async () => states.shift() }, "1.4.0", { attempts: 2, delay: async () => {} });
  assert.equal(result, "cancelled");
});

test("rejects cancellation confirmation for another version", async () => {
  const client = { status: async () => status({ submitted: revision("CANCELLED", "1.5.0") }) };
  await assert.rejects(waitForCancellation(client, "1.4.0", { attempts: 1, delay: async () => {} }), /switched to 1\.5\.0/);
});

test("publishAction uploads, publishes, or skips based on live store state", () => {
  assert.equal(publishAction(status({ published: "1.4.0" }), "1.5.0"), "upload");
  assert.equal(publishAction(status({ published: "1.5.0" }), "1.5.0"), "already-published");
  assert.equal(publishAction(status({ published: "1.4.0", submitted: revision("PENDING_REVIEW", "1.5.0") }), "1.5.0"), "in-review");
  assert.equal(publishAction(status({ published: "1.4.0", submitted: revision("IN_REVIEW", "1.5.0") }), "1.5.0"), "in-review");
  assert.throws(() => publishAction(status({ warned: true }), "1.5.0"), /policy warning/);
});
