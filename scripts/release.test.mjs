import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));
const manifests = [
  "package.json",
  "packages/extension/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/locales/package.json",
  "packages/popup-ui/package.json",
  "packages/shared/package.json",
];

async function fixture(t, { version = "1.4.0", date = "2026-07-15" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of manifests) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const manifest = { name: path === "package.json" ? "lurkloot" : `@lurkloot/${dirname(path).split("/").at(-1)}`, version, private: true };
    if (path === "package.json") manifest.release = { channel: "stable" };
    await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const changelogPath = join(root, "packages/site/src/changelog.json");
  await mkdir(dirname(changelogPath), { recursive: true });
  await writeFile(changelogPath, `${JSON.stringify([{ version, ...(date ? { date } : {}), changes: [] }], null, 2)}\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [releaseScript, ...args], { cwd: root, encoding: "utf8" });
}

test("check accepts synchronized manifests without release channel state", async (t) => {
  const root = await fixture(t);
  const result = run(root, "check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.4\.0 is consistent/);
});

test("check rejects a mismatched workspace version", async (t) => {
  const root = await fixture(t);
  const path = join(root, "packages/core/package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = "1.5.0";
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = run(root, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/core\/package.json has version 1\.5\.0/);
});

test("prepare synchronizes manifests and removes legacy channel state", async (t) => {
  const root = await fixture(t);
  const result = run(root, "prepare", "1.5.0");
  assert.equal(result.status, 0, result.stderr);
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    assert.equal(manifest.version, "1.5.0", path);
  }
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(rootManifest.release, undefined);
  const changelog = JSON.parse(await readFile(join(root, "packages/site/src/changelog.json"), "utf8"));
  assert.equal(changelog[0].version, "1.5.0");
  assert.equal(changelog[0].date, undefined);
});

test("prepare dates stable release metadata", async (t) => {
  const root = await fixture(t, { date: undefined });
  const result = run(root, "prepare", "1.4.0", "--date", "2026-07-16");
  assert.equal(result.status, 0, result.stderr);
  const changelog = JSON.parse(await readFile(join(root, "packages/site/src/changelog.json"), "utf8"));
  assert.equal(changelog[0].date, "2026-07-16");
});

test("prepare rejects invalid release dates", async (t) => {
  const root = await fixture(t);
  const result = run(root, "prepare", "1.5.0", "--date", "2026-02-30");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid --date/);
});
