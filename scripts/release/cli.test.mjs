import test from "node:test";
import assert from "node:assert/strict";
import { candidateStatus, configureApplyRequested, formatAppTokenOutput, parseArgs, resolvePolicy, resolveVersion } from "./cli.mjs";

test("parses flags into a map", () => {
  assert.deepEqual(parseArgs(["--bump", "minor", "--version", "1.5.0"]), { bump: "minor", version: "1.5.0" });
  assert.deepEqual(parseArgs([]), {});
});

test("an explicit version wins over the bump, otherwise the bump applies", () => {
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "" }), "1.5.0");
  assert.equal(resolveVersion({ tags: ["v1.4.0"], bump: "minor", version: "2.0.0" }), "2.0.0");
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "" }), /bump must be/);
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "nope" }), /not stable SemVer/);
  assert.throws(() => resolveVersion({ tags: ["v1.4.0"], bump: "", version: "v2.0.0" }), /not stable SemVer/);
});

test("resolves release policy from comma-separated workflow inputs", () => {
  assert.deepEqual(resolvePolicy({
    labels: "docs,release/minor",
    head: "develop",
    tags: "v1.4.0 v1.5.0",
  }), {
    action: "prepare",
    bump: "minor",
    label: "release/minor",
    version: "1.6.0",
  });
});

test("renders candidate status with stable links", () => {
  assert.equal(candidateStatus({
    version: "1.6.0",
    sha: "abcdef123456",
    state: "ready",
    url: "https://github.com/jamezrin/lurkloot/releases/tag/v1.6.0",
  }), [
    "## Release candidate 1.6.0",
    "",
    "- State: **ready**",
    "- Source: `abcdef1`",
    "- Candidate: https://github.com/jamezrin/lurkloot/releases/tag/v1.6.0",
    "- Site: https://next.lurkloot.pages.dev",
  ].join("\n"));
});

test("masks an App token before exporting it", () => {
  assert.equal(formatAppTokenOutput("ghs_short"), "::add-mask::ghs_short\ntoken=ghs_short\n");
});

test("requires an explicit true value before applying repository settings", () => {
  assert.equal(configureApplyRequested({}), false);
  assert.equal(configureApplyRequested({ apply: "false" }), false);
  assert.equal(configureApplyRequested({ apply: "true" }), true);
  assert.throws(() => configureApplyRequested({ apply: "yes" }), /true or false/);
});

test("policy resolution accepts a space-separated exclusion list", () => {
  assert.equal(resolvePolicy({
    labels: "release/minor",
    head: "develop",
    tags: "v1.5.0 v1.6.0",
    exclude: "v1.6.0",
  }).version, "1.6.0");
});
