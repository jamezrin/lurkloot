import { describe, expect, it, vi } from "vitest";
import type { CommittedChange } from "@lurkloot/core/controller";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { channel, deferred, farming, harness, notFarming } from "../helpers/backgroundController";

// #695: services react to a settings save through their own commit hooks,
// after the save, rather than being called by the module that saved.
describe("settings commit hooks", () => {
  it("cancels a channel-points claim only once the save disabling Twitch has landed", async () => {
    const save = deferred<void>();
    let holdSave = false;
    const env = harness(farming(DEFAULT_SETTINGS), {
      saveSettings: async () => {
        if (holdSave) await save.promise;
      },
    });
    env.state.authHealth = { ...env.state.authHealth, twitch: { status: "healthy", checkedAt: new Date().toISOString() } };
    env.state.sessions.twitch = { platform: "twitch", status: "watching", channel: channel("twitch"), offlineChecks: 0, watchMode: "tab" };
    let signal: AbortSignal | undefined;
    env.twitch.claimChannelPoints = vi.fn(async (_channel, options) => {
      signal = options?.signal;
      return await new Promise<boolean>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    });

    const job = env.controller.runTwitchChannelPointsClaim();
    await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce());
    holdSave = true;
    const disabling = env.rawController.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { autoClaimChannelPoints: false } } } });
    await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalled());

    expect(signal?.aborted).toBe(false);

    save.resolve();
    await disabling;
    await job;
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error).message).toBe("Channel points claiming disabled");
  });

  it("marks the startup reconcile's settings save so services leave it to the lifecycle", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));
    const changes: CommittedChange<ExtensionSettings>[] = [];
    env.rawController.onCommit((change) => {
      changes.push(change);
    });

    await env.controller.handleStartup();
    await env.controller.settleBackgroundWork();

    const settingsChanges = changes.filter((change) => change.kind === "settings");
    expect(settingsChanges).toHaveLength(1);
    expect(settingsChanges[0]).toMatchObject({ kind: "settings", startup: true });
  });

  // A switch-on's hook lifts the observer block; the follow-up tick must not
  // reconcile the observer before it has run (review of #704).
  it("starts the switch's follow-up tick only once the platform's hooks have run", async () => {
    const env = harness(notFarming(DEFAULT_SETTINGS));
    const held = deferred<void>();
    let holding = true;
    env.rawController.onCommit(async (change) => {
      if (holding && change.kind === "settings") await held.promise;
    });

    const enabling = env.rawController.handleMessage({ type: "setPlatformEnabled", platform: "kick", enabled: true });
    await vi.waitFor(() => expect(env.deps.saveSettings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The tick's first step is the auth probe, so it has not started.
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();

    holding = false;
    held.resolve();
    await enabling;
    await env.rawController.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).toHaveBeenCalled();
  });
});
