import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// Atomic: the state is written to a temporary file in the same directory and
// renamed over state.json, so a crash or a full disk mid-write leaves the
// previous state intact instead of a truncated file. Each save uses its own
// temporary file, so concurrent saves never interleave; the last rename wins.
export async function saveState(path: string, state: SchedulerState): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
