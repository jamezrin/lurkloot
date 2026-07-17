import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkConclusion,
  checkTitle,
  commentMarker,
  lifecycleMilestoneGuidance,
  milestoneMarker,
  renderMilestone,
  renderReleaseComment,
  renderReleaseNotes,
  renderReleaseStatus,
  renderStepSummary,
  shouldComment,
  stateGuidance,
  submitCandidateCheck,
} from "./github.mjs";

const metadata = { version: "1.5.0", initiator: "jamezrin", sourceSha: "a".repeat(40), releasePr: 42 };
const context = { version: "1.5.0", pr: 42, sourceSha: metadata.sourceSha, submittedVersion: "1.6.0" };

test("renders one sticky actionable status", () => {
  assert.equal(renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "normal", state: "awaiting-approval",
    sourceSha: "a".repeat(40), action: "Approve the prereleases environment for this SHA.",
    releaseUrl: "https://github.test/releases/v1.5.0", previewUrl: "https://next.test",
    cwsUrl: "https://cws.test", checksum: "b".repeat(64), dockerTag: "ghcr.io/test/lurkloot-cli:next",
  }), `<!-- lurkloot-release-pr:42:status -->
## Release status: awaiting approval

- Candidate: \`v1.5.0\` (normal)
- Source: \`${"a".repeat(40)}\`
- Chrome ZIP: \`${"b".repeat(64)}\`
- Docker: \`ghcr.io/test/lurkloot-cli:next\`
- Links: [GitHub release](https://github.test/releases/v1.5.0) · [Preview](https://next.test) · [CWS](https://cws.test)

**Next action:** Approve the prereleases environment for this SHA.`);
});

test("renders blocked and cancelled status snapshots without absent optional fields", () => {
  assert.equal(renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "hotfix", state: "blocked", sourceSha: "a".repeat(40),
    blocker: "CWS reports a policy warning.", recovery: "Resolve the warning in the CWS dashboard.",
  }), `<!-- lurkloot-release-pr:42:status -->
## Release status: blocked

- Candidate: \`v1.5.0\` (hotfix)
- Source: \`${"a".repeat(40)}\`

**Blocker:** CWS reports a policy warning.

**Recovery:** Resolve the warning in the CWS dashboard.`);
  assert.equal(renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "normal", state: "cancelled", sourceSha: "a".repeat(40),
    action: "Choose a new release label when ready.",
  }), `<!-- lurkloot-release-pr:42:status -->
## Release status: cancelled

- Candidate: \`v1.5.0\` (normal)
- Source: \`${"a".repeat(40)}\`

**Next action:** Choose a new release label when ready.`);
});

test("renders staged and stable milestone snapshots", () => {
  assert.equal(milestoneMarker("1.5.0", "cws-staged"), "<!-- lurkloot-release:1.5.0:milestone:cws-staged -->");
  assert.equal(renderMilestone({ metadata, milestone: "cws-staged", guidance: "The candidate is staged; merge PR #42 to promote it." }), [
    "<!-- lurkloot-release:1.5.0:milestone:cws-staged -->",
    "@jamezrin, candidate **v1.5.0** reached **cws-staged**. The candidate is staged; merge PR #42 to promote it.",
  ].join("\n"));
  assert.equal(renderMilestone({ metadata, milestone: "stable", guidance: "Stable promotion is complete." }), [
    "<!-- lurkloot-release:1.5.0:milestone:stable -->",
    "@jamezrin, candidate **v1.5.0** reached **stable**. Stable promotion is complete.",
  ].join("\n"));
});

test("renders automatic lifecycle milestone snapshots", () => {
  const guidance = {
    "candidate-rebuilding": "The old candidate is cancelled; replacement artifacts are rebuilding.",
    "environment-approval": "Approve the prereleases and prerelease-site environments after checking this exact SHA.",
    "cws-pending": "Google is reviewing the frozen candidate with deferred publishing.",
    "reconciliation-blocked": "CWS state is uncertain; reconcile it in the dashboard before retrying.",
  };
  for (const [milestone, text] of Object.entries(guidance)) {
    assert.equal(lifecycleMilestoneGuidance(milestone), text);
    assert.equal(renderMilestone({ metadata, milestone, guidance: text }), [
      `<!-- lurkloot-release:1.5.0:milestone:${milestone} -->`,
      `@jamezrin, candidate **v1.5.0** reached **${milestone}**. ${text}`,
    ].join("\n"));
  }
  assert.throws(() => lifecycleMilestoneGuidance("typo"), /unknown automatic lifecycle milestone/);
});

test("validates lifecycle notification links and mention logins", () => {
  assert.throws(() => renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "normal", state: "stable", sourceSha: "a".repeat(40),
    releaseUrl: "javascript:alert(1)",
  }), /URL/);
  assert.throws(() => renderMilestone({
    metadata: { ...metadata, initiator: "user @all" }, milestone: "stable", guidance: "Done.",
  }), /login/);
});

test("rejects Markdown-unsafe and non-HTTPS lifecycle notification links", () => {
  const status = {
    pr: 42, version: "1.5.0", kind: "normal", state: "stable", sourceSha: "a".repeat(40),
  };
  for (const releaseUrl of [
    "https://good.test/foo) [click me](https://evil.test",
    "https://good.test/path with space",
    "https://good.test/path\nnext",
    "http://good.test/release",
  ]) {
    assert.throws(() => renderReleaseStatus({ ...status, releaseUrl }), /URL/);
  }
});

test("preserves encoded Markdown delimiters in safe HTTPS lifecycle links", () => {
  assert.match(renderReleaseStatus({
    pr: 42, version: "1.5.0", kind: "normal", state: "stable", sourceSha: "a".repeat(40),
    releaseUrl: "https://good.test/foo%29%20%5Bclick%20me%5D%28safe%29",
  }), /\[GitHub release\]\(https:\/\/good\.test\/foo%29%20%5Bclick%20me%5D%28safe%29\)/);
});

test("CLI renders status JSON to the requested file", () => {
  const directory = mkdtempSync(join(tmpdir(), "lurkloot-status-"));
  try {
    const input = join(directory, "status.json");
    const output = join(directory, "status.md");
    writeFileSync(input, JSON.stringify({
      pr: 42, version: "1.5.0", kind: "normal", state: "stable", sourceSha: "a".repeat(40),
    }));
    const result = spawnSync(process.execPath, [new URL("./cli.mjs", import.meta.url).pathname, "render-status", "--input", input, "--output", output], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), `<!-- lurkloot-release-pr:42:status -->
## Release status: stable

- Candidate: \`v1.5.0\` (normal)
- Source: \`${"a".repeat(40)}\`
`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("submit candidate never completes the release-ready check", () => {
  assert.deepEqual(submitCandidateCheck("already-staged", "1.5.0"), {
    status: "in_progress",
    title: "CWS candidate staged; validation pending",
    summary: "v1.5.0 is staged in CWS and awaits monitor finalization and release metadata validation.",
  });
  assert.deepEqual(submitCandidateCheck("submitted", "1.5.0"), {
    status: "in_progress",
    title: "CWS review pending",
    summary: "v1.5.0 is frozen and submitted with staged publishing.",
  });
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
  assert.equal(
    stateGuidance("PENDING_REVIEW", context),
    "v1.5.0 remains frozen while Google reviews it. To replace or abandon it, convert PR #42 to draft or remove or change its release label so automation cancels and reconciles the candidate.",
  );
  assert.equal(
    stateGuidance("PUBLISHED", { ...context, recovery: true }),
    "v1.5.0 matches an explicitly requested partial-publication recovery. Rerun stable promotion for the merged PR.",
  );
  assert.equal(
    stateGuidance("REJECTED", context),
    "v1.5.0 was rejected. Automation has stopped; resolve the rejection in the CWS dashboard and have a repository administrator reconcile the candidate before changing the PR.",
  );
  assert.equal(
    stateGuidance("CANCELLED", context),
    "v1.5.0 is cancelled. Convert PR #42 to draft, then remove and reapply or change its release label to trigger automatic reconciliation.",
  );
  assert.equal(
    stateGuidance("POLICY_BLOCKED", context),
    "CWS reports a warning or takedown. Automation has stopped; resolve the policy action in the dashboard and have a repository administrator reconcile the candidate.",
  );
  assert.equal(
    stateGuidance("VERSION_MISMATCH", context),
    "CWS reports version 1.6.0 instead of v1.5.0. Automation has stopped; inspect the CWS dashboard and have a repository administrator reconcile the active submission.",
  );
  assert.equal(
    stateGuidance("CANDIDATE_CHANGED", context),
    `Release PR #42 no longer matches frozen source ${metadata.sourceSha}. Do not merge this head; convert the PR to draft or remove, reapply, or change its release label to trigger automatic reconciliation.`,
  );
  assert.equal(
    stateGuidance("none", context),
    "CWS has no submitted v1.5.0 revision. Convert PR #42 to draft, verify the frozen GitHub prerelease, then mark it ready to reconcile submission.",
  );
});

test("falls back to dashboard guidance for an unmodelled state", () => {
  assert.equal(
    stateGuidance("DRAFT", context),
    "v1.5.0 reported mutable state DRAFT. Convert PR #42 to draft or remove, reapply, or change its release label to trigger automatic reconciliation.",
  );
  assert.equal(
    stateGuidance("PUBLISHED", context),
    "v1.5.0 reported unexpected state PUBLISHED. Automation has stopped; inspect the CWS dashboard and have a repository administrator reconcile the candidate.",
  );
});

test("never recommends retired manual candidate workflows", () => {
  for (const state of ["PENDING_REVIEW", "REJECTED", "CANCELLED", "POLICY_BLOCKED", "VERSION_MISMATCH", "CANDIDATE_CHANGED", "none", "DRAFT", "PUBLISHED"]) {
    assert.doesNotMatch(stateGuidance(state, context), /(?:run|use|through) (?:Prepare|Submit|Cancel)|Cancel candidate/i);
  }
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
