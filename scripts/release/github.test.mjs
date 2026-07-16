import assert from "node:assert/strict";
import test from "node:test";
import { checkConclusion, commentMarker, renderReleaseComment, shouldComment } from "./github.mjs";

const metadata = { version: "1.5.0", initiator: "jamezrin", sourceSha: "a".repeat(40) };

test("maps CWS states to required-check outcomes", () => {
  assert.deepEqual(checkConclusion("PENDING_REVIEW"), { status: "in_progress" });
  assert.deepEqual(checkConclusion("STAGED"), { status: "completed", conclusion: "success" });
  assert.deepEqual(checkConclusion("REJECTED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("CANCELLED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("PUBLISHED", { recovery: true }), { status: "completed", conclusion: "success" });
  assert.deepEqual(checkConclusion("PUBLISHED"), { status: "completed", conclusion: "failure" });
});

test("renders tagged transition comments with stable markers", () => {
  const comment = renderReleaseComment({ metadata, state: "STAGED" });
  assert.match(comment, /@jamezrin/);
  assert.match(comment, /1\.5\.0/);
  assert.match(comment, /ready for final approval/i);
  assert.match(comment, new RegExp(commentMarker("1.5.0", "STAGED").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("deduplicates unchanged transition comments", () => {
  const marker = commentMarker("1.5.0", "PENDING_REVIEW");
  assert.equal(shouldComment([`existing\n${marker}`], "1.5.0", "PENDING_REVIEW"), false);
  assert.equal(shouldComment([`existing\n${marker}`], "1.5.0", "STAGED"), true);
});

test("rejects unsafe mention logins", () => {
  assert.throws(() => renderReleaseComment({ metadata: { ...metadata, initiator: "user @all" }, state: "STAGED" }), /login/);
});
