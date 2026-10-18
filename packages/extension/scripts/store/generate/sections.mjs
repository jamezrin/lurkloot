import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitProvenance, stampBundle } from "@lurkloot/store-sync";
import { NAME, PATHS } from "../lurkloot.mjs";

// A generator writes a section into a hidden staging directory and moves it into
// place once it is complete, so a failure halfway never leaves a half-written
// section in the bundle. Only the sections it generated are replaced, and the
// sync's own files in the bundle are never touched.
export function stagingPath(bundle, ...segments) {
  return join(bundle, ".generating", ...segments);
}

export async function resetStaging(bundle) {
  await rm(join(bundle, ".generating"), { recursive: true, force: true });
}

export async function installSection(staged, final) {
  await rm(final, { recursive: true, force: true });
  await mkdir(dirname(final), { recursive: true });
  await rename(staged, final);
}

export async function removeSection(final) {
  await rm(final, { recursive: true, force: true });
}

export async function stampGenerated({
  bundle,
  version,
  sections,
  forget = [],
  env = process.env,
}) {
  const extensionId = /^[a-p]{32}$/.test(env.CWS_EXTENSION_ID ?? "")
    ? env.CWS_EXTENSION_ID
    : undefined;
  await stampBundle({
    dir: bundle,
    name: NAME,
    extensionId,
    source: { version, ...(await gitProvenance({ cwd: PATHS.packageRoot })) },
    sections,
    forget,
  });
  await resetStaging(bundle);
}
