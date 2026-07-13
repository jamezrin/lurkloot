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

async function fixture(t, { version = "1.4.0", channel = "prerelease", date } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const path of manifests) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const manifest = { name: path === "package.json" ? "lurkloot" : `@lurkloot/${dirname(path).split("/").at(-1)}`, version, private: true };
    if (path === "package.json") manifest.release = { channel };
    await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const changelogPath = join(root, "packages/site/src/changelog.json");
  await mkdir(dirname(changelogPath), { recursive: true });
  const entry = { version, ...(date ? { date } : {}), changes: [] };
  await writeFile(changelogPath, `${JSON.stringify([entry], null, 2)}\n`);
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [releaseScript, ...args], { cwd: root, encoding: "utf8" });
}

test("check accepts consistent prerelease and stable declarations", async (t) => {
  const prereleaseRoot = await fixture(t);
  const stableRoot = await fixture(t, { channel: "stable", date: "2026-07-13" });

  const prerelease = run(prereleaseRoot, "check");
  const stable = run(stableRoot, "check");

  assert.equal(prerelease.status, 0, prerelease.stderr);
  assert.match(prerelease.stdout, /1\.4\.0 \(pre-release\) is consistent/);
  assert.equal(stable.status, 0, stable.stderr);
  assert.match(stable.stdout, /1\.4\.0 \(stable\) is consistent/);
});

test("check rejects an unknown release channel", async (t) => {
  const root = await fixture(t, { channel: "candidate" });
  const result = run(root, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release\.channel must be "prerelease" or "stable"/);
});

test("prepare starts a prerelease and synchronizes every manifest", async (t) => {
  const root = await fixture(t, { version: "1.4.0", channel: "stable", date: "2026-07-13" });
  const result = run(root, "prepare", "1.5.0", "--prerelease");

  assert.equal(result.status, 0, result.stderr);
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    assert.equal(manifest.version, "1.5.0", path);
  }
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(rootManifest.release.channel, "prerelease");
  const changelog = JSON.parse(await readFile(join(root, "packages/site/src/changelog.json"), "utf8"));
  assert.equal(changelog[0].version, "1.5.0");
  assert.equal(changelog[0].date, undefined);
});

test("prepare promotes a prerelease to stable", async (t) => {
  const root = await fixture(t);
  const result = run(root, "prepare", "1.4.0", "--stable", "--date", "2026-07-13");

  assert.equal(result.status, 0, result.stderr);
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(rootManifest.release.channel, "stable");
  const changelog = JSON.parse(await readFile(join(root, "packages/site/src/changelog.json"), "utf8"));
  assert.equal(changelog[0].date, "2026-07-13");
});
