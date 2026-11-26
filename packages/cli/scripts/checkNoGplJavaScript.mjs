// Fails when GPL JavaScript would run inside the CLI's process (#1031): a
// GPL-licensed npm package anywhere under a shipped node_modules, or GPL
// package code esbuild put into a bundle (per its metafile). CycleTLS's Go
// binary is a separate program and is fine; its npm wrapper is not.
//
//   node scripts/checkNoGplJavaScript.mjs [--node-modules <dir>]... [--metafile <file>]...
//
// Run from packages/cli. The Docker build runs it on the image's node_modules
// and dist/index.mjs's metafile; the executable build runs both checks itself
// (scripts/buildExecutable.mjs).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDirOf } from "./executable.mjs";

// GPL and AGPL, as SPDX ids or spelled out; the LGPL ("Lesser") is a separate
// license and allowed.
const GPL = /(^|[^L])\bA?GPL|GNU\s+(Affero\s+)?General\s+Public/i;

/** Tells whether a package.json license field names the GPL. */
export function isGplLicense(license) {
  const text =
    typeof license === "string"
      ? license
      : Array.isArray(license)
        ? license.map((entry) => entry?.type ?? entry).join(" ")
        : (license?.type ?? "");
  return GPL.test(text);
}

/** Lists every package under a node_modules tree whose license is the GPL. */
export function gplPackagesIn(nodeModules) {
  const found = [];
  // pnpm links packages into its store, so links are followed; each real
  // directory is read once, which also ends link cycles.
  const seen = new Set();
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        // A dangling link.
      }
      if (!isDir) continue;
      if (name.startsWith("@") || name === ".pnpm" || name === "node_modules") {
        visit(path);
        continue;
      }
      const manifest = join(path, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8"));
          if (isGplLicense(pkg.license ?? pkg.licenses) || pkg.name === "cycletls") {
            found.push(`${pkg.name}@${pkg.version} (${path})`);
          }
        } catch {
          // Not a package manifest.
        }
      }
      visit(join(path, "node_modules"));
    }
  };
  visit(nodeModules);
  return found.sort();
}

/** Lists the npm packages a bundle's metafile says are GPL code in it. */
export function gplInputsIn(metafile, { root, read = (path) => readFileSync(path, "utf8") }) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  const found = [];
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(read(join(root, dir, "package.json")));
      if (isGplLicense(pkg.license ?? pkg.licenses) || pkg.name === "cycletls") {
        found.push(`${pkg.name}@${pkg.version} (${dir})`);
      }
    } catch {
      // A path esbuild resolved without a manifest of its own.
    }
  }
  return found.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const offenders = [];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!value) {
      process.stderr.write(`${flag} needs a value\n`);
      process.exit(2);
    }
    if (flag === "--node-modules") {
      offenders.push(...gplPackagesIn(resolve(value)));
    } else if (flag === "--metafile") {
      const metafile = JSON.parse(readFileSync(value, "utf8"));
      // esbuild records inputs relative to its working directory, which is
      // where this runs from.
      offenders.push(...gplInputsIn(metafile, { root: process.cwd() }));
    } else {
      process.stderr.write(`unknown option ${flag}\n`);
      process.exit(2);
    }
  }
  if (offenders.length > 0) {
    process.stderr.write(`GPL JavaScript would run inside the CLI:\n  ${offenders.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write("No GPL JavaScript in the CLI's runtime\n");
}
