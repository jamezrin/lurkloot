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
import { execFileSync } from "node:child_process";
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

/** The one file (or, for a folder bundle, folder) in `dir` whose name ends with `suffix`. */
function findInstaller(dir, suffix, folder) {
  const matches = existsSync(dir)
    ? readdirSync(dir).filter((name) => {
        if (!name.endsWith(suffix)) return false;
        const stat = statSync(join(dir, name));
        return folder ? stat.isDirectory() : stat.isFile();
      })
    : [];
  if (matches.length !== 1) {
    throw new Error(`expected one *${suffix} in ${dir}, found ${matches.length}`);
  }
  return matches[0];
}

/** Copies the target's installers out of `bundles` into `out`; returns the asset names. */
function collectInstallers({ version, target, bundles = bundleRoot, out }) {
  mkdirSync(out, { recursive: true });
  return target.installers.map((installer) => {
    const dir = join(bundles, installer.dir ?? installer.bundle);
    const source = findInstaller(dir, installer.suffix, installer.archive === true);
    const name = desktopInstallerName(version, target, installer);
    if (installer.archive) {
      // The macOS update (#1028): the .app at the archive's root, which is where the updater
      // looks. COPYFILE_DISABLE keeps macOS tar from adding ._ files for extended attributes,
      // which would land inside the installed app; modes, symlinks and the ad-hoc signature are
      // kept.
      execFileSync("tar", ["-czf", join(out, name), "-C", dir, source], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: "inherit",
      });
    } else {
      copyFileSync(join(dir, source), join(out, name));
    }
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
