#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseManifestVersion as parseVersion } from "./release/version.mjs";

// The application version is declared once, in the root manifest (#184). The
// workspace packages are private and never published, so none of them carries
// a version of its own; anything that needs the version reads the root.
export const rootManifestPath = "package.json";
export const workspaceDir = "packages";
export const changelogPath = "packages/site/src/changelog.json";
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

export async function checkWorkspace() {
  const root = JSON.parse(await readFile(rootManifestPath, "utf8"));
  parseVersion(root.version);
  let failed = false;
  for (const { path, manifest } of await workspaceManifests()) {
    if (Object.hasOwn(manifest, "version")) {
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
