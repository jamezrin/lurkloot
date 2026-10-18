import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

// What the last *verified* sync left on the dashboard: the hash of each local
// image and the thumbnail ids the dashboard showed for it. A later sync skips a
// scope only when both still match, so an image edited locally is uploaded
// again and an image changed by hand on the dashboard is replaced, instead of
// either being trusted by a count. It lives in the bundle directory and is
// never touched by a producer replacing its sections.
export const SYNC_STATE_FILE = "sync-state.json";
const SCHEMA = 1;

export async function readSyncState(dir) {
  let text;
  try {
    text = await readFile(join(dir, SYNC_STATE_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
  const state = JSON.parse(text);
  return state.schema === SCHEMA ? state : emptyState();
}

function emptyState() {
  return { schema: SCHEMA, scopes: {} };
}

export async function hashFiles(files) {
  const hashes = {};
  for (const { path } of files) {
    hashes[basename(path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return hashes;
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isUnchanged({ entry, hashes, liveIds, expectedCount }) {
  if (!entry) return false;
  const names = Object.keys(hashes);
  if (names.length !== expectedCount || liveIds.length !== expectedCount) return false;
  if (Object.keys(entry.files).length !== names.length) return false;
  if (!names.every((name) => entry.files[name] === hashes[name])) return false;
  return sameList(entry.thumbnails, liveIds);
}

export async function recordSync({ dir, entries, now = () => new Date() }) {
  const state = await readSyncState(dir);
  const syncedAt = now().toISOString();
  for (const [scope, { files, thumbnails }] of entries) {
    state.scopes[scope] = { files, thumbnails, syncedAt };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SYNC_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}
