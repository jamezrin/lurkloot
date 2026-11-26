// Puts CycleTLS's Go binary for this machine in cycletls/ beside the CLI
// bundle (dist/cycletls/ by default), where the CLI starts it
// (src/runtime/standalone.ts, src/transport/cycleTlsClient.ts). CycleTLS is
// GPL-3.0 and runs as a separate program the CLI only talks to over a local
// socket, so only the binary ships, with its license and a NOTICE that links
// its source. The binary comes from the cycletls npm package, a build-time
// dependency whose JavaScript never ships.
//
//   node scripts/copyCycleTls.mjs [<out dir>]
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cycleTlsFileName, cycleTlsNotice, cycleTlsUpstreamName } from "./executable.mjs";

const require = createRequire(import.meta.url);

/** Copies this platform's CycleTLS binary, its license and a NOTICE into outDir. */
export function copyCycleTls(outDir, { platform = process.platform, arch = process.arch } = {}) {
  const packageDir = realpathSync(dirname(require.resolve("cycletls/package.json")));
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const file = cycleTlsFileName(platform);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const binary = join(outDir, file);
  copyFileSync(join(packageDir, "dist", cycleTlsUpstreamName(platform, arch)), binary);
  chmodSync(binary, 0o755);
  const license = readFileSync(join(packageDir, "LICENSE"), "utf8");
  copyFileSync(join(packageDir, "LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(
    join(outDir, "NOTICE"),
    `${cycleTlsNotice({ version: manifest.version, file }).join("\n")}\n`,
  );
  return { file, binary, version: manifest.version, license };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(process.argv[2] ?? join(here, "..", "dist", "cycletls"));
  const { binary, version } = copyCycleTls(out);
  process.stdout.write(`Copied the cycletls ${version} binary to ${binary}\n`);
}
