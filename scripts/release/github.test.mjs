import assert from "node:assert/strict";
import test from "node:test";
import {
  checkConclusion,
  checkTitle,
  commentMarker,
  renderReleaseComment,
  renderReleaseNotes,
  renderStepSummary,
  shouldComment,
  stateGuidance,
} from "./github.mjs";

const metadata = { version: "1.5.0", initiator: "jamezrin", sourceSha: "a".repeat(40), releasePr: 42 };
const context = { version: "1.5.0", pr: 42, sourceSha: metadata.sourceSha, submittedVersion: "1.6.0" };

test("maps CWS states to required-check outcomes", () => {
  assert.deepEqual(checkConclusion("PENDING_REVIEW"), { status: "in_progress" });
  assert.deepEqual(checkConclusion("STAGED"), { status: "completed", conclusion: "success" });
  assert.deepEqual(checkConclusion("REJECTED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("CANCELLED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("POLICY_BLOCKED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("VERSION_MISMATCH"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("CANDIDATE_CHANGED"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("none"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(checkConclusion("PUBLISHED", { recovery: true }), { status: "completed", conclusion: "success" });
  assert.deepEqual(checkConclusion("PUBLISHED"), { status: "completed", conclusion: "failure" });
});

test("titles the check run by state", () => {
  assert.equal(checkTitle("STAGED"), "CWS candidate staged");
  assert.equal(checkTitle("PENDING_REVIEW"), "CWS review pending");
  assert.equal(checkTitle("PUBLISHED", { recovery: true }), "CWS candidate already published");
  assert.equal(checkTitle("PUBLISHED"), "CWS candidate blocked");
  for (const state of ["REJECTED", "CANCELLED", "POLICY_BLOCKED", "VERSION_MISMATCH", "CANDIDATE_CHANGED", "none"]) {
    assert.equal(checkTitle(state), "CWS candidate blocked");
  }
});

test("gives every state its own operator guidance", () => {
  assert.equal(stateGuidance("STAGED", context), "v1.5.0 is approved and ready for final PR approval and merge.");
  assert.equal(stateGuidance("PENDING_REVIEW", context), "v1.5.0 remains frozen while Google reviews it.");
  assert.equal(
    stateGuidance("PUBLISHED", { ...context, recovery: true }),
    "v1.5.0 matches an explicitly requested partial-publication recovery. Rerun stable promotion for the merged PR.",
  );
  assert.equal(
    stateGuidance("REJECTED", context),
    "v1.5.0 was rejected. Correct the issues in the CWS dashboard, cancel or abandon this candidate, then prepare and submit a replacement.",
  );
  assert.equal(
    stateGuidance("CANCELLED", context),
    "v1.5.0 is cancelled. Return the PR to draft and run Prepare prerelease again, or abandon it before choosing a higher version.",
  );
  assert.equal(
    stateGuidance("POLICY_BLOCKED", context),
    "CWS reports a warning or takedown. Resolve the policy action in the dashboard before any release operation.",
  );
  assert.equal(
    stateGuidance("VERSION_MISMATCH", context),
    "CWS reports version 1.6.0 instead of v1.5.0. Stop and reconcile the active CWS submission before retrying.",
  );
  assert.equal(
    stateGuidance("CANDIDATE_CHANGED", context),
    `Release PR #42 no longer matches frozen source ${metadata.sourceSha}. Cancel CWS review, restore or replace the candidate through Prepare prerelease, and do not merge this head.`,
  );
  assert.equal(
    stateGuidance("none", context),
    "CWS has no submitted v1.5.0 revision. Run Submit candidate again against the frozen GitHub prerelease.",
  );
});

test("falls back to dashboard guidance for an unmodelled state", () => {
  assert.equal(
    stateGuidance("DRAFT", context),
    "v1.5.0 reported DRAFT. Inspect the CWS dashboard and use Cancel candidate before replacing or abandoning it.",
  );
  assert.equal(
    stateGuidance("PUBLISHED", context),
    "v1.5.0 reported PUBLISHED. Inspect the CWS dashboard and use Cancel candidate before replacing or abandoning it.",
  );
});

test("renders tagged transition comments with stable markers", () => {
  const summary = stateGuidance("STAGED", context);
  const comment = renderReleaseComment({ metadata, state: "STAGED", summary });
  assert.equal(comment, [
    "<!-- lurkloot-release:1.5.0:cws:STAGED -->",
    "@jamezrin, candidate **v1.5.0** is now **STAGED**. v1.5.0 is approved and ready for final PR approval and merge.",
  ].join("\n"));
  assert.match(comment, new RegExp(commentMarker("1.5.0", "STAGED").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("never indents the mention line into a code block", () => {
  for (const line of renderReleaseComment({ metadata, state: "STAGED", summary: "ok." }).split("\n")) {
    assert.doesNotMatch(line, /^\s+/);
  }
});

test("deduplicates unchanged transition comments", () => {
  const marker = commentMarker("1.5.0", "PENDING_REVIEW");
  assert.equal(shouldComment([`existing\n${marker}`], "1.5.0", "PENDING_REVIEW"), false);
  assert.equal(shouldComment([`existing\n${marker}`], "1.5.0", "STAGED"), true);
  assert.equal(shouldComment([], "1.5.0", "STAGED"), true);
});

test("rejects unsafe mention logins", () => {
  assert.throws(
    () => renderReleaseComment({ metadata: { ...metadata, initiator: "user @all" }, state: "STAGED", summary: "ok." }),
    /login/,
  );
  assert.throws(() => renderReleaseComment({ metadata: { ...metadata, initiator: undefined }, state: "STAGED", summary: "ok." }), /login/);
});

test("release notes record the frozen candidate and its guidance", () => {
  assert.equal(
    renderReleaseNotes({ version: "1.5.0", pr: 42, state: "STAGED", summary: "ok." }),
    "Candidate for release PR #42. Chrome Web Store version 1.5.0 last reported STAGED. Source, tag, and downloadable assets remain frozen. ok.",
  );
});

test("step summary reports a pending check when there is no conclusion", () => {
  assert.equal(
    renderStepSummary({ version: "1.5.0", pr: 42, state: "PENDING_REVIEW", conclusion: "", summary: "ok." }),
    "## CWS status for v1.5.0\n\n- PR: #42\n- State: `PENDING_REVIEW`\n- Check: `pending`\n- Guidance: ok.\n",
  );
  assert.match(renderStepSummary({ version: "1.5.0", pr: 42, state: "STAGED", conclusion: "success", summary: "ok." }), /- Check: `success`/);
});
