import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));
const workspaceManifests = [
  "packages/extension/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/locales/package.json",
  "packages/popup-ui/package.json",
  "packages/shared/package.json",
];

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fixture(t, { version = "1.4.0", date = "2026-07-15" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(join(root, "package.json"), { name: "lurkloot", version, private: true });
  for (const path of workspaceManifests) {
    await writeJson(join(root, path), {
      name: `@lurkloot/${dirname(path).split("/").at(-1)}`,
      private: true,
    });
  }
  // A workspace directory without a manifest is not a package.
  await mkdir(join(root, "packages/scratch"), { recursive: true });
  const changelogPath = join(root, "packages/site/src/changelog.json");
  await mkdir(dirname(changelogPath), { recursive: true });
  await writeFile(
    changelogPath,
    `${JSON.stringify([{ version, ...(date ? { date } : {}), changes: [] }], null, 2)}\n`,
  );
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [releaseScript, ...args], { cwd: root, encoding: "utf8" });
}

test("check accepts a version declared only in the root manifest", async (t) => {
  const root = await fixture(t);
  const result = run(root, "check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.4\.0 is consistent/);
});

for (const version of ["1.4.0", "0.1.0"]) {
  test(`check rejects a workspace manifest declaring version ${version}`, async (t) => {
    const root = await fixture(t);
    const path = join(root, "packages/core/package.json");
    await writeJson(path, { ...(await readJson(path)), version });
    const result = run(root, "check");
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`packages/core/package.json declares version ${version.replaceAll(".", "\\.")}`),
    );
  });
}

test("check finds workspace packages it was never told about", async (t) => {
  const root = await fixture(t);
  await writeJson(join(root, "packages/new-package/package.json"), {
    name: "@lurkloot/new-package",
    version: "0.0.1",
  });
  const result = run(root, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/new-package\/package.json declares version/);
});

test("check rejects a root manifest without a valid version", async (t) => {
  const root = await fixture(t);
  const rootPath = join(root, "package.json");
  const { version: _, ...manifest } = await readJson(rootPath);
  await writeJson(rootPath, manifest);
  const result = run(root, "check");
  assert.equal(result.status, 1);
});

test("prepare bumps only the root manifest and removes legacy channel state", async (t) => {
  const root = await fixture(t);
  const rootPath = join(root, "package.json");
  await writeJson(rootPath, { ...(await readJson(rootPath)), release: { channel: "stable" } });
  const before = await Promise.all(
    workspaceManifests.map((path) => readFile(join(root, path), "utf8")),
  );
  const result = run(root, "prepare", "1.5.0");
  assert.equal(result.status, 0, result.stderr);
  const rootManifest = await readJson(rootPath);
  assert.equal(rootManifest.version, "1.5.0");
  assert.equal(rootManifest.release, undefined);
  const after = await Promise.all(
    workspaceManifests.map((path) => readFile(join(root, path), "utf8")),
  );
  assert.deepEqual(after, before);
  const changelog = JSON.parse(
    await readFile(join(root, "packages/site/src/changelog.json"), "utf8"),
  );
  assert.equal(changelog[0].version, "1.5.0");
  assert.equal(changelog[0].date, undefined);
});

test("prepare dates stable release metadata", async (t) => {
  const root = await fixture(t, { date: undefined });
  const result = run(root, "prepare", "1.4.0", "--date", "2026-07-16");
  assert.equal(result.status, 0, result.stderr);
  const changelog = JSON.parse(
    await readFile(join(root, "packages/site/src/changelog.json"), "utf8"),
  );
  assert.equal(changelog[0].date, "2026-07-16");
});

test("prepare rejects invalid release dates", async (t) => {
  const root = await fixture(t);
  const result = run(root, "prepare", "1.5.0", "--date", "2026-02-30");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid --date/);
});

test("check rejects a present empty changelog date", async (t) => {
  const root = await fixture(t);
  const changelogPath = join(root, "packages/site/src/changelog.json");
  const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
  changelog[0].date = "";
  await writeFile(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  const result = run(root, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid changelog date/);
});
