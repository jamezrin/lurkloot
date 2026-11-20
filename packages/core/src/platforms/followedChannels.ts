import type { EventEmitter } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import { isSafeFetchError } from "../core/fetchError";
import { StaleWhileRevalidateCache } from "../core/staleCache";
import { KickWafBlockedError } from "../core/transport";
import { diagnostic } from "./adapter";

type LookupFailureCause = "WAF block" | "auth" | "network" | "other";

export function followedChannelFailureCause(error: unknown): LookupFailureCause {
  if (error instanceof KickWafBlockedError && error.challenge) return "WAF block";
  if (!isSafeFetchError(error)) return "other";
  switch (error.failure.kind) {
    case "security_policy_blocked":
      return "WAF block";
    case "authentication_rejected":
      return "auth";
    case "network_error":
      return "network";
    default:
      return "other";
  }
}

// A streak belongs to the cache generation that made the requests. Replacing
// the cache leaves an in-flight lookup unable to change the next one's streak.
export class FollowedChannelsCache extends StaleWhileRevalidateCache<string[]> {
  private failureReported = false;

  constructor(
    private readonly platform: Platform,
    private readonly displayName: string,
  ) {
    super(5 * 60_000);
  }

  recordSuccess(): void {
    this.failureReported = false;
  }

  reportFailure(emit: EventEmitter, cause: LookupFailureCause): void {
    if (this.failureReported) return;
    this.failureReported = true;
    diagnostic(
      emit,
      "warn",
      `${this.displayName} followed-channel lookup failed (${cause})`,
      this.platform,
    );
  }
}
