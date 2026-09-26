import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { managedTabBreakerOpen, syncManagedTabBreakers } from "@lurkloot/core/tabs";
import { TAB_CHURN_LIMIT } from "@lurkloot/core/criticalHealth";
import { campaign, farming, harness, notFarming } from "../helpers/backgroundController";

// One platform tick: critical health and no-op persistence.

describe("background controller critical health", () => {
  afterEach(() => {
    syncManagedTabBreakers({});
  });

  it("records page context opens into the critical health detector", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    // Adapters are constructed with the tick's emitter before discovery runs, so
    // the last recorded call carries the live emitter for this tick.
    const emitFromTick = (): EventEmitter => env.deps.createAdapter.mock.calls.at(-1)![1];
    env.kick.refreshCampaigns = vi.fn(async () => {
      emitFromTick()({
        category: "activity",
        code: "page_context_opened",
        level: "info",
        platform: "kick",
        data: { host: "kick.com", reason: "background_rejected" },
      });
      return [campaign("kick")];
    });

    await env.controller.tick(["kick"]);

    // This tick also opens a watch tab for the discovered campaign, and watch
    // tabs share the churn window with page contexts by design — so assert the
    // page-context breadcrumb specifically rather than assuming it is the only one.
    expect(env.state.criticalHealth?.kick?.records).toContainEqual(
      expect.objectContaining({ kind: "context_open", code: "background_rejected" }),
    );
    expect(env.state.criticalHealth?.kick?.managedTabOpens.length).toBeGreaterThanOrEqual(1);
  });

  it("opens the breaker and syncs the registry after repeated page context opens", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const emitFromTick = (): EventEmitter => env.deps.createAdapter.mock.calls.at(-1)![1];
    env.kick.refreshCampaigns = vi.fn(async () => {
      emitFromTick()({
        category: "activity",
        code: "page_context_opened",
        level: "info",
        platform: "kick",
        data: { host: "kick.com", reason: "background_rejected" },
      });
      return [campaign("kick")];
    });

    for (let index = 0; index < TAB_CHURN_LIMIT; index += 1) {
      await env.controller.tick(["kick"]);
    }

    expect(env.state.criticalHealth?.kick?.breakerOpen).toBe(true);
    expect(managedTabBreakerOpen("kick")).toBe(true);
  });
});

describe("no-op tick persistence", () => {
  // The scheduler's disabled branch rebuilds the same session on every pass, so
  // consecutive ticks differ only by the freshly stamped lastTickAt, which is
  // display-only. Both tick alarms are created regardless of whether the
  // platform is enabled, so without a guard this rewrites storage forever.
  it("stops rewriting state once a disabled platform's tick decides nothing", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, criticalFailurePromptEnabled: false }));
    // tick() returns as soon as the tick commits, while handleMessage's harness
    // wrapper settles first. Settle explicitly, or a straggling background write
    // lands between the reads below and makes the assertions race.
    const settledTick = async () => {
      await env.controller.tick(["twitch"]);
      await env.controller.settleBackgroundWork();
    };

    await settledTick();
    const writesAfterFirstTick = env.deps.saveState.mock.calls.length;
    const settledTickAt = env.state.lastTickAt;
    expect(writesAfterFirstTick).toBeGreaterThan(0);
    expect(env.state.sessions.twitch.reasonCode).toBe("automation_disabled");

    await settledTick();
    await settledTick();

    expect(env.deps.saveState).toHaveBeenCalledTimes(writesAfterFirstTick);
    expect(env.state.lastTickAt).toBe(settledTickAt);
    env.controller.shutdown();
  });

  // The disabled branch reports an inconclusive observation, which clears
  // lastObservedAt rather than restamping it. Before that distinction existed
  // the critical health slice changed on every tick and this guard could never
  // fire in the default configuration.
  it("stops rewriting state with the critical failure prompt enabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, criticalFailurePromptEnabled: true }));
    const settledTick = async () => {
      await env.controller.tick(["twitch"]);
      await env.controller.settleBackgroundWork();
    };

    await settledTick();
    const writesAfterFirstTick = env.deps.saveState.mock.calls.length;
    expect(env.state.criticalHealth?.twitch?.lastObservedAt).toBeUndefined();

    // A full alarm period apart, so this is not passing because two ticks
    // landed in the same millisecond.
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await settledTick();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await settledTick();

    expect(env.deps.saveState).toHaveBeenCalledTimes(writesAfterFirstTick);
    vi.useRealTimers();
    env.controller.shutdown();
  });

  it("resumes writing when a later tick has something to record", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, criticalFailurePromptEnabled: false }));

    await env.controller.tick(["twitch"]);
    await env.controller.settleBackgroundWork();
    await env.controller.tick(["twitch"]);
    await env.controller.settleBackgroundWork();
    const settledWrites = env.deps.saveState.mock.calls.length;

    await env.controller.handleMessage({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: true,
    });

    expect(env.deps.saveState.mock.calls.length).toBeGreaterThan(settledWrites);
    env.controller.shutdown();
  });
});
