// Copies the installers `tauri build` wrote for this machine into one folder under their release
// asset names (#1025), so the workflow uploads exactly the files the release expects.
//
//   node scripts/collectInstallers.mjs --bundles
//       prints this machine's Tauri bundle list for `tauri build --bundles`
//   node scripts/collectInstallers.mjs --version X.Y.Z --out <dir>
//       copies each installer to <dir>/lurkloot-desktop-X.Y.Z-<target><ext>
//
// The target table, and with it the asset names, is scripts/release/pipeline.mjs's, which is also
// what the release checks its assets against.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  desktopInstallerName,
  desktopInstallerTarget,
} from "../../../scripts/release/pipeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(here, "../src-tauri/target/release/bundle");

/** The one file in `dir` whose name ends with `suffix`. */
function findInstaller(dir, suffix) {
  const matches = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(suffix) && statSync(join(dir, name)).isFile())
    : [];
  if (matches.length !== 1) {
    throw new Error(`expected one *${suffix} in ${dir}, found ${matches.length}`);
  }
  return join(dir, matches[0]);
}

/** Copies the target's installers out of `bundles` into `out`; returns the asset names. */
function collectInstallers({ version, target, bundles = bundleRoot, out }) {
  mkdirSync(out, { recursive: true });
  return target.installers.map((installer) => {
    const source = findInstaller(join(bundles, installer.bundle), installer.suffix);
    const name = desktopInstallerName(version, target, installer);
    copyFileSync(source, join(out, name));
    return name;
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      bundles: { type: "boolean", default: false },
      version: { type: "string" },
      out: { type: "string" },
    },
  });
  const target = desktopInstallerTarget(process.platform, process.arch);
  if (values.bundles) {
    process.stdout.write(`${[...new Set(target.installers.map((i) => i.bundle))].join(",")}\n`);
    return;
  }
  if (!values.version || !values.out) {
    throw new Error("usage: collectInstallers.mjs --bundles | --version X.Y.Z --out <dir>");
  }
  for (const name of collectInstallers({ version: values.version, target, out: values.out })) {
    process.stdout.write(`${name}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`collectInstallers: ${error.message}\n`);
    process.exitCode = 1;
  }
}
