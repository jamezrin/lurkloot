import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Captured images say nothing about which build they show. The manifest written
// next to them records that, so a sync can refuse stale or hand-edited files
// instead of publishing them.
export const CAPTURE_MANIFEST_FILE = "capture-manifest.json";
const SCHEMA = 1;

export async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function gitProvenance({ cwd, exec = execFileAsync } = {}) {
  const run = async (args) => (await exec("git", args, { cwd })).stdout.trim();
  const commit = await run(["rev-parse", "HEAD"]);
  // Ignored paths, such as the capture output itself, do not count as changes.
  const dirty = (await run(["status", "--porcelain"])).length > 0;
  return { commit, dirty };
}

export async function readCaptureManifest(dir) {
  let text;
  try {
    text = await readFile(join(dir, CAPTURE_MANIFEST_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const manifest = JSON.parse(text);
  if (manifest.schema !== SCHEMA) {
    throw new Error(`${CAPTURE_MANIFEST_FILE} has schema ${manifest.schema}; expected ${SCHEMA}`);
  }
  return manifest;
}

// Replaces the entries for the captured locales and keeps the others, because a
// capture of a few languages must not erase what an earlier run recorded.
export async function recordCapture({
  dir,
  listing,
  locales,
  version,
  git,
  now = () => new Date(),
}) {
  const existing = await readCaptureManifest(dir);
  const manifest =
    existing && existing.listing === listing.name
      ? existing
      : { schema: SCHEMA, listing: listing.name, locales: {} };
  const capturedAt = now().toISOString();
  for (const locale of locales) {
    const files = {};
    for (const variant of listing.screenshots) {
      const name = listing.screenshotFilename(variant);
      files[name] = await hashFile(join(dir, locale, name));
    }
    manifest.locales[locale] = {
      version,
      commit: git.commit,
      dirty: git.dirty,
      capturedAt,
      files,
    };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CAPTURE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Returns the one version every requested locale was captured from, or throws
// listing everything wrong at once so a single recapture can fix it.
export async function checkCaptureProvenance({
  manifest,
  listing,
  locales,
  filesByLocale,
  expectedVersion,
  allowVersionMismatch = false,
  allowDirty = false,
}) {
  if (!manifest) {
    throw new Error(
      `No ${CAPTURE_MANIFEST_FILE} beside the screenshots, so their build is unknown. Capture them with ${listing.command} capture.`,
    );
  }
  if (manifest.listing !== listing.name) {
    throw new Error(
      `${CAPTURE_MANIFEST_FILE} was written for ${manifest.listing}, not ${listing.name}`,
    );
  }

  const problems = [];
  const versions = new Map();
  for (const locale of locales) {
    const entry = manifest.locales[locale];
    if (!entry) {
      problems.push(`${locale}: not captured (no manifest entry)`);
      continue;
    }
    versions.set(locale, entry.version);
    for (const { path } of filesByLocale?.get(locale) ?? []) {
      const name = path.split(/[\\/]/).pop();
      if (entry.files[name] !== (await hashFile(path))) {
        problems.push(`${locale}: ${name} changed since it was captured`);
      }
    }
    if (entry.dirty && !allowDirty) {
      problems.push(
        `${locale}: captured from a working tree with uncommitted changes (commit ${entry.commit.slice(0, 8)}); pass --allow-dirty to accept`,
      );
    }
    if (!allowVersionMismatch && expectedVersion && entry.version !== expectedVersion) {
      problems.push(
        `${locale}: captured from ${entry.version}, but this checkout is ${expectedVersion}`,
      );
    }
  }
  const distinct = new Set(versions.values());
  if (!allowVersionMismatch && distinct.size > 1) {
    problems.push(
      `locales come from different versions (${[...versions].map(([locale, version]) => `${locale} ${version}`).join(", ")}); capture them together`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Screenshot provenance check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nPass --allow-version-mismatch to accept a version difference.`,
    );
  }
  return {
    versions: [...distinct],
    commits: [...new Set(locales.map((l) => manifest.locales[l].commit))],
  };
}
