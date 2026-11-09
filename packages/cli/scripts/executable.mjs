// Helpers for the standalone `lurkloot` executable (#1022), shared by
// buildExecutable.mjs and smokeExecutable.mjs and unit-tested on their own
// (tests/executable.test.ts). Nothing here builds or runs anything.
import { readFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

// Node's single-executable fuse and resource names (doc/api/single-executable-applications.md).
export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
export const SEA_RESOURCE = "NODE_SEA_BLOB";
export const SEA_MACHO_SEGMENT = "NODE_SEA";

// cycletls's own file name for each platform's Go binary (its dist/index.js),
// for the targets the executable ships.
const CYCLETLS_UPSTREAM = {
  "linux-x64": "index",
  "linux-arm64": "index-arm64",
  "darwin-x64": "index-mac",
  "darwin-arm64": "index-mac-arm64",
  "win32-x64": "index.exe",
};

export function cycleTlsUpstreamName(platform, arch) {
  const name = CYCLETLS_UPSTREAM[`${platform}-${arch}`];
  if (!name) throw new Error(`cycletls ships no binary for ${platform}-${arch}`);
  return name;
}

export function executableName(platform) {
  return platform === "win32" ? "lurkloot.exe" : "lurkloot";
}

// The package directory of a node_modules path, or undefined for a workspace
// source file. Handles scoped packages and pnpm's nested store layout by
// taking the last node_modules segment.
export function packageDirOf(file) {
  const parts = file.split(/[\\/]/);
  const index = parts.lastIndexOf("node_modules");
  if (index === -1 || index + 1 >= parts.length) return undefined;
  const length = parts[index + 1].startsWith("@") ? 2 : 1;
  if (index + length >= parts.length) return undefined;
  return parts.slice(0, index + 1 + length).join(sep);
}

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md"];

function readLicense(dir, read) {
  for (const name of LICENSE_FILES) {
    try {
      return read(join(dir, name));
    } catch {
      // Try the next spelling.
    }
  }
  return undefined;
}

function describePackage(absolute, read) {
  const manifest = JSON.parse(read(join(absolute, "package.json")));
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === "string" ? manifest.license : "see below",
    text: readLicense(absolute, read),
  };
}

const byName = (a, b) => a.name.localeCompare(b.name);

// The npm packages esbuild put into the bundle, from its metafile's inputs,
// with each one's license text.
export function bundledPackages(inputs, { root, read = (path) => readFileSync(path, "utf8") }) {
  const dirs = new Set();
  for (const input of inputs) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  return [...dirs].map((dir) => describePackage(join(root, dir), read)).sort(byName);
}

// The runtime dependency closure of the package in `dir`: what has to sit in
// its node_modules for it to load. Type-only @types packages are left out.
// `resolve(fromDir, name)` answers the dependency's package directory. The
// closure ships flat, so two versions of one package are refused.
export function dependencyClosure(dir, { resolve, read = (path) => readFileSync(path, "utf8") }) {
  const found = new Map();
  const visit = (from) => {
    const manifest = JSON.parse(read(join(from, "package.json")));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith("@types/")) continue;
      const depDir = resolve(from, name);
      const pkg = { ...describePackage(depDir, read), dir: depDir };
      const seen = found.get(name);
      if (seen) {
        if (seen.version !== pkg.version)
          throw new Error(`${name} is needed at ${seen.version} and ${pkg.version}`);
        continue;
      }
      found.set(name, pkg);
      visit(depDir);
    }
  };
  visit(dir);
  return [...found.values()].sort(byName);
}

// The archive's NOTICE: what the executable contains besides Lurkloot itself,
// and the license each part comes under, in full.
export function renderNotice({ version, nodeVersion, nodeLicense, cycleTls, packages }) {
  const cycleTlsDependencies = cycleTls.dependencies ?? [];
  const lines = [
    `Lurkloot CLI ${version}`,
    "Licensed under the Apache License, Version 2.0; see LICENSE.",
    "https://github.com/jamezrin/lurkloot",
    "",
    "This archive also contains third-party software, each part under its own license:",
    "",
    `- The lurkloot executable is the Node.js ${nodeVersion} runtime with the Lurkloot CLI`,
    "  embedded as a single-executable application. Node.js is under the MIT license and",
    "  bundles further components under their own licenses, reproduced below.",
    `- cycletls/ is the unmodified cycletls ${cycleTls.version} npm package, under the GNU`,
    "  General Public License v3.0 (cycletls/LICENSE, reproduced below): its JavaScript, and",
    `  its Go binary as cycletls/${cycleTls.file}, which runs as a separate process. The`,
    "  executable loads the JavaScript from that folder at run time; it is not compiled in.",
    "  Its source code is at https://github.com/Danny-Dasilva/CycleTLS",
    `  (version ${cycleTls.version}). cycletls/node_modules holds its runtime dependencies,`,
    "  each with its own license file:",
    "",
  ];
  for (const pkg of cycleTlsDependencies)
    lines.push(`  - ${pkg.name} ${pkg.version} (${pkg.license})`);
  lines.push(
    "",
    "- The npm packages below are bundled into the Lurkloot CLI inside the executable.",
    "",
  );
  for (const pkg of packages) lines.push(`  - ${pkg.name} ${pkg.version} (${pkg.license})`);
  const section = (title, text) => {
    lines.push("", "=".repeat(78), title, "=".repeat(78), "", text.trimEnd());
  };
  section(`Node.js ${nodeVersion}`, nodeLicense);
  section(`cycletls ${cycleTls.version}`, cycleTls.license);
  for (const pkg of [...cycleTlsDependencies, ...packages]) {
    section(
      `${pkg.name} ${pkg.version}`,
      pkg.text ?? `Licensed under ${pkg.license}; the package ships no license file.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// The env for a child that must not find Node: PATH without any directory
// that holds a node executable. Windows spells the key `Path`.
export function envWithoutNode(env, { platform = process.platform, hasNode }) {
  const result = { ...env };
  const nodeName = platform === "win32" ? "node.exe" : "node";
  const separator = platform === "win32" ? ";" : delimiter;
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() !== "path") continue;
    result[key] = result[key]
      .split(separator)
      .filter((dir) => dir && !hasNode(join(dir, nodeName)))
      .join(separator);
  }
  return result;
}

// Where Node's own LICENSE sits beside the running node binary: next to it on
// Windows, one level up (beside bin/) elsewhere.
export function nodeLicenseCandidates(execPath) {
  const dir = dirname(execPath);
  return [join(dir, "LICENSE"), join(dir, "..", "LICENSE")];
}
