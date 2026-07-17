import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationMatchesEvent,
  authorizationMatchesSnapshot,
  buildAuthorizationRecord,
  decodeAuthorization,
  deriveLabelEventAuthorization,
  encodeAuthorization,
  findAuthorizationComment,
  latestReleaseLabelEvent,
  recognizedReleaseLabels,
} from "./authorization.mjs";

const labelEvent = (id, action, label, actor = "admin-user") => ({ id, event: action, label: { name: label }, actor: { login: actor } });
const record = (overrides = {}) => ({
  schema: 2,
  pr: 120,
  headSha: "a".repeat(40),
  labels: ["release/minor"],
  authorizedBy: "admin-user",
  eventId: 7,
  eventAction: "labeled",
  eventLabel: "release/minor",
  createdAt: "2026-07-17T00:00:00Z",
  ...overrides,
});

test("recognizes and sorts only release labels", () => {
  assert.deepEqual(recognizedReleaseLabels(["bug", "release/minor", "release/hotfix"]), ["release/hotfix", "release/minor"]);
  assert.deepEqual(recognizedReleaseLabels(["bug", "release/nope"]), []);
});

test("latest release label event ignores unrelated and malformed events", () => {
  assert.equal(latestReleaseLabelEvent([]), null);
  assert.equal(latestReleaseLabelEvent([labelEvent(1, "closed", "release/minor")]), null);
  assert.equal(latestReleaseLabelEvent([labelEvent(1, "labeled", "bug")]), null);
  assert.deepEqual(latestReleaseLabelEvent([
    labelEvent(1, "labeled", "release/patch"),
    labelEvent(9, "unlabeled", "release/minor", "someone"),
  ]), { id: 9, actor: "someone", action: "unlabeled", label: "release/minor" });
});

test("a non-positive event id is not usable authorization", () => {
  assert.equal(latestReleaseLabelEvent([labelEvent(0, "labeled", "release/minor")]), null);
  assert.equal(latestReleaseLabelEvent([labelEvent(-3, "labeled", "release/minor")]), null);
});

test("authorization records round-trip through the comment marker", () => {
  const original = record();
  assert.deepEqual(decodeAuthorization(encodeAuthorization(original)), original);
});

test("malformed and foreign-schema authorization bodies decode to null", () => {
  assert.equal(decodeAuthorization("not a marker"), null);
  assert.equal(decodeAuthorization(undefined), null);
  assert.equal(decodeAuthorization(encodeAuthorization(record({ schema: 1 }))), null);
  assert.equal(decodeAuthorization("<!-- lurkloot-release-label-authorization:@@@ -->"), null);
});

test("only the github-actions bot can carry an authorization record", () => {
  const body = encodeAuthorization(record());
  assert.equal(findAuthorizationComment([{ user: { login: "attacker", type: "User" }, body }]), null);
  assert.equal(findAuthorizationComment([{ user: { login: "github-actions[bot]", type: "User" }, body }]), null);
  assert.ok(findAuthorizationComment([{ user: { login: "github-actions[bot]", type: "Bot" }, body }]));
});

test("the newest authorization comment wins", () => {
  const first = { user: { login: "github-actions[bot]", type: "Bot" }, body: encodeAuthorization(record({ eventId: 1 })) };
  const second = { user: { login: "github-actions[bot]", type: "Bot" }, body: encodeAuthorization(record({ eventId: 2 })) };
  assert.equal(decodeAuthorization(findAuthorizationComment([first, second]).body).eventId, 2);
});

test("a record only authorizes the label event it was minted for", () => {
  const event = { id: 7, actor: "admin-user", action: "labeled", label: "release/minor" };
  assert.equal(authorizationMatchesEvent(record(), event), true);
  assert.equal(authorizationMatchesEvent(record({ eventId: 8 }), event), false);
  assert.equal(authorizationMatchesEvent(record({ eventAction: "unlabeled" }), event), false);
  assert.equal(authorizationMatchesEvent(record({ eventLabel: "release/patch" }), event), false);
  assert.equal(authorizationMatchesEvent(record(), null), false);
  assert.equal(authorizationMatchesEvent(null, event), false);
});

test("a record is bound to its PR, head SHA, and exact label set", () => {
  const snapshot = { pr: 120, headSha: "a".repeat(40), labels: ["release/minor"] };
  assert.equal(authorizationMatchesSnapshot(record(), snapshot), true);
  assert.equal(authorizationMatchesSnapshot(record({ pr: 121 }), snapshot), false);
  assert.equal(authorizationMatchesSnapshot(record({ headSha: "b".repeat(40) }), snapshot), false);
  assert.equal(authorizationMatchesSnapshot(record({ labels: ["release/patch"] }), snapshot), false);
  assert.equal(authorizationMatchesSnapshot(record({ labels: ["release/minor", "release/patch"] }), snapshot), false);
});

test("a non-administrator cannot authorize a label transition", () => {
  const outcome = deriveLabelEventAuthorization({
    actorPermission: "write",
    latestEvent: { id: 7, actor: "dev", action: "labeled", label: "release/minor" },
    eventAction: "labeled",
    eventActor: "dev",
    eventLabel: "release/minor",
  });
  assert.equal(outcome.authorized, false);
  assert.match(outcome.reason, /not an administrator/);
});

test("authorization binds to the event that triggered the run", () => {
  const latestEvent = { id: 7, actor: "admin-user", action: "labeled", label: "release/minor" };
  const base = { actorPermission: "admin", latestEvent, eventAction: "labeled", eventActor: "admin-user", eventLabel: "release/minor" };
  assert.equal(deriveLabelEventAuthorization(base).authorized, true);
  // A racing later event means the run is acting on stale context.
  assert.equal(deriveLabelEventAuthorization({ ...base, eventActor: "other" }).authorized, false);
  assert.equal(deriveLabelEventAuthorization({ ...base, eventAction: "unlabeled" }).authorized, false);
  assert.equal(deriveLabelEventAuthorization({ ...base, eventLabel: "release/patch" }).authorized, false);
  assert.equal(deriveLabelEventAuthorization({ ...base, latestEvent: null }).authorized, false);
});

test("built records carry the schema and binding fields", () => {
  const built = buildAuthorizationRecord({
    pr: 120,
    headSha: "a".repeat(40),
    labels: ["release/minor"],
    authorizedBy: "admin-user",
    event: { id: 7, action: "labeled", label: "release/minor" },
    createdAt: "2026-07-17T00:00:00Z",
  });
  assert.deepEqual(built, record());
});
