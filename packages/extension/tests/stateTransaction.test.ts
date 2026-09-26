import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommittedChange,
  createStateTransaction,
  LockOrderError,
  settingsPatchEffects,
} from "@lurkloot/core/background/stateTransaction";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";
import { LOCKED_IO_ALLOWLIST } from "./helpers/lockedIo";
import { allowlistedCallSite, createTestLockTracker } from "./helpers/lockTracker";

// The state transaction (#585): commit results, lock order, nested commits,
// locked-I/O detection, after-commit hooks and settings effects.

function store(initialSettings: ExtensionSettings = DEFAULT_SETTINGS) {
  let settings = initialSettings;
  let state: SchedulerState = {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
  const tracker = createTestLockTracker();
  const ports = {
    loadSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      settings = next;
    }),
    loadState: vi.fn(async () => state),
    saveState: vi.fn(async (next: SchedulerState) => {
      state = next;
    }),
    applySettingsPatch,
    lockTracker: tracker,
  };
  const transaction = createStateTransaction<ExtensionSettings>(ports);
  return { transaction, ports, tracker, state: () => state, settings: () => settings };
}

function watching(state: SchedulerState, message: string): SchedulerState {
  return {
    ...state,
    sessions: { ...state.sessions, twitch: { ...state.sessions.twitch, message } },
  };
}

describe("state transaction", () => {
  describe("commit", () => {
    it("reports accepted, unchanged and stale commits", async () => {
      const { transaction, ports } = store();

      const accepted = await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "one"));
      expect(accepted.status).toBe("accepted");
      expect(ports.saveState).toHaveBeenCalledTimes(1);

      const unchanged = await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "one"));
      expect(unchanged.status).toBe("unchanged");
      const nothing = await transaction.commit(["twitch"], undefined, () => undefined);
      expect(nothing.status).toBe("unchanged");

      const aborted = new AbortController();
      aborted.abort();
      const mutate = vi.fn((latest: SchedulerState) => watching(latest, "two"));
      expect((await transaction.commit(["twitch"], aborted.signal, mutate)).status).toBe("stale");
      expect((await transaction.commit(["twitch"], () => false, mutate)).status).toBe("stale");
      expect(mutate).not.toHaveBeenCalled();
      expect(ports.saveState).toHaveBeenCalledTimes(1);
    });

    it("merges one platform's snapshot without touching the other", async () => {
      const { transaction, state } = store();
      await transaction.commit(["kick"], undefined, (latest) => ({
        ...latest,
        sessions: { ...latest.sessions, kick: { ...latest.sessions.kick, message: "kick" } },
      }));
      const snapshot = watching(DEFAULT_STATE as SchedulerState, "twitch");

      const result = await transaction.commitPlatformSnapshot("twitch", {
        ...snapshot,
        sessions: { ...snapshot.sessions, twitch: { platform: "twitch", status: "idle", offlineChecks: 0, message: "twitch" } },
      });

      expect(result.status).toBe("accepted");
      expect(state().sessions.twitch.message).toBe("twitch");
      expect(state().sessions.kick.message).toBe("kick");
    });

    it("does not write or notify when storage fails", async () => {
      const { transaction, ports } = store();
      const hook = vi.fn();
      transaction.onCommit(hook);
      ports.saveState.mockRejectedValueOnce(new Error("storage unavailable"));

      await expect(transaction.commit(["twitch"], undefined, (latest) => watching(latest, "lost")))
        .rejects.toThrow("storage unavailable");
      await transaction.settleCommitHooks();

      expect(hook).not.toHaveBeenCalled();
      expect((await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "kept"))).status)
        .toBe("accepted");
    });
  });

  describe("lock order", () => {
    it("rejects a lock taken out of order and records it", async () => {
      const { transaction, tracker } = store();

      await expect(transaction.withPlatformLock("twitch", () => transaction.withSettingsLock(async () => "never")))
        .rejects.toBeInstanceOf(LockOrderError);
      await expect(transaction.withStateLock(() => transaction.withPlatformLock("twitch", async () => "never"), ["kick"]))
        .rejects.toThrow("acquiring twitch while holding kick");

      expect(tracker.violations.map((violation) => violation.message)).toEqual([
        "Lock order violation: acquiring settings while holding twitch",
        "Lock order violation: acquiring twitch while holding kick",
      ]);
    });

    it("accepts locks taken in order", async () => {
      const { transaction, tracker } = store();

      const result = await transaction.withSettingsLock(() => transaction.withStateLock(() =>
        transaction.commit(["twitch", "kick"], undefined, (latest) => watching(latest, "ordered"))));

      expect(result.status).toBe("accepted");
      expect(tracker.violations).toEqual([]);
    });

    it("fails a commit nested inside a commit", async () => {
      const { transaction, tracker } = store();
      let nested: Promise<unknown> | undefined;

      await transaction.commit(["twitch"], undefined, (latest) => {
        nested = transaction.commit(["twitch"], undefined, () => undefined);
        return watching(latest, "outer");
      });

      await expect(nested).rejects.toThrow("Nested state commit");
      expect(tracker.violations).toHaveLength(1);
    });

    it("does not treat work detached from a lock as holding it", async () => {
      const { transaction, tracker } = store();
      let detached: Promise<unknown> | undefined;
      await transaction.withPlatformLock("kick", async () => {
        detached = transaction.detach(() => transaction.withPlatformLock("twitch", async () => "ok"));
      });

      await expect(detached).resolves.toBe("ok");
      expect(tracker.violations).toEqual([]);
    });
  });

  describe("locked I/O", () => {
    it("fails a port called under a lock from a call site missing from the allowlist", async () => {
      const { transaction, tracker } = store();
      const port = tracker.guardPort("deps.createAlarm", vi.fn(async () => undefined));

      await port();
      expect(tracker.violations).toEqual([]);

      await transaction.withSettingsLock(() => port());
      expect(tracker.violations.map((violation) => violation.message)).toEqual([
        "deps.createAlarm called while holding settings",
      ]);
    });

    it("accepts a port called under a lock from an allowlisted call site", () => {
      const here = dirname(fileURLToPath(import.meta.url));
      for (const entry of LOCKED_IO_ALLOWLIST) {
        const path = resolve(here, "../../core/src", entry.file);
        const line = readFileSync(path, "utf8").split("\n").findIndex((source) => source.includes(entry.call)) + 1;
        expect(line, entry.id).toBeGreaterThan(0);
        expect(allowlistedCallSite(`Error\n    at run (${path}:${line}:7)`), entry.id).toBe(true);
      }
      const unlisted = resolve(here, "../../core/src/background/stateTransaction.ts");
      expect(allowlistedCallSite(`Error\n    at run (${unlisted}:1:1)`)).toBe(false);
    });
  });

  describe("after-commit hooks", () => {
    it("calls each hook once per accepted commit, in registration order, after the locks are released", async () => {
      const { transaction, tracker } = store();
      const calls: string[] = [];
      transaction.onCommit(async (change) => {
        expect(tracker.held()).toEqual([]);
        // The committing operation's platform lock is free again.
        await transaction.withPlatformLock("twitch", async () => undefined);
        calls.push(`first:${change.kind}`);
      });
      transaction.onCommit((change) => {
        calls.push(`second:${change.kind}`);
      });

      await transaction.withStateLock(async () => {
        await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "hooked"));
        await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "hooked"));
        const aborted = new AbortController();
        aborted.abort();
        await transaction.commit(["twitch"], aborted.signal, (latest) => watching(latest, "stale"));
        expect(calls).toEqual([]);
      }, ["twitch"]);
      await transaction.settleCommitHooks();

      expect(calls).toEqual(["first:state", "second:state"]);
      expect(tracker.violations).toEqual([]);
    });

    it("queues a hook's own commit behind the one it observes", async () => {
      const { transaction, tracker, state } = store();
      const seen: string[] = [];
      transaction.onCommit(async (change) => {
        if (change.kind !== "state") return;
        seen.push(change.state.sessions.twitch.message ?? "");
        if (change.state.sessions.twitch.message === "first") {
          await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "from hook"));
        }
      });

      await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "first"));
      await transaction.settleCommitHooks();
      await transaction.settleCommitHooks();

      expect(seen).toEqual(["first", "from hook"]);
      expect(state().sessions.twitch.message).toBe("from hook");
      expect(tracker.violations).toEqual([]);
    });

    it("stops calling a hook once it is unregistered and survives a failing hook", async () => {
      const { transaction } = store();
      const failing = vi.fn(() => {
        throw new Error("hook failed");
      });
      const later = vi.fn();
      const unregister = transaction.onCommit(failing);
      transaction.onCommit(later);

      await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "one"));
      await transaction.settleCommitHooks();
      unregister();
      await transaction.commit(["twitch"], undefined, (latest) => watching(latest, "two"));
      await transaction.settleCommitHooks();

      expect(failing).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledTimes(2);
    });
  });

  describe("settings commits", () => {
    it("reads settings once and returns each platform's effect", async () => {
      const { transaction, ports, settings } = store();
      const changes: CommittedChange<ExtensionSettings>[] = [];
      transaction.onCommit((change) => {
        changes.push(change);
      });

      const commit = await transaction.withSettingsLock(async () => {
        const prepared = await transaction.prepareSettingsCommit(() => ({ priorityMode: "lowest_availability" }));
        await transaction.saveSettingsCommit(prepared);
        return prepared;
      });
      await transaction.settleCommitHooks();

      expect(ports.loadSettings).toHaveBeenCalledTimes(1);
      expect(commit.effects).toEqual({ twitch: "selection", kick: "selection" });
      expect(settings().priorityMode).toBe("lowest_availability");
      expect(changes).toEqual([expect.objectContaining({ kind: "settings", effects: commit.effects })]);
    });

    it("requires the settings lock", async () => {
      const { transaction, tracker } = store();

      await expect(transaction.prepareSettingsCommit(() => ({}))).rejects.toBeInstanceOf(LockOrderError);
      expect(tracker.violations).toHaveLength(1);
    });

    it("classifies a patch per platform, with anything unrecognized invalidating discovery", () => {
      const off = { farmPinnedOnly: false };
      expect(settingsPatchEffects({ platform: { kick: { favouriteCategories: [] } } }, off)).toEqual({ kick: "selection" });
      expect(settingsPatchEffects({ platform: { twitch: { idleWatchlistChannels: [] } } }, off)).toEqual({ twitch: "discovery" });
      expect(settingsPatchEffects({ campaignPins: ["a"] }, { farmPinnedOnly: true })).toEqual({ twitch: "discovery", kick: "discovery" });
      expect(settingsPatchEffects({ pollIntervalMinutes: 5 }, off)).toEqual({ twitch: "discovery", kick: "discovery" });
    });
  });
});
