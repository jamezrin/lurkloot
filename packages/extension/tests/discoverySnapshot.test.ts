import { describe, expect, it, vi } from "vitest";
import {
  adapterFromDiscoverySnapshot,
  collectDiscoverySnapshot,
  DiscoverySnapshotLane,
  type DiscoveryRefreshMetrics,
  type DiscoveryRefreshResult,
} from "@lurkloot/core/discoverySnapshot";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import type {
  ChannelCandidate,
  DropCampaign,
  Platform,
  SchedulerState,
} from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { createTabRegistry } from "@lurkloot/core/tabRegistry";
import { runSchedulerTick } from "./helpers/schedulerTick";
import { jsonFetcher, kickAdapter, twitchAdapter } from "./helpers/adapters";

const metrics: DiscoveryRefreshMetrics = {
  campaigns: 0,
  candidates: 0,
  cacheHits: 0,
  cacheMisses: 0,
  batchRequests: 0,
  singleFallbacks: 0,
};

const complete = (): DiscoveryRefreshResult => ({
  campaigns: [],
  idleCandidates: [],
  followedChannels: [],
  complete: true,
  metrics,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("DiscoverySnapshotLane", () => {
  it("runs one refresh and retains at most one coalesced pending refresh", async () => {
    const first = deferred<DiscoveryRefreshResult>();
    const second = deferred<DiscoveryRefreshResult>();
    const refresh = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const lane = new DiscoverySnapshotLane("twitch", refresh);

    lane.request();
    lane.request();
    lane.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve(complete());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    second.resolve(complete());
    await lane.settle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(lane.current().snapshot?.revision).toBe(2);
  });

  it("keeps the latest request context with a coalesced refresh", async () => {
    const first = deferred<DiscoveryRefreshResult>();
    const seen: string[] = [];
    const lane = new DiscoverySnapshotLane<string>("twitch", async ({ request }) => {
      seen.push(request);
      if (seen.length === 1) return first.promise;
      return complete();
    });

    lane.request("first-tick");
    lane.request("superseded-tick");
    lane.request("latest-tick");
    first.resolve(complete());
    await lane.settle();

    expect(seen).toEqual(["first-tick", "latest-tick"]);
  });

  it("lets provider lanes complete independently", async () => {
    const twitchRefresh = deferred<DiscoveryRefreshResult>();
    const twitch = new DiscoverySnapshotLane("twitch", () => twitchRefresh.promise);
    const kick = new DiscoverySnapshotLane("kick", async () => complete());

    twitch.request();
    kick.request();
    await kick.settle();
    expect(kick.current().snapshot?.revision).toBe(1);
    expect(twitch.current().snapshot).toBeUndefined();
    twitchRefresh.resolve(complete());
    await twitch.settle();
  });

  it("retains the last coherent snapshot after failed and incomplete attempts", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(complete())
      .mockResolvedValueOnce({
        campaigns: [],
        idleCandidates: [],
        followedChannels: [],
        complete: false,
        failure: "partial",
        metrics,
      })
      .mockRejectedValueOnce(new Error("offline"));
    const lane = new DiscoverySnapshotLane("kick", refresh);

    lane.request();
    await lane.settle();
    const coherent = lane.current().snapshot;
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.failure).toBe("partial");
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot).toBe(coherent);
    expect(lane.current().lastAttempt?.failure).toBe("offline");
  });

  it("keeps what a failed refresh threw, and only that, for the critical-failure detector", async () => {
    const offline = new Error("offline");
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        campaigns: [],
        idleCandidates: [],
        followedChannels: [],
        complete: false,
        failure: "Platform disabled",
        metrics,
      })
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce(complete());
    const lane = new DiscoverySnapshotLane("kick", refresh);

    lane.request();
    await lane.settle();
    expect(lane.current().lastAttempt?.error).toBeUndefined();
    lane.request();
    await lane.settle();
    expect(lane.current().lastAttempt?.error).toBe(offline);
    lane.request();
    await lane.settle();
    expect(lane.current().lastAttempt?.error).toBeUndefined();
  });

  it("does not keep the error of a refresh that was thrown away", async () => {
    const refresh = deferred<DiscoveryRefreshResult>();
    const lane = new DiscoverySnapshotLane("twitch", () => refresh.promise);

    lane.request();
    lane.invalidate();
    refresh.reject(new Error("offline"));
    await lane.settle();

    expect(lane.current().lastAttempt?.discarded).toBe("stale_generation");
    expect(lane.current().lastAttempt?.error).toBeUndefined();
  });

  it("discards an in-flight result after invalidation", async () => {
    const refresh = deferred<DiscoveryRefreshResult>();
    const lane = new DiscoverySnapshotLane("twitch", () => refresh.promise);

    lane.request();
    lane.invalidate();
    refresh.resolve(complete());
    await lane.settle();

    expect(lane.current().snapshot).toBeUndefined();
    expect(lane.current().lastAttempt?.discarded).toBe("stale_generation");
  });

  it("clears a previously committed snapshot when its generation is invalidated", async () => {
    const lane = new DiscoverySnapshotLane("twitch", async () => complete());
    lane.request();
    await lane.settle();

    lane.invalidate();

    expect(lane.current().snapshot).toBeUndefined();
    expect(lane.current().lastAttempt).toBeUndefined();
    lane.request();
    await lane.settle();
    expect(lane.current().snapshot?.revision).toBe(2);
  });
});

describe("collectDiscoverySnapshot", () => {
  describe.each(["kick", "twitch"] as const)("%s campaign channel preference", (platform) => {
    const cases = [
      {
        name: "prefers a followed channel outside the directory over its higher-viewer result (#1076)",
        expected: "friend",
      },
      {
        name: "ranks an outside Watchlist channel first",
        watchlist: ["watched"],
        followed: ["Friend", "Watched"],
        expected: "watched",
      },
      {
        name: "uses viewer order with preference off",
        enabled: false,
        watchlist: ["watched"],
        expected: "popular",
      },
      {
        name: "keeps ACL campaigns restricted",
        acl: true,
        watchlist: ["watched"],
        expected: "popular",
      },
      {
        name: "excludes known channels from drop candidates",
        excluded: ["friend", "watched"],
        watchlist: ["watched"],
        expected: "popular",
      },
      { name: "rejects an offline Watchlist channel", watchlist: ["offline"], expected: "friend" },
      {
        name: "rejects a Watchlist channel in the wrong category",
        watchlist: ["wrong-category"],
        expected: "friend",
      },
      {
        name: "tries a directory fallback when known channels cannot earn",
        wrongCategory: true,
        expected: "popular",
      },
      {
        name: "ranks followed peers by viewer count",
        followed: ["small", "Friend"],
        expected: "friend",
      },
      ...(platform === "twitch"
        ? [
            {
              name: "uses campaign-specific candidates when strict availability differs in the same category",
              strictAvailability: true,
              expected: "friend",
            },
          ]
        : []),
    ];

    it.each(cases)(
      "$name",
      async ({
        enabled = true,
        watchlist = [],
        excluded = [],
        acl = false,
        wrongCategory = false,
        followed = ["Friend"],
        strictAvailability = false,
        expected,
      }) => {
        const source = preferenceCampaign(platform, "first", "13");
        const other = preferenceCampaign(platform, "second", strictAvailability ? "13" : "99");
        if (acl) source.allowedChannels = ["popular"];
        const lookups: string[] = [];
        const directoryReads: string[] = [];
        const watchlistHost = platform === "kick" ? "https://kick.com" : "https://www.twitch.tv";
        const stream = (username: string) => {
          lookups.push(username);
          if (username === "offline") return null;
          const category =
            username === "wrong-category" || (username === "friend" && wrongCategory) ? "99" : "13";
          const viewers = username === "popular" ? 25_000 : username === "friend" ? 100 : 10;
          return { category, viewers };
        };
        const adapter =
          platform === "kick"
            ? kickAdapter(
                jsonFetcher((url) => {
                  if (url.includes("user/livestreams")) {
                    return followed.map((slug) => ({ channel: { slug } }));
                  }
                  if (url.includes("/api/v1/livestreams")) {
                    directoryReads.push(url);
                    return {
                      data: [{ slug: "popular", viewer_count: 25_000, category: { id: 13 } }],
                    };
                  }
                  const live = stream(new URL(url).pathname.split("/").at(-1)!);
                  return {
                    id: 1,
                    livestream: live && {
                      id: 2,
                      is_live: true,
                      categories: [{ id: Number(live.category) }],
                      viewer_count: live.viewers,
                    },
                  };
                }),
              )
            : twitchAdapter(
                jsonFetcher((_url, init) => {
                  type Request = {
                    operationName: string;
                    variables: { channel: string; channelID: string };
                  };
                  const body = JSON.parse(String(init?.body)) as Request | Request[];
                  const respond = (request: Request) => {
                    if (request.operationName === "FollowedLiveChannels") {
                      return {
                        data: {
                          currentUser: {
                            followedLiveUsers: {
                              edges: followed.map((login) => ({ node: { login } })),
                            },
                          },
                        },
                      };
                    }
                    if (request.operationName === "DropsHighlightService_AvailableDrops") {
                      const id = request.variables.channelID;
                      return {
                        data: {
                          channel: {
                            id,
                            viewerDropCampaigns: strictAvailability
                              ? id === "friend-id"
                                ? [{ id: other.id }]
                                : []
                              : [{ id: source.id }, { id: other.id }],
                          },
                        },
                      };
                    }
                    if (request.operationName !== "StreamInfo") {
                      directoryReads.push(request.operationName);
                      return {
                        data: {
                          game: {
                            streams: {
                              edges: [
                                {
                                  node: {
                                    id: "popular-stream",
                                    viewersCount: 25_000,
                                    broadcaster: { id: "popular-id", login: "popular" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      };
                    }
                    const username = request.variables.channel;
                    const live = stream(username);
                    return {
                      data: {
                        user: {
                          id: `${username}-id`,
                          stream: live && {
                            id: `${username}-stream`,
                            game: { id: live.category },
                            viewersCount: live.viewers,
                          },
                        },
                      },
                    };
                  };
                  return Array.isArray(body) ? body.map(respond) : respond(body);
                }),
                undefined,
                { strictCampaignAvailability: strictAvailability },
              );
        vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue(acl ? [source] : [source, other]);
        const listFollowedChannels = vi.spyOn(adapter, "listFollowedChannels");
        const settings = mergeSettings(undefined);
        settings.preferKnownChannels = enabled;
        settings.platform[platform].campaignPins = [source.id];
        settings.platform[platform].excludedChannels = excluded;
        settings.platform[platform].watchlistChannels = watchlist;
        const idle = watchlist.map((username) => ({
          platform,
          username,
          url: `${watchlistHost}/${username}`,
        }));
        const lane = new DiscoverySnapshotLane(platform, ({ signal }) =>
          collectDiscoverySnapshot(
            adapter,
            undefined,
            signal,
            Date.now,
            enabled,
            idle,
            undefined,
            settings,
          ),
        );
        await lane.requestAndWait();
        expect(lane.current().lastAttempt?.complete).toBe(true);
        const snapshot = lane.current().snapshot!;
        const result = await selectWatchTargetFromSnapshot({
          snapshot,
          previous: { platform, status: "idle", offlineChecks: 0 },
          previousCampaigns: [],
          settings,
        });

        expect(result.decision).toMatchObject({
          action: "watch",
          campaign: { id: strictAvailability ? other.id : source.id },
          channel: { username: expected, live: true, url: `${watchlistHost}/${expected}` },
        });
        const [first, second] = snapshot.campaigns;
        for (const username of [
          ...excluded,
          ...watchlist.filter((login) => login === "offline" || login === "wrong-category"),
          ...(wrongCategory || strictAvailability ? ["friend"] : []),
        ]) {
          expect(first?.candidates.some(({ candidate }) => candidate.username === username)).toBe(
            false,
          );
        }
        if (enabled) {
          expect(listFollowedChannels).toHaveBeenCalledOnce();
        } else {
          expect(listFollowedChannels).not.toHaveBeenCalled();
        }
        if (acl || !enabled) {
          expect(lookups).not.toContain("friend");
          expect(first?.candidates.map(({ candidate }) => candidate.username)).toEqual(["popular"]);
        }
        if (!acl) {
          expect(directoryReads).toHaveLength(2);
          expect(lookups.filter((username) => username === "friend")).toHaveLength(
            enabled && !excluded.includes("friend") ? 1 : 0,
          );
          if (watchlist.length) {
            expect(lookups.filter((username) => username === watchlist[0])).toHaveLength(1);
          }
          if (wrongCategory) {
            expect(second?.candidates).toContainEqual(
              expect.objectContaining({
                candidate: expect.objectContaining({ username: "friend" }),
                live: true,
                categoryMatches: true,
              }),
            );
          }
        }
        if (expected !== "popular" && !strictAvailability) {
          expect(first?.candidates.map(({ candidate }) => candidate.username)).toContain("popular");
        }
        if (watchlist.includes("watched")) {
          expect(snapshot.idleCandidates).toContainEqual(
            expect.objectContaining({
              candidate: expect.objectContaining({ username: "watched" }),
              live: true,
            }),
          );
        }
      },
    );
  });

  function twitchKnownChannels({
    follows = ["friend"],
    categoryFor = () => "13",
    directory = () => false,
    availability = () => [] as Array<{ id: string }>,
    streamFailure,
    availabilityFailure,
  }: {
    follows?: string[];
    categoryFor?: (login: string) => string;
    directory?: (slug: string) => boolean;
    availability?: () => Array<{ id: string }>;
    streamFailure?: () => unknown;
    availabilityFailure?: () => unknown;
  } = {}) {
    type Operation = {
      operationName: string;
      variables: { channel: string; channelID: string; slug: string };
    };
    const streamRequests: Array<{ batch: boolean; logins: string[] }> = [];
    const directorySlugs: string[] = [];
    const availabilityRequests: string[][] = [];
    const adapter = twitchAdapter(
      jsonFetcher((_url, init) => {
        const body = JSON.parse(String(init?.body)) as Operation | Operation[];
        const entries = Array.isArray(body) ? body : [body];
        if (entries[0]?.operationName === "StreamInfo") {
          streamRequests.push({
            batch: Array.isArray(body),
            logins: entries.map(({ variables }) => variables.channel),
          });
          if (Array.isArray(body) && streamFailure) return streamFailure();
        }
        if (entries[0]?.operationName === "DropsHighlightService_AvailableDrops") {
          availabilityRequests.push(entries.map(({ variables }) => variables.channelID));
          if (availabilityFailure) return availabilityFailure();
        }
        const respond = ({ operationName, variables }: Operation) => {
          switch (operationName) {
            case "FollowedLiveChannels":
              return {
                data: {
                  currentUser: {
                    followedLiveUsers: {
                      edges: follows.map((login) => ({ node: { login } })),
                    },
                  },
                },
              };
            case "StreamInfo":
              return {
                data: {
                  user: {
                    id: `${variables.channel}-id`,
                    stream: {
                      id: `${variables.channel}-stream`,
                      game: { id: categoryFor(variables.channel) },
                    },
                  },
                },
              };
            case "DropsHighlightService_AvailableDrops":
              return {
                data: { channel: { id: variables.channelID, viewerDropCampaigns: availability() } },
              };
            case "GameSlugs":
              return { data: { g0: { id: "13", slug: "allowed" } } };
            case "DirectoryPage_Game":
              directorySlugs.push(variables.slug);
              return {
                data: {
                  game: {
                    streams: {
                      edges: directory(variables.slug)
                        ? [
                            {
                              node: {
                                id: "directory-stream",
                                broadcaster: { id: "directory-id", login: "directory" },
                              },
                            },
                          ]
                        : [],
                    },
                  },
                },
              };
            default:
              throw new Error(`Unexpected Twitch operation ${operationName}`);
          }
        };
        return Array.isArray(body) ? entries.map(respond) : respond(body as Operation);
      }),
      undefined,
      { strictCampaignAvailability: false },
    );
    return { adapter, streamRequests, directorySlugs, availabilityRequests };
  }

  it.each([false, true])(
    "farms the lower Twitch campaign when the pinned one lacks Drops evidence (hours=%s)",
    async (overHours) => {
      const top = preferenceCampaign("twitch", "pinned", "13");
      const lower = preferenceCampaign("twitch", "lower", "99");
      lower.rewards[0]!.requiredMinutes = 300;
      const { adapter } = twitchKnownChannels({ directory: (slug) => slug === "lower" });
      const settings = mergeSettings(undefined);
      settings.platform.twitch.enabled = true;
      settings.tablessMode = false;
      settings.platform.twitch.campaignPins = [top.id];
      const initialTime = new Date("2026-01-01T12:00:00Z").getTime();
      vi.useFakeTimers({ toFake: ["Date"] });
      const open = vi.fn(async (channel: ChannelCandidate) => ({
        tabId: 1,
        managedByExtension: true,
        managedTab: {
          platform: channel.platform,
          tabId: 1,
          channelUrl: channel.url,
          ownedByExtension: true as const,
        },
      }));
      const stop = vi.fn();
      const tabRegistry = createTabRegistry();
      const health = { status: "healthy", checkedAt: new Date(initialTime).toISOString() } as const;
      let state: SchedulerState = {
        authHealth: { twitch: health, kick: health },
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      };
      let minutesFarmed = 0;
      const lane = new DiscoverySnapshotLane("twitch", ({ signal }) =>
        collectDiscoverySnapshot(
          adapter,
          state.sessions.twitch,
          signal,
          Date.now,
          true,
          [],
          undefined,
          settings,
        ),
      );
      vi.spyOn(adapter, "refreshCampaigns").mockImplementation(async () => [
        top,
        { ...lower, rewards: [{ ...lower.rewards[0]!, watchedMinutes: minutesFarmed }] },
      ]);
      try {
        for (let minute = 0; minute < (overHours ? 180 : 1); minute++) {
          vi.setSystemTime(initialTime + minute * 60_000);
          if (state.sessions.twitch.channel?.username === "directory") minutesFarmed++;
          if (state.sessions.twitch.channel) {
            state.sessions.twitch.playback = {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              playingVideoCount: 1,
              mutedVideoCount: 1,
              unmutedVideoCount: 0,
              blockedPlaybackCount: 0,
              documentHidden: true,
            };
          }
          await lane.requestAndWait();
          expect(lane.current().lastAttempt?.complete).toBe(true);
          const snapshot = lane.current().snapshot!;
          const selection = await selectWatchTargetFromSnapshot({
            snapshot,
            previous: state.sessions.twitch,
            previousCampaigns: state.campaigns.twitch,
            settings,
          });
          if (minute === 0 && !overHours)
            expect(selection.decision.channel?.username).toBe("directory");
          const twitch = Object.assign(
            adapterFromDiscoverySnapshot(adapter, snapshot, state.sessions.twitch),
            { prepareWatchTab: open, stopWatchTab: stop },
          );
          state = (
            await runSchedulerTick(
              state,
              settings,
              { twitch, kick: kickAdapter(jsonFetcher(() => null)) },
              {
                platforms: ["twitch"],
                tabRegistry,
                selections: { twitch: selection },
                discovery: {
                  twitch: {
                    campaigns: snapshot.campaigns.map(({ campaign }) => campaign),
                    complete: true,
                  },
                },
              },
            )
          ).state;
        }
        expect(state.sessions.twitch).toMatchObject({
          status: "watching",
          campaignId: "lower",
          channel: { username: "directory" },
        });
        expect(minutesFarmed).toBe(overHours ? 179 : 0);
        expect(open).toHaveBeenCalled();
        expect(open.mock.calls.map(([channel]) => channel.username)).not.toContain("friend");
        expect(stop).not.toHaveBeenCalled();
        expect(state.criticalHealth?.twitch?.managedTabOpens.length ?? 0).toBeLessThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("checks followed channels only against allowed categories of a sitewide Twitch campaign", async () => {
    const { adapter, directorySlugs, availabilityRequests } = twitchKnownChannels({
      follows: ["allowed", "blocked"],
      categoryFor: (login) => (login === "allowed" ? "13" : "99"),
    });
    const campaign: DropCampaign = {
      ...preferenceCampaign("twitch", "sitewide", "13"),
      sitewide: true,
      categories: [
        { id: "13", name: "Allowed" },
        { id: "99", name: "Blocked" },
      ],
    };
    vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([campaign]);
    const settings = mergeSettings(undefined);
    settings.platform.twitch.blockedCategories = [{ id: "99", name: "Blocked" }];
    const result = await collectDiscoverySnapshot(
      adapter,
      undefined,
      new AbortController().signal,
      Date.now,
      true,
      [],
      undefined,
      settings,
    );
    expect(result.campaigns[0]?.candidates.map(({ candidate }) => candidate.username)).toEqual([
      "allowed",
    ]);
    expect(directorySlugs).toEqual(["allowed"]);
    expect(availabilityRequests).toEqual([]);
  });

  it.each([false, true])(
    "bounds Twitch known-channel checks and retries failed Watchlist probes as idle checks (429=%s)",
    async (rateLimited) => {
      const follows = Array.from({ length: 100 }, (_, i) => `follow-${i}`);
      const { adapter, streamRequests } = twitchKnownChannels({
        follows,
        directory: () => true,
        streamFailure: () => {
          if (rateLimited)
            return { __twitchGqlError: "Twitch GQL HTTP 429", __twitchGqlStatus: 429 };
          throw new Error("StreamInfo batch failed");
        },
      });
      vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([
        preferenceCampaign("twitch", "first", "13"),
      ]);
      const watchlist = [
        {
          platform: "twitch" as const,
          username: "watchlist",
          url: "https://www.twitch.tv/watchlist",
        },
      ];
      const result = await collectDiscoverySnapshot(
        adapter,
        undefined,
        new AbortController().signal,
        Date.now,
        true,
        watchlist,
      );
      const probeRequests = rateLimited ? 1 : 5;
      expect(streamRequests.slice(0, probeRequests).flatMap(({ logins }) => logins)).toEqual([
        "watchlist",
        ...follows.slice(0, rateLimited ? 19 : 99),
      ]);
      expect(streamRequests.slice(probeRequests)).toEqual([
        { batch: true, logins: ["watchlist"] },
        { batch: false, logins: ["watchlist"] },
      ]);
      expect(result.campaigns[0]?.candidates.map(({ candidate }) => candidate.username)).toEqual([
        "directory",
      ]);
      expect(result.idleCandidates).toMatchObject([
        { candidate: { username: "watchlist" }, live: true },
      ]);
      expect(result.metrics).toMatchObject({
        uniqueChannelChecks: rateLimited ? 21 : 101,
        candidates: 2,
        batchRequests: probeRequests + 1,
        singleFallbacks: 1,
      });
    },
  );

  it.each([false, true])(
    "drops Twitch candidates without availability evidence and keeps ordinary discovery (429=%s)",
    async (rateLimited) => {
      const { adapter, availabilityRequests } = twitchKnownChannels({
        directory: () => true,
        availabilityFailure: () => {
          if (rateLimited) throw new SafeFetchError({ kind: "http_error", status: 429 });
          return { data: { channel: { id: "other-id", viewerDropCampaigns: [{ id: "first" }] } } };
        },
        follows: ["friend", "secondfriend"],
        categoryFor: (login) => (login === "friend" ? "13" : "99"),
      });
      vi.spyOn(adapter, "refreshCampaigns").mockResolvedValue([
        preferenceCampaign("twitch", "first", "13"),
        preferenceCampaign("twitch", "second", "99"),
      ]);
      const result = await collectDiscoverySnapshot(
        adapter,
        undefined,
        new AbortController().signal,
      );
      expect(
        result.campaigns.map(({ candidates }) =>
          candidates.map(({ candidate }) => candidate.username),
        ),
      ).toEqual([["directory"], ["directory"]]);
      expect(availabilityRequests).toEqual(
        rateLimited ? [["friend-id"]] : [["friend-id"], ["secondfriend-id"]],
      );
      expect(result.metrics).toMatchObject({
        uniqueChannelChecks: 3,
        candidates: 2,
        batchRequests: rateLimited ? 2 : 3,
        singleFallbacks: 0,
      });
    },
  );

  it("retains a backed-off campaign observation without candidate provider calls", async () => {
    const campaign = {
      id: "backed-off",
      platform: "twitch" as const,
      name: "Backed off",
      status: "active" as const,
      rewards: [],
    };
    const candidate = {
      platform: "twitch" as const,
      username: "offline",
      url: "https://www.twitch.tv/offline",
    };
    const retained = [
      { candidate, live: true, categoryMatches: true, eligible: false as const, observedAt: 41 },
    ];
    const listCandidateChannels = vi.fn(async () => [candidate]);
    const result = await collectDiscoverySnapshot(
      {
        platform: "twitch",
        refreshCampaigns: vi.fn(async () => [campaign]),
        listCandidateChannels,
        checkChannel: vi.fn(),
        selectCandidateChannel: undefined,
      },
      undefined,
      new AbortController().signal,
      () => 42,
      false,
      [],
      (item) => (item.id === campaign.id ? retained : undefined),
    );

    expect(result.campaigns).toEqual([{ campaign, candidates: retained }]);
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(result.metrics.candidates).toBe(0);
  });

  it("captures followed-channel preference evidence inside discovery", async () => {
    const listFollowedChannels = vi.fn(async () => ["friend"]);
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => []),
      listCandidateChannels: vi.fn(),
      checkChannel: vi.fn(),
      selectCandidateChannel: undefined,
      listFollowedChannels,
    };

    const result = await collectDiscoverySnapshot(adapter, undefined, new AbortController().signal);

    expect(result.followedChannels).toEqual(["friend"]);
    expect(listFollowedChannels).toHaveBeenCalledOnce();
  });

  it("skips followed-channel discovery when preference is disabled", async () => {
    const listFollowedChannels = vi.fn(async () => ["friend"]);
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => []),
      listCandidateChannels: vi.fn(),
      checkChannel: vi.fn(),
      selectCandidateChannel: undefined,
      listFollowedChannels,
    };

    const result = await collectDiscoverySnapshot(
      adapter,
      undefined,
      new AbortController().signal,
      Date.now,
      false,
    );

    expect(result.followedChannels).toEqual([]);
    expect(listFollowedChannels).not.toHaveBeenCalled();
  });

  it("keeps Kick channel-specific eligibility unknown", async () => {
    const campaign = {
      id: "campaign",
      platform: "kick" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const candidate = {
      platform: "kick" as const,
      username: "streamer",
      displayName: "Streamer",
      url: "https://kick.com/streamer",
    };
    const adapter = {
      platform: "kick" as const,
      refreshCampaigns: vi.fn(async () => [campaign]),
      listCandidateChannels: vi.fn(async () => [candidate]),
      checkChannel: vi.fn(async () => ({ live: true, categoryMatches: true, candidate })),
      selectCandidateChannel: undefined,
    };

    const result = await collectDiscoverySnapshot(
      adapter,
      undefined,
      new AbortController().signal,
      () => 42,
    );

    expect(result.complete).toBe(true);
    expect(result.campaigns[0]?.candidates[0]).toMatchObject({
      live: true,
      categoryMatches: true,
      eligible: "unknown",
      observedAt: 42,
    });
  });

  it("preserves all provider candidate observations and tri-state eligibility", async () => {
    const campaign = {
      id: "campaign",
      platform: "twitch" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const candidates = ["eligible", "rejected", "unknown"].map((username) => ({
      platform: "twitch" as const,
      username,
      displayName: username,
      url: `https://twitch.tv/${username}`,
    }));
    const adapter = {
      platform: "twitch" as const,
      refreshCampaigns: vi.fn(async () => [campaign]),
      listCandidateChannels: vi.fn(async () => candidates),
      checkChannel: vi.fn(),
      selectCandidateChannel: vi.fn(async () => ({
        channel: candidates[0],
        checked: 3,
        observations: candidates.map((candidate, index) => ({
          live: true,
          categoryMatches: true,
          campaignMatches: index === 0 ? true : index === 1 ? false : undefined,
          candidate,
        })),
      })),
    };

    const result = await collectDiscoverySnapshot(
      adapter,
      undefined,
      new AbortController().signal,
      () => 42,
    );

    expect(
      result.campaigns[0]?.candidates.map(({ candidate, eligible }) => [
        candidate.username,
        eligible,
      ]),
    ).toEqual([
      ["eligible", true],
      ["rejected", false],
      ["unknown", "unknown"],
    ]);
  });
});

function preferenceCampaign(platform: Platform, id: string, categoryId: string): DropCampaign {
  return {
    id,
    platform,
    name: id,
    categoryId,
    gameName: id,
    slug: id,
    status: "active",
    rewards: [
      { id: "reward", name: "Reward", status: "locked", requiredMinutes: 60, watchedMinutes: 0 },
    ],
  };
}

describe("adapterFromDiscoverySnapshot", () => {
  it("does not perform inline provider discovery when no snapshot exists", async () => {
    const candidate = {
      platform: "kick" as const,
      username: "streamer",
      displayName: "Streamer",
      url: "https://kick.com/streamer",
    };
    const campaign = {
      id: "campaign",
      platform: "kick" as const,
      name: "Campaign",
      status: "active" as const,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(1_000).toISOString(),
      rewards: [],
    };
    const checkChannel = vi.fn();
    const listCandidateChannels = vi.fn();
    const adapter = adapterFromDiscoverySnapshot(
      {
        platform: "kick",
        checkChannel,
        listCandidateChannels,
      } as never,
      undefined,
    );

    expect(await adapter.listCandidateChannels(campaign)).toEqual([]);
    expect(await adapter.checkChannel(candidate, { campaign })).toMatchObject({
      live: false,
      categoryMatches: false,
    });
    expect(listCandidateChannels).not.toHaveBeenCalled();
    expect(checkChannel).not.toHaveBeenCalled();
  });
});
