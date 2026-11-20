import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SchedulerState } from "@lurkloot/shared/models";
import { mergeSchedulerState } from "@lurkloot/core/defaults";

// File-backed scheduler state, the headless analogue of the extension's
// browser.storage layer. Reuses the engine's mergeSchedulerState so a new or
// older state file is normalized the same way the extension normalizes its
// stored state.
export async function loadState(path: string): Promise<SchedulerState> {
  try {
    const text = await readFile(path, "utf8");
    return mergeSchedulerState(JSON.parse(text) as Partial<SchedulerState>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return mergeSchedulerState(undefined);
    }
    throw error;
  }
}

// Room for JSON escaping and older, indented sidecar snapshots.
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

export async function readJsonSidecar(path: string): Promise<unknown> {
  // Inspect the same snapshot we read. A writer publishes changes by rename.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("The sidecar is not a regular file");
    if (stat.size > MAX_SIDECAR_BYTES) throw new Error("The sidecar exceeds 4 MiB");

    // Read at most the snapshot size plus a byte to detect concurrent growth.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return JSON.parse(buffer.toString("utf8", 0, offset)) as unknown;
      offset += bytesRead;
    }
    throw new Error("The sidecar grew while being read");
  } finally {
    await file.close();
  }
}

// Atomic: the text is written to a temporary file in the same directory and
// renamed over the target, so a crash or a full disk mid-write leaves the
// previous file intact instead of a truncated one. Each write uses its own
// temporary file, so concurrent writes never interleave; the last rename wins.
export async function writeJsonAtomically(
  path: string,
  value: unknown,
  mode?: number,
  indent = 2,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, indent)}\n`, { mode, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function saveState(path: string, state: SchedulerState): Promise<void> {
  return writeJsonAtomically(path, state);
}
