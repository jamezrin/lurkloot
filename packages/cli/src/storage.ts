import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionSettings, SchedulerState } from "@stream-autopilot/shared/models";
import { mergeSchedulerState } from "@stream-autopilot/core/defaults";

// File-backed scheduler state for a headless run. Settings come from the loaded
// config (read-only at runtime: the CLI has no popup to change them) and are
// returned verbatim — any `running` override is applied explicitly by the run
// command, not hidden here. Integrity is handled by the AuthStore.
export class FileStorage {
  constructor(
    private readonly stateFile: string,
    private readonly settings: ExtensionSettings,
  ) {}

  async loadSettings(): Promise<ExtensionSettings> {
    return this.settings;
  }

  // No-op-to-disk: settings are owned by the config file. Kept so the controller's
  // optional saveSettings dep is satisfied; in-process changes are not persisted.
  async saveSettings(_settings: ExtensionSettings): Promise<void> {
    // intentionally not persisted
  }

  async loadState(): Promise<SchedulerState> {
    let stored: Partial<SchedulerState> | undefined;
    try {
      stored = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<SchedulerState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return mergeSchedulerState(stored);
  }

  async saveState(state: SchedulerState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
}
