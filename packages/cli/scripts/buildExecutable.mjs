// Builds the standalone `lurkloot` executable for the machine it runs on
// (#1022): Node's single-executable application, with the CLI bundled inside,
// so it runs where no Node is installed. Beside it go cycletls's Go binary for
// this platform, the app UI in app/, LICENSE and a NOTICE, and with --archive
// all of it is packed into the release archive for this target.
//
//   node scripts/buildExecutable.mjs [--archive <dir>]
//
// The dist/app bundle must exist first (pnpm run build:app); the package's
// build:executable script does both. The executable is the very node binary
// running this script, so build with the Node version you mean to ship.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";
import {
  cliArchiveBase,
  cliArchiveName,
  cliExecutableTarget,
} from "../../../scripts/release/pipeline.mjs";
import {
  SEA_FUSE,
  SEA_MACHO_SEGMENT,
  SEA_RESOURCE,
  bundledPackages,
  cycleTlsUpstreamName,
  executableName,
  nodeLicenseCandidates,
  renderNotice,
} from "./executable.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "../..");
const require = createRequire(import.meta.url);

const { platform, arch } = process;
const target = cliExecutableTarget(platform, arch);
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const cycleTlsFile = platform === "win32" ? "cycletls.exe" : "cycletls";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

const appDir = join(packageRoot, "dist", "app");
if (!existsSync(join(appDir, "index.html"))) {
  process.stderr.write(`No app UI in ${appDir}; run pnpm run build:app first\n`);
  process.exit(1);
}

const work = join(packageRoot, "dist", "sea");
const out = join(packageRoot, "dist", "executable", cliArchiveBase(version, target));
rmSync(work, { recursive: true, force: true });
rmSync(dirname(out), { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// 1. One CommonJS file with every dependency inside: a single-executable
// application's main script can require only Node's built-in modules. ws's
// optional native add-ons stay out; ws falls back without them. The banner
// gives import.meta.url a value (the executable's own path) for code that
// reads it in this CommonJS output.
const bundle = join(work, "lurkloot.cjs");
const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  mainFields: ["module", "main"],
  outfile: bundle,
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: 'const __lurklootModuleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  define: { "import.meta.url": "__lurklootModuleUrl" },
  metafile: true,
  logLevel: "warning",
});

// 2. The blob Node starts from, made by the same node binary it goes into.
// Paths relative to the work directory, so the script name stack traces show
// is lurkloot.cjs and not this machine's checkout path.
const blob = join(work, "sea-prep.blob");
writeFileSync(
  join(work, "sea-config.json"),
  JSON.stringify(
    { main: "lurkloot.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true },
    null,
    2,
  ),
);
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: work,
  stdio: "inherit",
});

// 3. A copy of this node binary with the blob injected. macOS refuses a
// binary whose signature no longer matches, so the copy is unsigned before the
// injection and signed ad hoc after it, which is all Apple Silicon needs.
const executable = join(out, executableName(platform));
copyFileSync(process.execPath, executable);
chmodSync(executable, 0o755);
if (platform === "darwin") run("codesign", ["--remove-signature", executable]);
await inject(executable, SEA_RESOURCE, readFileSync(blob), {
  sentinelFuse: SEA_FUSE,
  ...(platform === "darwin" ? { machoSegmentName: SEA_MACHO_SEGMENT } : {}),
});
if (platform === "darwin") run("codesign", ["--sign", "-", executable]);

// 4. cycletls's binary for this platform, under the name the CLI looks for
// beside the executable (src/runtime/standalone.ts).
const cycleTlsDir = dirname(require.resolve("cycletls/package.json"));
const cycleTlsManifest = JSON.parse(readFileSync(join(cycleTlsDir, "package.json"), "utf8"));
const cycleTls = join(out, cycleTlsFile);
copyFileSync(join(cycleTlsDir, "dist", cycleTlsUpstreamName(platform, arch)), cycleTls);
chmodSync(cycleTls, 0o755);
if (platform === "darwin") {
  try {
    execFileSync("codesign", ["--verify", cycleTls], { stdio: "ignore" });
  } catch {
    run("codesign", ["--sign", "-", cycleTls]);
  }
}

// 5. The app UI, the license and the notice.
cpSync(appDir, join(out, "app"), { recursive: true });
copyFileSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));
const nodeLicense = nodeLicenseCandidates(process.execPath).find((path) => existsSync(path));
if (!nodeLicense) {
  process.stderr.write(`No Node.js LICENSE beside ${process.execPath}\n`);
  process.exit(1);
}
writeFileSync(
  join(out, "NOTICE"),
  renderNotice({
    version,
    nodeVersion: process.version,
    nodeLicense: readFileSync(nodeLicense, "utf8"),
    cycleTls: {
      file: cycleTlsFile,
      version: cycleTlsManifest.version,
      license: readFileSync(join(cycleTlsDir, "LICENSE"), "utf8"),
    },
    packages: bundledPackages(Object.keys(result.metafile.inputs), { root: packageRoot }),
  }),
);
process.stdout.write(`Built ${relative(process.cwd(), out)}\n`);

// 6. The release archive: tar.gz keeps the executable bits on Linux and macOS;
// Windows gets a zip, from the bsdtar Windows ships (a Git Bash tar cannot
// write one).
const archiveDir = argument("archive");
if (archiveDir) {
  mkdirSync(archiveDir, { recursive: true });
  const archive = resolve(archiveDir, cliArchiveName(version, target));
  rmSync(archive, { force: true });
  const parent = dirname(out);
  const base = cliArchiveBase(version, target);
  if (target.archive === "zip") {
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    run(tar, ["-a", "-c", "-f", archive, "-C", parent, base]);
  } else {
    run("tar", ["-czf", archive, "-C", parent, base]);
  }
  process.stdout.write(`Archived ${archive}\n`);
}
