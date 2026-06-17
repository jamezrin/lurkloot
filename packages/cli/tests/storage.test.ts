import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../src/storage";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lurkloot-state-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("file-backed state", () => {
  it("returns a normalized default state when the file is missing", async () => {
    const state = await loadState(join(dir, "nope", "state.json"));
    expect(state.sessions.twitch).toBeDefined();
    expect(state.sessions.kick).toBeDefined();
    expect(state.campaigns).toEqual({ twitch: [], kick: [] });
  });

  it("round-trips through save/load and creates parent dirs", async () => {
    const path = join(dir, "nested", "state.json");
    const base = await loadState(path);
    base.sessions.twitch.status = "watching";
    await saveState(path, base);

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.sessions.twitch.status).toBe("watching");

    const reloaded = await loadState(path);
    expect(reloaded.sessions.twitch.status).toBe("watching");
  });

  it("normalizes a partial stored state via mergeSchedulerState", async () => {
    const path = join(dir, "state.json");
    await saveState(path, { sessions: { twitch: { platform: "twitch", offlineChecks: 0, status: "idle" } } } as never);
    const reloaded = await loadState(path);
    // Missing slices are filled in from the defaults.
    expect(reloaded.sessions.kick).toBeDefined();
    expect(reloaded.campaigns).toEqual({ twitch: [], kick: [] });
  });
});
