#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const packages = [
  "package.json",
  "packages/extension/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/locales/package.json",
  "packages/popup-ui/package.json",
  "packages/shared/package.json",
];
const rootManifestPath = packages[0];
const changelogPath = "packages/site/src/changelog.ts";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const releaseChannels = new Set(["prerelease", "stable"]);

function fail(message) {
  console.error(`release: ${message}`);
  process.exitCode = 1;
}

function declaration(manifest) {
  const channel = manifest.release?.channel;
  if (!releaseChannels.has(channel)) {
    throw new Error('package.json release.channel must be "prerelease" or "stable"');
  }
  return { version: manifest.version, channel, prerelease: channel === "prerelease" };
}

function changelogEntry(source, version) {
  const marker = `version: "${version}"`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  const next = source.indexOf("\n  {", start);
  const text = source.slice(start, next < 0 ? source.length : next);
  const date = text.match(/\n\s*date:\s*"([^"]+)"/)?.[1];
  return { text, date };
}

function validDate(value) {
  if (!isoDate.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function check() {
  let active;
  try {
    active = declaration(JSON.parse(await readFile(rootManifestPath, "utf8")));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (!semver.test(active.version)) fail(`${active.version} is not a valid release semver`);
  for (const path of packages) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.version !== active.version) {
      fail(`${path} has version ${manifest.version}; expected ${active.version}`);
    }
  }
  const source = await readFile(changelogPath, "utf8");
  const entry = changelogEntry(source, active.version);
  if (!entry) fail(`changelog has no ${active.version} entry`);
  else if (active.prerelease && entry.date) fail(`prerelease ${active.version} must be Unreleased (no date)`);
  else if (!active.prerelease && !validDate(entry.date)) fail(`stable ${active.version} must have a valid dated changelog entry`);
  if (!process.exitCode) console.log(`${active.version} (${active.prerelease ? "pre-release" : "stable"}) is consistent`);
}

async function prepare(args) {
  const [version, status, dateFlag, date] = args;
  if (!semver.test(version ?? "")) throw new Error("usage: release:prepare VERSION (--prerelease | --stable --date YYYY-MM-DD)");
  if (!['--prerelease', '--stable'].includes(status)) throw new Error("choose exactly one of --prerelease or --stable");
  const prerelease = status === "--prerelease";
  const channel = prerelease ? "prerelease" : "stable";
  if (!prerelease && (dateFlag !== "--date" || !validDate(date))) throw new Error("stable releases require a valid --date YYYY-MM-DD");
  if (prerelease && args.length !== 2) throw new Error("pre-releases do not accept a release date");

  for (const path of packages) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = version;
    if (path === rootManifestPath) manifest.release = { ...manifest.release, channel };
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  let source = await readFile(changelogPath, "utf8");
  const entry = changelogEntry(source, version);
  if (!entry) {
    const insertion = `  {\n    version: "${version}",\n${prerelease ? "    // Unreleased — omit `date` until the public release.\n" : `    date: "${date}",\n`}    changes: [],\n  },\n`;
    source = source.replace("export const changelog: ChangelogEntry[] = [\n", `export const changelog: ChangelogEntry[] = [\n${insertion}`);
  } else if (prerelease) {
    source = source.replace(entry.text, entry.text.replace(/\n\s*date:\s*"\d{4}-\d{2}-\d{2}",?/, ""));
  } else if (entry.date) {
    source = source.replace(entry.text, entry.text.replace(/date:\s*"\d{4}-\d{2}-\d{2}"/, `date: "${date}"`));
  } else {
    source = source.replace(entry.text, entry.text.replace(/(version:\s*"[^"]+",)/, `$1\n    date: "${date}",`).replace(/\n\s*\/\/ Unreleased[^\n]*/, ""));
  }
  await writeFile(changelogPath, source);
  await check();
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "check") await check();
  else if (command === "prepare") await prepare(args);
  else throw new Error("usage: release.mjs <check | prepare VERSION --prerelease | --stable --date YYYY-MM-DD>");
} catch (error) {
  fail(error.message);
}
