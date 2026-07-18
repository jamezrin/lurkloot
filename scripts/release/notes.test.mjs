import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "./notes.mjs";

const changelog = [
  { version: "1.6.0", date: "2026-08-01", changes: [
    { kind: "new", text: "Added rotating tips." },
    { kind: "fixed", text: "Fixed a crash." },
    { kind: "new", text: "Added profiles." },
  ] },
  { version: "1.5.0", date: "2026-07-18", changes: [{ kind: "new", text: "Older." }] },
];

test("renders the requested version grouped by kind", () => {
  assert.equal(releaseNotes(changelog, "1.6.0"), [
    "## New",
    "- Added rotating tips.",
    "- Added profiles.",
    "",
    "## Fixed",
    "- Fixed a crash.",
  ].join("\n"));
});

test("omits empty groups and rejects an unknown version", () => {
  assert.equal(releaseNotes(changelog, "1.5.0"), ["## New", "- Older."].join("\n"));
  assert.throws(() => releaseNotes(changelog, "9.9.9"), /no changelog entry for 9\.9\.9/);
});
