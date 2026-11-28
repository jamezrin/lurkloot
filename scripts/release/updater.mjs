// The desktop updater's files (#1028): a signature for each update and the latest.json manifest the
// app reads. Only the approved production job runs this, since it alone holds the signing key; the
// candidate's reviewed assets are signed as they are, never rebuilt.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  desktopUpdates,
  updaterAssetNames,
  updaterManifest,
  updaterManifestName,
} from "./pipeline.mjs";

/**
 * Signs `file` with the Tauri CLI, bound to `version` so the app can refuse the signature for any
 * other version (`requireSignedVersion`). The key and its password come from the environment
 * (TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD) and never reach the command line.
 * The CLI writes `<file>.sig`.
 */
export function tauriSign(file, version) {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@lurkloot/desktop",
      "exec",
      "tauri",
      "signer",
      "sign",
      "--app-version",
      version,
      file,
    ],
    { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" },
  );
}

/** Removes the updater's files from a downloaded release, so the reviewed set can be checked. */
export async function stripUpdaterAssets({ assetsDir, version }) {
  for (const name of updaterAssetNames(version)) await rm(join(assetsDir, name), { force: true });
}

/**
 * Signs each update in `assetsDir` and writes the signatures and latest.json to `outDir`.
 * Returns the names written.
 */
export async function writeUpdaterAssets({
  assetsDir,
  outDir,
  version,
  repository,
  pubDate = new Date().toISOString(),
  sign = tauriSign,
}) {
  await mkdir(outDir, { recursive: true });
  const signatures = {};
  const written = [];
  for (const update of desktopUpdates(version)) {
    // Signed in outDir, on a copy, so nothing is added to the reviewed assets' folder.
    const copy = join(outDir, update.asset);
    await copyFile(join(assetsDir, update.asset), copy);
    await sign(resolve(copy), version);
    signatures[update.asset] = await readFile(`${copy}.sig`, "utf8");
    await rm(copy);
    written.push(update.signature);
  }
  const manifest = updaterManifest({
    version,
    pubDate,
    notes: `https://github.com/${repository}/releases/tag/v${version}`,
    signatures,
    downloadBase: `https://github.com/${repository}/releases/download/v${version}`,
  });
  await writeFile(join(outDir, updaterManifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(updaterManifestName);
  return written;
}
