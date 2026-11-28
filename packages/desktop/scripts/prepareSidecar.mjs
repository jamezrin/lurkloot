// Puts the standalone `lurkloot` executable folder (#1022) where the desktop
// app bundles it: src-tauri/sidecar/, shipped as the app's `sidecar/` resource.
// The whole folder goes, not just the binary: the executable finds the app UI
// (app/), impit (impit/) and cycletls (cycletls/) beside itself.
//
//   node scripts/prepareSidecar.mjs [--skip-build]
//
// It builds the executable for this machine first (the CLI's build:executable
// script) unless --skip-build is passed, which copies the last build.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const cliRoot = resolve(desktopRoot, "../cli");
const target = join(desktopRoot, "src-tauri", "sidecar");

if (!process.argv.includes("--skip-build")) {
  execFileSync("pnpm", ["--filter", "@lurkloot/cli", "build:executable"], {
    cwd: cliRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const built = join(cliRoot, "dist", "executable");
const folders = existsSync(built)
  ? readdirSync(built).filter((entry) => statSync(join(built, entry)).isDirectory())
  : [];
if (folders.length !== 1) {
  process.stderr.write(
    `Expected one executable folder in ${built}, found ${folders.length}; run pnpm --filter @lurkloot/cli build:executable\n`,
  );
  process.exit(1);
}
const source = join(built, folders[0]);
const executable = process.platform === "win32" ? "lurkloot.exe" : "lurkloot";
if (!existsSync(join(source, executable))) {
  process.stderr.write(`No ${executable} in ${source}\n`);
  process.exit(1);
}

// Everything but the folder's README, which git keeps so the resource exists.
for (const entry of existsSync(target) ? readdirSync(target) : []) {
  if (entry !== "README.md") rmSync(join(target, entry), { recursive: true, force: true });
}
// cpSync keeps file modes, so lurkloot and cycletls/cycletls stay executable.
cpSync(source, target, { recursive: true });
process.stdout.write(`Copied ${source} to ${target}\n`);
