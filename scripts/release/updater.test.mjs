import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { desktopUpdates, expectedReleaseAssets, updaterAssetNames } from "./pipeline.mjs";
import { stripUpdaterAssets, writeUpdaterAssets } from "./updater.mjs";

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "lurkloot-updater-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function releaseAssets(t, version) {
  const dir = await folder(t);
  for (const name of expectedReleaseAssets(version)) await writeFile(join(dir, name), name);
  return dir;
}

test("signs a copy of each update, bound to the version, and writes latest.json", async (t) => {
  const assets = await releaseAssets(t, "1.6.0");
  const before = (await readdir(assets)).sort();
  const out = await folder(t);
  const signed = [];
  const written = await writeUpdaterAssets({
    assetsDir: assets,
    outDir: out,
    version: "1.6.0",
    repository: "jamezrin/lurkloot",
    pubDate: "2026-11-27T00:00:00.000Z",
    sign: (file, version) => {
      signed.push([basename(file), version]);
      return writeFile(`${file}.sig`, `signature of ${basename(file)}\n`);
    },
  });
  assert.deepEqual(written, updaterAssetNames("1.6.0"));
  assert.deepEqual(
    signed,
    desktopUpdates("1.6.0").map((update) => [update.asset, "1.6.0"]),
  );
  // The reviewed assets are untouched, and only the updater's files are left in out.
  assert.deepEqual((await readdir(assets)).sort(), before);
  assert.deepEqual((await readdir(out)).sort(), [...updaterAssetNames("1.6.0")].sort());
  const manifest = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(manifest.version, "1.6.0");
  assert.equal(manifest.notes, "https://github.com/jamezrin/lurkloot/releases/tag/v1.6.0");
  assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], {
    signature: "signature of lurkloot-desktop-1.6.0-windows-x64-setup.exe",
    url: "https://github.com/jamezrin/lurkloot/releases/download/v1.6.0/lurkloot-desktop-1.6.0-windows-x64-setup.exe",
  });
});

test("fails when the signer writes no signature", async (t) => {
  const assets = await releaseAssets(t, "1.6.0");
  await assert.rejects(
    writeUpdaterAssets({
      assetsDir: assets,
      outDir: await folder(t),
      version: "1.6.0",
      repository: "jamezrin/lurkloot",
      sign: () => {},
    }),
    /ENOENT/,
  );
});

test("strips only the updater's files from a downloaded release", async (t) => {
  const assets = await releaseAssets(t, "1.6.0");
  for (const name of updaterAssetNames("1.6.0")) await writeFile(join(assets, name), "x");
  await stripUpdaterAssets({ assetsDir: assets, version: "1.6.0" });
  assert.deepEqual((await readdir(assets)).sort(), [...expectedReleaseAssets("1.6.0")].sort());
  // Nothing to strip is fine too.
  await stripUpdaterAssets({ assetsDir: assets, version: "1.6.0" });
});
