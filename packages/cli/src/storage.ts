import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export async function saveState(path: string, state: SchedulerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
