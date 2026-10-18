import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sectionId } from "./bundle.mjs";

const execFileAsync = promisify(execFile);

// Where a producer's output came from, for stampBundle. Only tracked files
// count: a working tree full of untracked scratch directories has not changed
// what was built.
export async function gitProvenance({ cwd, exec = execFileAsync } = {}) {
  const run = async (args) => (await exec("git", args, { cwd })).stdout.trim();
  const commit = await run(["rev-parse", "HEAD"]);
  const dirty = (await run(["status", "--porcelain", "--untracked-files=no"])).length > 0;
  return { commit, dirty };
}

// Artwork shows a build, and a listing that shows the wrong one is worse than
// no update. Returns the versions the requested artwork came from, or throws
// listing everything wrong at once so one regeneration can fix it.
export function checkArtworkSources({
  bundle,
  scopes,
  parts = ["screenshots", "promo"],
  expectedVersion,
  allowVersionMismatch = false,
  allowDirty = false,
}) {
  const problems = [];
  const versions = new Map();
  for (const scope of scopes) {
    for (const part of parts) {
      const id = sectionId(scope, part);
      const entry = bundle.sections[id];
      if (!entry) continue;
      versions.set(id, entry.source.version);
      if (entry.source.dirty && !allowDirty) {
        problems.push(
          `${id}: generated from a working tree with uncommitted changes (commit ${String(entry.source.commit).slice(0, 8)}); pass --allow-dirty to accept`,
        );
      }
      if (!allowVersionMismatch && expectedVersion && entry.source.version !== expectedVersion) {
        problems.push(
          `${id}: generated from ${entry.source.version}, but this checkout is ${expectedVersion}`,
        );
      }
    }
  }
  const distinct = new Set(versions.values());
  if (!allowVersionMismatch && distinct.size > 1) {
    problems.push(
      `sections come from different versions (${[...versions].map(([id, version]) => `${id} ${version}`).join(", ")}); generate them together`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Artwork provenance check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nPass --allow-version-mismatch to accept a version difference.`,
    );
  }
  return { versions: [...distinct] };
}
