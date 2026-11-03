import type { Platform } from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../authStore";

// The start/poll shape both device-style logins share (Twitch's device-code
// OAuth and Kick's smart-TV link): a started flow carries what the user must
// open and confirm, and polls once per call. `waitForDeviceApproval` drives the
// polling for the terminal commands and for `serve` alike, so neither duplicates
// a flow.

export type DevicePoll =
  | { status: "pending" }
  // The platform asked for a longer interval (RFC 8628 `slow_down`).
  | { status: "slow_down" }
  | { status: "approved"; token: string };

export interface DeviceLoginFlow {
  platform: Platform;
  // What the user opens and confirms. For Kick the link carries the pairing
  // code, so it is shown to the user only, never logged by `serve`.
  verificationUrl: string;
  userCode: string;
  intervalMs: number;
  expiresInMs: number;
  // The flow's own expiry message, kept as the terminal commands always printed it.
  expiredMessage: string;
  // One poll. Throws on a hard failure; the signal aborts an in-flight request
  // where the platform client supports it.
  poll(signal?: AbortSignal): Promise<DevicePoll>;
  // The credentials to save for an approved token.
  credentials(token: string): PlatformCredentials;
  // Releases what the flow holds (Kick's cycletls subprocess).
  dispose(): Promise<void>;
}

export class DeviceLoginExpiredError extends Error {}

const SLOW_DOWN_STEP_MS = 5000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

// A timer that clears itself when the signal aborts, so a cancelled flow
// leaves no timer behind.
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectSleep(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Polls the flow until it is approved (returning the token) or expires
// (DeviceLoginExpiredError). A hard poll failure and an abort reject as they
// are. `sleep` and `now` are injectable for tests.
export async function waitForDeviceApproval(
  flow: DeviceLoginFlow,
  options: { signal?: AbortSignal; sleep?: Sleep; now?: () => number } = {},
): Promise<string> {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + flow.expiresInMs;
  let intervalMs = flow.intervalMs;
  while (now() < deadline) {
    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();
    const result = await flow.poll(options.signal);
    options.signal?.throwIfAborted();
    if (result.status === "approved") return result.token;
    if (result.status === "slow_down") intervalMs += SLOW_DOWN_STEP_MS;
  }
  throw new DeviceLoginExpiredError(flow.expiredMessage);
}
