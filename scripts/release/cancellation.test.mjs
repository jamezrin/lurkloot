import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCancelPullRequestState,
  assertCancelledTerminal,
  assertNotPublished,
  cancellationOutcome,
  parseCancellationInputs,
  selectRetirableContainerVersion,
} from "./cancellation.mjs";

const sha = (char) => char.repeat(40);
const revision = (state, version) => ({ state, distributionChannels: [{ deployPercentage: 100, crxVersion: version }] });
const status = ({ published, submitted } = {}) => ({
  publishedItemRevisionStatus: published ? revision("PUBLISHED", published) : undefined,
  submittedItemRevisionStatus: submitted,
  warned: false,
  takenDown: false,
});

const inputs = {
  version: "1.5.0",
  expectedSha: sha("a"),
  expectedLiveHeadSha: sha("b"),
  desiredLabels: '["release/minor"]',
  expectedPrState: "open",
  disposition: "retire",
};

test("cancellation inputs are validated before any mutation", () => {
  assert.equal(parseCancellationInputs(inputs).version, "1.5.0");
  assert.throws(() => parseCancellationInputs({ ...inputs, version: "1.5" }), /stable semantic version/);
  assert.throws(() => parseCancellationInputs({ ...inputs, expectedSha: "abc" }), /expected candidate SHA/);
  assert.throws(() => parseCancellationInputs({ ...inputs, expectedLiveHeadSha: "abc" }), /expected live head SHA/);
  assert.throws(() => parseCancellationInputs({ ...inputs, expectedPrState: "merged" }), /open or closed-unmerged/);
  assert.throws(() => parseCancellationInputs({ ...inputs, disposition: "delete" }), /retire or replace/);
});

test("unsorted desired labels are rejected as controller disagreement", () => {
  assert.throws(
    () => parseCancellationInputs({ ...inputs, desiredLabels: '["release/minor","release/hotfix"]' }),
    /must be sorted/,
  );
  assert.deepEqual(parseCancellationInputs({ ...inputs, desiredLabels: '["release/hotfix","release/minor"]' }).labels,
    ["release/hotfix", "release/minor"]);
});

test("a published candidate can never be cancelled", () => {
  assert.throws(() => assertNotPublished(status({ published: "1.5.0" }), "1.5.0"), /PUBLISHED candidates cannot be cancelled/);
  assert.ok(assertNotPublished(status({ published: "1.4.0" }), "1.5.0"));
});

test("cancellation must land on a confirmed terminal state", () => {
  assert.equal(assertCancelledTerminal(status(), "1.5.0"), "cancelled");
  assert.equal(assertCancelledTerminal(status({ submitted: revision("CANCELLED", "1.5.0") }), "1.5.0"), "cancelled");
  assert.throws(() => assertCancelledTerminal(status({ submitted: revision("PENDING_REVIEW", "1.5.0") }), "1.5.0"), /terminal state/);
  assert.throws(() => assertCancelledTerminal(status({ submitted: revision("CANCELLED", "1.6.0") }), "1.5.0"), /terminal state/);
});

test("a drifted pull request stops cancellation", () => {
  const expected = { expectedLiveHeadSha: sha("b"), expectedPrState: "open", labels: ["release/minor"] };
  const live = (overrides = {}) => ({
    head: { sha: sha("b") },
    state: "open",
    merged_at: null,
    labels: [{ name: "release/minor" }],
    ...overrides,
  });
  assert.deepEqual(assertCancelPullRequestState(live(), expected), ["release/minor"]);
  assert.throws(() => assertCancelPullRequestState(live({ head: { sha: sha("f") } }), expected), /head changed/);
  assert.throws(() => assertCancelPullRequestState(live({ state: "closed" }), expected), /does not match expected open/);
  assert.throws(() => assertCancelPullRequestState(live({ labels: [{ name: "release/major" }] }), expected), /labels changed/);
});

test("a merged pull request never has its candidate cancelled", () => {
  assert.throws(
    () => assertCancelPullRequestState(
      { head: { sha: sha("b") }, state: "closed", merged_at: "2026-07-17T00:00:00Z", labels: [] },
      { expectedLiveHeadSha: sha("b"), expectedPrState: "closed-unmerged", labels: [] },
    ),
    /merged pull requests cannot have candidates cancelled/,
  );
});

test("closed-unmerged expects a closed pull request", () => {
  const expected = { expectedLiveHeadSha: sha("b"), expectedPrState: "closed-unmerged", labels: [] };
  const closed = { head: { sha: sha("b") }, state: "closed", merged_at: null, labels: [] };
  assert.deepEqual(assertCancelPullRequestState(closed, expected), []);
  assert.throws(() => assertCancelPullRequestState({ ...closed, state: "open" }, expected), /does not match expected closed-unmerged/);
});

test("outcome reports safe replacement only on success", () => {
  const ok = cancellationOutcome(true, "1.5.0");
  assert.equal(ok.cancelled, true);
  assert.equal(ok.safeToReplace, true);
  assert.equal(ok.reason, "confirmed-cancelled");
  assert.equal(ok.conclusion, "success");

  const bad = cancellationOutcome(false, "1.5.0");
  assert.equal(bad.cancelled, false);
  assert.equal(bad.safeToReplace, false);
  assert.equal(bad.reason, "reconciliation-blocked");
  assert.equal(bad.conclusion, "failure");
});

test("only a container version exclusively tagged for this candidate is retirable", () => {
  const versions = [
    { id: 1, metadata: { container: { tags: ["1.5.0", "next"] } } },
    { id: 2, metadata: { container: { tags: ["1.4.0", "latest"] } } },
  ];
  assert.equal(selectRetirableContainerVersion(versions, "1.5.0"), 1);
  assert.equal(selectRetirableContainerVersion(versions, "1.4.0"), null, "a shared 'latest' tag must not be deleted");
  assert.equal(selectRetirableContainerVersion(versions, "9.9.9"), null);
});

test("an ambiguous container match deletes nothing", () => {
  const versions = [
    { id: 1, metadata: { container: { tags: ["1.5.0"] } } },
    { id: 2, metadata: { container: { tags: ["1.5.0", "next"] } } },
  ];
  assert.equal(selectRetirableContainerVersion(versions, "1.5.0"), null);
});
