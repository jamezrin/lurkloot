import test from "node:test";
import assert from "node:assert/strict";
import { latestVersion, nextVersion, parseVersion } from "./version.mjs";

test("parses stable semver only", () => {
  assert.deepEqual(parseVersion("1.5.0"), { major: 1, minor: 5, patch: 0 });
  assert.deepEqual(parseVersion("v1.5.0"), { major: 1, minor: 5, patch: 0 });
  assert.throws(() => parseVersion("1.5"), /not stable SemVer/);
  assert.throws(() => parseVersion("1.5.0-rc.1"), /not stable SemVer/);
  assert.throws(() => parseVersion("01.5.0"), /not stable SemVer/);
});

test("bumps each component and resets the lower ones", () => {
  assert.equal(nextVersion("1.5.3", "patch"), "1.5.4");
  assert.equal(nextVersion("1.5.3", "minor"), "1.6.0");
  assert.equal(nextVersion("1.5.3", "major"), "2.0.0");
  assert.throws(() => nextVersion("1.5.3", "huge"), /bump must be/);
});

test("latestVersion ignores non-release tags and orders numerically", () => {
  const tags = ["v1.4.0", "v1.10.0", "v1.9.0", "candidate-9-1", "v2.0.0-rc.1"];
  assert.equal(latestVersion(tags), "1.10.0");
  assert.equal(latestVersion([]), "0.0.0");
});
