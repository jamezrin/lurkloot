import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyStringLeaves, collectStringLeaves } from "../src/i18n/strings.ts";
import { readCache, writeCache } from "../src/i18n/cache.ts";

test("flattens and rebuilds nested copy leaves in order", () => {
  const tree = { a: "Hello", b: { c: "World", d: ["X", "Y"] } };
  const leaves = collectStringLeaves(tree);
  assert.deepEqual(leaves, ["Hello", "World", "X", "Y"]);
  const translated = applyStringLeaves(tree, ["Hola", "Mundo", "x", "y"]);
  assert.deepEqual(translated, { a: "Hola", b: { c: "Mundo", d: ["x", "y"] } });
});

test("applyStringLeaves throws when the leaf count drifts", () => {
  assert.throws(() => applyStringLeaves({ a: "A" }, ["A", "B"]));
});

test("round-trips a locale cache directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-i18n-"));
  try {
    await writeCache(dir, "es", { abc: "Hola" });
    assert.deepEqual(await readCache(dir, "es"), { abc: "Hola" });
    assert.deepEqual(await readCache(dir, "de"), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
