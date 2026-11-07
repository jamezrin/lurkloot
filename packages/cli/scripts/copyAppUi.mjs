// Copies the built app UI (@lurkloot/app-ui's dist/) beside the CLI bundle, to
// dist/app/, where `lurkloot serve` looks for it (src/runtime/appAssets.ts).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../app-ui/dist");
const target = resolve(here, "../dist/app");

if (!existsSync(resolve(source, "index.html"))) {
  process.stderr.write(`No app UI build in ${source}; run pnpm --filter @lurkloot/app-ui build\n`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
process.stdout.write(`Copied the app UI to ${target}\n`);
