#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseVersion } from "./release/model.mjs";

export const packagePaths = [
  "package.json",
  "packages/extension/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/locales/package.json",
  "packages/popup-ui/package.json",
  "packages/shared/package.json",
];
const changelogPath = "packages/site/src/changelog.json";
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

export async function checkWorkspace() {
  const root = JSON.parse(await readFile(packagePaths[0], "utf8"));
  parseVersion(root.version);
  let failed = false;
  for (const path of packagePaths) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.version !== root.version) {
      console.error(`release: ${path} has version ${manifest.version}; expected ${root.version}`);
      failed = true;
    }
  }
  const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
  const entry = entryFor(changelog, root.version);
  if (!entry) {
    console.error(`release: changelog has no ${root.version} entry`);
    failed = true;
  } else if (entry.date && !validDate(entry.date)) {
    console.error(`release: ${root.version} has invalid changelog date ${entry.date}`);
    failed = true;
  }
  if (failed) throw new Error("workspace release metadata is inconsistent");
  console.log(`${root.version} is consistent`);
}

export async function prepareWorkspace(version, date) {
  parseVersion(version);
  if (date !== undefined && !validDate(date)) throw new Error("prepare requires a valid --date YYYY-MM-DD");
  for (const path of packagePaths) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = version;
    if (path === packagePaths[0]) delete manifest.release;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
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
  if (command === "prepare" && version && dateFlag === "--date" && date) return prepareWorkspace(version, date);
  throw new Error("usage: release.mjs <check | prepare VERSION [--date YYYY-MM-DD]>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  });
}
