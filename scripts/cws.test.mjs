import assert from "node:assert/strict";
import test from "node:test";
import { prereleaseAction, revisionVersion, stableAction } from "./cws.mjs";

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

test("pre-release uploads replace an unsubmitted draft", () => {
  assert.equal(prereleaseAction(status(), "1.4.0"), "upload");
});

test("pre-release upload freezes during review and staging", () => {
  assert.equal(prereleaseAction(status({ submitted: revision("PENDING_REVIEW", "1.4.0") }), "1.4.0"), "frozen");
  assert.equal(prereleaseAction(status({ submitted: revision("STAGED", "1.4.0") }), "1.4.0"), "frozen");
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
