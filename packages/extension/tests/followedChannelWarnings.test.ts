import { describe, expect, it, vi } from "vitest";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { KickDiscoveryState } from "@lurkloot/core/kick";
import { KickWafBlockedError, safeKickFailure } from "@lurkloot/core/transport";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import { jsonFetcher, kickAdapter, twitchAdapter } from "./helpers/adapters";

const sensitiveDetail = "Authorization: Bearer test-secret";

function blocked() {
  throw new SafeFetchError({
    kind: "security_policy_blocked",
    status: 403,
    reason: sensitiveDetail,
  });
}

describe.each([
  {
    platform: "kick",
    createLookup: (fetcher: ReturnType<typeof jsonFetcher>, emit: EventEmitter) => {
      const discoveryState = new KickDiscoveryState();
      return () => kickAdapter(fetcher, undefined, emit, { discoveryState });
    },
    success: { data: [] },
    otherFailure: () => {
      throw new SafeFetchError({ kind: "invalid_response", reason: sensitiveDetail });
    },
    networkFailure: () => {
      throw new KickWafBlockedError({ kind: "network_error", reason: sensitiveDetail });
    },
    extraFailures: [
      [
        "WAF block",
        () => {
          throw new KickWafBlockedError(
            `Non-JSON API response (likely a challenge page): ${sensitiveDetail}`,
          );
        },
      ],
      [
        "auth",
        () => {
          throw new SafeFetchError(safeKickFailure(403, `<html>${sensitiveDetail}</html>`));
        },
      ],
    ] as const,
  },
  {
    platform: "twitch",
    createLookup: (fetcher: ReturnType<typeof jsonFetcher>, emit: EventEmitter) => {
      const discoveryState = new TwitchDiscoveryState();
      return () => twitchAdapter(fetcher, undefined, { discoveryState }, emit);
    },
    success: { data: { currentUser: { followedLiveUsers: { edges: [] } } } },
    otherFailure: () => ({ errors: [{ message: sensitiveDetail }] }),
    networkFailure: () => ({
      __twitchGqlError: sensitiveDetail,
      __twitchGqlFailureKind: "network",
    }),
    extraFailures: [],
  },
])(
  "$platform followed-channel warnings",
  ({ platform, createLookup, success, otherFailure, networkFailure, extraFailures }) => {
    const authFailure = () => {
      throw new SafeFetchError({
        kind: "authentication_rejected",
        status: 401,
        reason: sensitiveDetail,
      });
    };

    function warningMessages(events: EngineEvent[]) {
      return events.flatMap((event) =>
        event.category === "diagnostic" && event.level === "warn" && event.platform === platform
          ? [event.message]
          : [],
      );
    }

    it.each([
      ["WAF block", blocked],
      ["auth", authFailure],
      ["network", networkFailure],
      ["other", otherFailure],
      [
        "other",
        () => {
          throw new SafeFetchError({ kind: "http_error", status: 503, reason: sensitiveDetail });
        },
      ],
      ...extraFailures,
    ] as const)("warns with the %s cause without including error details", async (cause, fail) => {
      const events: EngineEvent[] = [];
      const adapter = createLookup(jsonFetcher(fail), (event) => events.push(event))();

      await expect(adapter.listFollowedChannels()).resolves.toEqual([]);
      expect(warningMessages(events)).toEqual([
        expect.stringContaining(`followed-channel lookup failed (${cause})`),
      ]);
      expect(JSON.stringify(events)).not.toMatch(/Authorization|Bearer|test-secret/);
    });

    it("warns once across stale refreshes and adapter rebuilds until an empty lookup succeeds", async () => {
      vi.useFakeTimers();
      try {
        const events: EngineEvent[] = [];
        let finishLookup!: () => void;
        const pendingLookup = new Promise<void>((resolve) => {
          finishLookup = resolve;
        });
        const responses = [
          authFailure,
          blocked,
          () => success,
          () => pendingLookup.then(otherFailure),
        ];
        const fetcher = jsonFetcher(() => responses.shift()?.());
        const adapter = createLookup(fetcher, (event) => events.push(event));
        const refresh = () => adapter().listFollowedChannels({ requireComplete: true });

        await expect(refresh()).resolves.toEqual([]);
        expect(warningMessages(events)).toEqual([expect.stringContaining("(auth)")]);

        vi.advanceTimersByTime(5 * 60_000);
        await expect(Promise.all([refresh(), refresh()])).resolves.toEqual([[], []]);
        expect(fetcher.fetchJson).toHaveBeenCalledTimes(2);
        expect(warningMessages(events)).toHaveLength(1);

        vi.advanceTimersByTime(5 * 60_000);
        await expect(refresh()).resolves.toEqual([]);
        expect(warningMessages(events)).toHaveLength(1);

        vi.advanceTimersByTime(5 * 60_000);
        const warningsAtReturn = refresh().then(() => warningMessages(events));
        await vi.advanceTimersByTimeAsync(0);
        finishLookup();
        expect(fetcher.fetchJson).toHaveBeenCalledTimes(4);
        await expect(warningsAtReturn).resolves.toEqual([
          expect.stringContaining("(auth)"),
          expect.stringContaining("(other)"),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
