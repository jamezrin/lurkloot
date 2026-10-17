import { afterEach, describe, expect, it, vi } from "vitest";
import type { KickAccountProgress, SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { ACCOUNT_PROGRESS_ALARM_NAME } from "@lurkloot/core/controller";
import { DEFAULT_STATE } from "../../src/core/storage";
import {
  allDiagnostics,
  deferred,
  farming,
  harness,
  notFarming,
} from "../helpers/backgroundController";

// The account-progress service: its own job reads each platform's account
// progress, so no tick ever waits on it.

const progress: KickAccountProgress = {
  platform: "kick",
  level: 56,
  progressXp: 7146,
  xpToNextLevel: 4636,
  streakDays: 25,
};

function signedIn(extra: Partial<SchedulerState> = {}): SchedulerState {
  return {
    ...structuredClone(DEFAULT_STATE),
    authHealth: { twitch: { status: "healthy" }, kick: { status: "healthy" } },
    ...extra,
  };
}

const runJob = (env: ReturnType<typeof harness>) =>
  env.controller.runJob(ACCOUNT_PROGRESS_ALARM_NAME);

describe("account progress job", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is ensured with the cadence jobs, every minute", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.ensureCadenceJobs();
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ACCOUNT_PROGRESS_ALARM_NAME, {
      periodInMinutes: 1,
    });
  });

  it("reads and stores the progress of each signed-in platform that has it", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    env.kick.fetchAccountProgress = vi.fn(async () => progress);

    await runJob(env);

    expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce();
    const poll = env.state.accountProgress?.kick;
    expect(poll?.progress).toEqual(progress);
    expect(poll?.fetchedAt).toBe(poll?.lastCheckedAt);
    // Twitch has no account progress, so nothing is stored for it.
    expect(env.state.accountProgress?.twitch).toBeUndefined();
  });

  it("never runs inside a tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    env.kick.fetchAccountProgress = vi.fn(async () => progress);

    await env.controller.tick(["kick"]);

    expect(env.kick.fetchAccountProgress).not.toHaveBeenCalled();
  });

  it("does not hold a tick while a read is in flight", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    const read = deferred<KickAccountProgress | undefined>();
    env.kick.fetchAccountProgress = vi.fn(async () => read.promise);

    const reading = runJob(env);
    await vi.waitFor(() => expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce());
    // The tick takes the Kick state lock; it only finishes if the job holds none.
    await env.controller.tick(["kick"]);
    read.resolve(progress);
    await reading;

    expect(env.state.accountProgress?.kick?.progress).toEqual(progress);
  });

  it("reads at most once per interval, and once at a time", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    const read = deferred<KickAccountProgress | undefined>();
    env.kick.fetchAccountProgress = vi.fn(async () => read.promise);

    const first = runJob(env);
    await vi.waitFor(() => expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce());
    await runJob(env);
    read.resolve(progress);
    await first;
    await runJob(env);

    expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce();
  });

  it("reads again once the interval has passed, and right away after a clock rollback", async () => {
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    for (const lastCheckedAt of [stale, future]) {
      const env = harness(farming(DEFAULT_SETTINGS), {
        initialState: signedIn({ accountProgress: { kick: { lastCheckedAt } } }),
      });
      env.kick.fetchAccountProgress = vi.fn(async () => progress);
      await runJob(env);
      expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce();
    }
  });

  it("keeps the last good read when a read fails, without touching auth or the session", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const env = harness(farming(DEFAULT_SETTINGS), {
      initialState: signedIn({
        accountProgress: { kick: { lastCheckedAt: old, fetchedAt: old, progress } },
      }),
    });
    env.kick.fetchAccountProgress = vi.fn(async () => {
      throw new SafeFetchError({ kind: "security_policy_blocked", status: 403 });
    });
    const before = structuredClone(env.state);

    await runJob(env);

    const poll = env.state.accountProgress?.kick;
    expect(poll).toMatchObject({ fetchedAt: old, progress });
    expect(poll?.lastCheckedAt).not.toBe(old);
    expect(env.state.authHealth).toEqual(before.authHealth);
    expect(env.state.sessions).toEqual(before.sessions);
    expect(allDiagnostics(env)).toContainEqual(
      expect.objectContaining({
        level: "debug",
        platform: "kick",
        message: expect.stringContaining("Account progress read failed"),
      }),
    );
  });

  it("keeps the last good read when the platform answers with nothing readable", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const env = harness(farming(DEFAULT_SETTINGS), {
      initialState: signedIn({
        accountProgress: { kick: { lastCheckedAt: old, fetchedAt: old, progress } },
      }),
    });
    env.kick.fetchAccountProgress = vi.fn(async () => undefined);

    await runJob(env);

    expect(env.state.accountProgress?.kick).toMatchObject({ fetchedAt: old, progress });
  });

  it("builds a platform's adapter once to learn it has no account progress", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    env.kick.fetchAccountProgress = vi.fn(async () => progress);
    const twitchBuilds = () =>
      env.deps.createAdapter.mock.calls.filter(([platform]) => platform === "twitch").length;

    await runJob(env);
    await runJob(env);
    await runJob(env);

    expect(twitchBuilds()).toBe(1);
    expect(env.state.accountProgress?.twitch).toBeUndefined();
  });

  it("reads nothing for a platform that is off or signed out", async () => {
    const off = harness(notFarming(DEFAULT_SETTINGS), { initialState: signedIn() });
    off.kick.fetchAccountProgress = vi.fn(async () => progress);
    await runJob(off);
    expect(off.kick.fetchAccountProgress).not.toHaveBeenCalled();

    const signedOut = harness(farming(DEFAULT_SETTINGS), {
      initialState: signedIn({
        authHealth: { twitch: { status: "healthy" }, kick: { status: "missing_credentials" } },
      }),
    });
    signedOut.kick.fetchAccountProgress = vi.fn(async () => progress);
    await runJob(signedOut);
    expect(signedOut.kick.fetchAccountProgress).not.toHaveBeenCalled();
  });

  it("commits nothing from a read that shutdown aborted", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { initialState: signedIn() });
    const read = deferred<KickAccountProgress | undefined>();
    env.kick.fetchAccountProgress = vi.fn(async () => read.promise);

    const reading = runJob(env);
    await vi.waitFor(() => expect(env.kick.fetchAccountProgress).toHaveBeenCalledOnce());
    env.controller.shutdown();
    read.resolve(progress);
    await reading;

    expect(env.state.accountProgress?.kick).toBeUndefined();
  });
});
