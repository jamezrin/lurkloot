#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseManifestVersion as parseVersion } from "./release/version.mjs";

// The application version is declared once, in the root manifest (#184). The
// workspace packages are private and never published, so they carry no version
// of their own; anything that needs the application version reads the root.
export const rootManifestPath = "package.json";
export const workspaceDir = "packages";
// Packages versioned independently of the application. store-sync is generic
// and meant to be liftable into its own repository, so it keeps its own version,
// which a release never bumps.
export const independentlyVersioned = new Set(["packages/store-sync/package.json"]);
export const changelogPath = "packages/site/src/changelog.json";
// The desktop app (#1025). tauri.conf.json takes its version from the root manifest by path, so
// it can't drift. Cargo can't point anywhere, so prepare writes the version into the crate's
// manifest and lockfile entry and check fails when they differ from the root.
export const desktopCrateName = "lurkloot-desktop";
export const desktopCargoManifestPath = "packages/desktop/src-tauri/Cargo.toml";
export const desktopCargoLockPath = "packages/desktop/src-tauri/Cargo.lock";
export const desktopTauriConfigPath = "packages/desktop/src-tauri/tauri.conf.json";
const tauriVersionReference = "../../../package.json";
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (!isoDate.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function entryFor(changelog, version) {
  if (!Array.isArray(changelog)) throw new Error("changelog must be an array");
  return changelog.find((entry) => entry.version === version);
}

// Every packages/* directory with a manifest, found rather than listed, so a
// new workspace package is covered without touching this script.
async function workspaceManifests() {
  const manifests = [];
  for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${workspaceDir}/${entry.name}/package.json`;
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    manifests.push({ path, manifest: JSON.parse(text) });
  }
  return manifests.sort((a, b) => a.path.localeCompare(b.path));
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// The `version = "…"` line of the crate's own [package] table in Cargo.toml.
const cargoManifestVersion = /^(\[package\]\r?\n(?:(?!\[)[^\n]*\n)*?version\s*=\s*")([^"]*)(")/m;

// The `version = "…"` line right after `name = "lurkloot-desktop"` in Cargo.lock.
function cargoLockVersion() {
  return new RegExp(
    `^(\\[\\[package\\]\\]\\r?\\nname = "${desktopCrateName}"\\r?\\nversion = ")([^"]*)(")`,
    "m",
  );
}

async function desktopVersions() {
  const manifest = await readOptional(desktopCargoManifestPath);
  if (manifest === undefined) return undefined;
  const lock = await readOptional(desktopCargoLockPath);
  const config = await readOptional(desktopTauriConfigPath);
  return {
    manifest,
    lock,
    cargo: manifest.match(cargoManifestVersion)?.[2],
    cargoLock: lock?.match(cargoLockVersion())?.[2],
    tauri: config === undefined ? undefined : JSON.parse(config).version,
  };
}

async function prepareDesktop(version) {
  const desktop = await desktopVersions();
  if (!desktop) return;
  if (desktop.cargo === undefined)
    throw new Error(`${desktopCargoManifestPath} has no [package] version`);
  await writeFile(
    desktopCargoManifestPath,
    desktop.manifest.replace(
      cargoManifestVersion,
      (_, head, _old, tail) => `${head}${version}${tail}`,
    ),
  );
  if (desktop.lock !== undefined) {
    if (desktop.cargoLock === undefined)
      throw new Error(`${desktopCargoLockPath} has no ${desktopCrateName} package`);
    await writeFile(
      desktopCargoLockPath,
      desktop.lock.replace(cargoLockVersion(), (_, head, _old, tail) => `${head}${version}${tail}`),
    );
  }
}

function checkDesktop(desktop, version) {
  if (!desktop) return true;
  let ok = true;
  if (desktop.cargo !== version) {
    console.error(
      `release: ${desktopCargoManifestPath} declares ${desktop.cargo}; expected ${version}`,
    );
    ok = false;
  }
  if (desktop.lock === undefined) {
    console.error(`release: ${desktopCargoLockPath} is missing`);
    ok = false;
  } else if (desktop.cargoLock !== version) {
    console.error(
      `release: ${desktopCargoLockPath} locks ${desktopCrateName} ${desktop.cargoLock}; expected ${version}`,
    );
    ok = false;
  }
  if (desktop.tauri !== tauriVersionReference) {
    console.error(
      `release: ${desktopTauriConfigPath} declares version ${desktop.tauri}; it must be "${tauriVersionReference}"`,
    );
    ok = false;
  }
  return ok;
}

export async function checkWorkspace() {
  const root = JSON.parse(await readFile(rootManifestPath, "utf8"));
  parseVersion(root.version);
  let failed = false;
  for (const { path, manifest } of await workspaceManifests()) {
    if (independentlyVersioned.has(path)) {
      try {
        parseVersion(manifest.version);
      } catch {
        console.error(`release: ${path} is independently versioned but has no valid version`);
        failed = true;
      }
    } else if (Object.hasOwn(manifest, "version")) {
      console.error(
        `release: ${path} declares version ${manifest.version}; only ${rootManifestPath} may declare the version`,
      );
      failed = true;
    }
  }
  const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
  const entry = entryFor(changelog, root.version);
  if (!entry) {
    console.error(`release: changelog has no ${root.version} entry`);
    failed = true;
  } else if (Object.hasOwn(entry, "date") && !validDate(entry.date)) {
    console.error(`release: ${root.version} has invalid changelog date ${entry.date}`);
    failed = true;
  }
  if (!checkDesktop(await desktopVersions(), root.version)) failed = true;
  if (failed) throw new Error("workspace release metadata is inconsistent");
  console.log(`${root.version} is consistent`);
}

export async function prepareWorkspace(version, date) {
  parseVersion(version);
  if (date !== undefined && !validDate(date))
    throw new Error("prepare requires a valid --date YYYY-MM-DD");
  const root = JSON.parse(await readFile(rootManifestPath, "utf8"));
  root.version = version;
  delete root.release;
  await writeFile(rootManifestPath, `${JSON.stringify(root, null, 2)}\n`);
  const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
  let entry = entryFor(changelog, version);
  if (!entry) {
    entry = { version, changes: [] };
    changelog.unshift(entry);
  }
  if (date === undefined) delete entry.date;
  else entry.date = date;
  await writeFile(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  await prepareDesktop(version);
  await checkWorkspace();
}

async function main() {
  const [command, version, dateFlag, date] = process.argv.slice(2);
  if (command === "check" && version === undefined) return checkWorkspace();
  if (command === "prepare" && version && dateFlag === undefined) return prepareWorkspace(version);
  if (command === "prepare" && version && dateFlag === "--date" && date)
    return prepareWorkspace(version, date);
  throw new Error("usage: release.mjs <check | prepare VERSION [--date YYYY-MM-DD]>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  });
}
