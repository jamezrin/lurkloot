import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveVersion } from "./cli.mjs";

test("parses flags into a map", () => {
  assert.deepEqual(parseArgs(["--bump", "minor", "--version", "1.5.0"]), { bump: "minor", version: "1.5.0" });
  assert.deepEqual(parseArgs([]), {});
});

test("an explicit version wins over the bump, otherwise the bump applies", () => {
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "" }), "1.5.0");
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "2.0.0" }), "2.0.0");
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "" }), /bump must be/);
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "nope" }), /not stable SemVer/);
});
