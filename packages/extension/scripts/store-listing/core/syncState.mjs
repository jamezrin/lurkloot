import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashFile } from "./provenance.mjs";

// What the last *verified* sync left on the dashboard: the hash of each local
// image and the thumbnail ids the dashboard showed for it afterwards. A later
// sync skips a language only when both still match, so an image edited locally
// is uploaded again and an image changed by hand on the dashboard is replaced,
// instead of either being trusted by a count.
export const SYNC_STATE_FILE = "sync-state.json";
const SCHEMA = 1;

export async function readSyncState(dir, listing) {
  let text;
  try {
    text = await readFile(join(dir, SYNC_STATE_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState(listing);
    throw error;
  }
  const state = JSON.parse(text);
  if (state.schema !== SCHEMA || state.listing !== listing.name) return emptyState(listing);
  return state;
}

function emptyState(listing) {
  return { schema: SCHEMA, listing: listing.name, locales: {} };
}

export async function hashFiles(files) {
  const hashes = {};
  for (const { path } of files) hashes[basename(path)] = await hashFile(path);
  return hashes;
}

// The group a language's own artwork is read from: the source language keeps
// its images in the shared group, every other language in its own.
export function syncedGroup(listing, locale) {
  return locale === listing.globalScreenshotsFrom ? "global" : "localized";
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

export async function recordSync({ dir, listing, entries, now = () => new Date() }) {
  const state = await readSyncState(dir, listing);
  const syncedAt = now().toISOString();
  for (const [locale, { files, thumbnails }] of entries) {
    state.locales[locale] = { files, thumbnails, syncedAt };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SYNC_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}
