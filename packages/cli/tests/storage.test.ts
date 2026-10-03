import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
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

  it("never writes legacy events back to state.json", async () => {
    const path = join(dir, "state.json");
    const state = await loadState(join(dir, "missing.json"));
    await writeFile(path, JSON.stringify({ ...state, events: [{ message: "legacy" }] }));

    await saveState(path, await loadState(path));

    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("events");
  });

  it("saves atomically: a failed write leaves the previous state and no temporary file", async () => {
    const path = join(dir, "state.json");
    const previous = await loadState(path);
    previous.sessions.twitch.status = "watching";
    await saveState(path, previous);

    const circular = await loadState(path) as unknown as Record<string, unknown>;
    circular.self = circular;
    await expect(saveState(path, circular as never)).rejects.toThrow();

    expect((await loadState(path)).sessions.twitch.status).toBe("watching");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("replaces state.json by rename, leaving no temporary files after concurrent saves", async () => {
    const path = join(dir, "state.json");
    const states = await Promise.all(["idle", "watching", "paused"].map(async (status) => {
      const state = await loadState(path);
      state.sessions.twitch.status = status as never;
      return state;
    }));
    await Promise.all(states.map((state) => saveState(path, state)));

    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(["idle", "watching", "paused"]).toContain((await loadState(path)).sessions.twitch.status);
  });

  it("does not write through to state.json in place when the rename fails", async () => {
    // A directory at the target path makes the rename fail after the write.
    const path = join(dir, "state.json");
    await mkdir(path);
    await expect(saveState(path, await loadState(join(dir, "missing.json")))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["state.json"]);
  });
});
