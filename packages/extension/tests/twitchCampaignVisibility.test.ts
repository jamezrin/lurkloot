import { describe, expect, it, vi } from "vitest";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import { twitchAdapter } from "./helpers/adapters";

// Campaign visibility coverage for #400. The reporter saw an active, unlinked
// campaign that only appeared after reinstalling the extension. These tests pin
// the discovery state machine's actual behaviour: fresh dashboard results are
// authoritative and are never suppressed by retained state.

function jsonFetcher(handler: (url: string, init?: RequestInit) => unknown): PageFetcher {
  const fetchJson = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => handler(url, init));
  return { fetchJson: fetchJson as PageFetcher["fetchJson"] };
}

interface DashboardEntry {
  id: string;
  status: string;
  isAccountConnected?: boolean;
  // Mimics the inline fallback query, which selects only id/status/self.
  bare?: boolean;
}

// Twitch's persisted ViewerDropsDashboard returns the campaign name, game and
// window alongside the id and status.
function dashboard(entries: DashboardEntry[], userId = "user-id"): unknown {
  const now = Date.now();
  return {
    data: {
      currentUser: {
        id: userId,
        login: "viewer",
        dropCampaigns: entries.map((entry) => ({
          id: entry.id,
          status: entry.status,
          self: { isAccountConnected: entry.isAccountConnected ?? true },
          ...(entry.bare ? {} : {
            name: `Campaign ${entry.id}`,
            game: { id: "game", slug: "game-slug", displayName: "Game" },
            ...(entry.status === "EXPIRED"
              ? {
                startAt: new Date(now - 2 * HOUR_MS).toISOString(),
                endAt: new Date(now - HOUR_MS).toISOString(),
              }
              : entry.status === "UPCOMING"
                ? {
                  startAt: new Date(now + HOUR_MS).toISOString(),
                  endAt: new Date(now + 2 * HOUR_MS).toISOString(),
                }
                : {
                  startAt: new Date(now - HOUR_MS).toISOString(),
                  endAt: new Date(now + HOUR_MS).toISOString(),
                }),
          }),
        })),
      },
    },
  };
}

const HOUR_MS = 3_600_000;

// Campaign status and account linkage are parsed from the details payload, not
// the dashboard entry, so the fixture has to carry both: startAt/endAt decide
// upcoming/active/expired, and self.isAccountConnected only counts when the
// campaign actually has an accountLinkURL.
function details(dropID: string, entry: DashboardEntry): unknown {
  const now = Date.now();
  const window = entry.status === "UPCOMING"
    ? { startAt: new Date(now + HOUR_MS).toISOString(), endAt: new Date(now + 2 * HOUR_MS).toISOString() }
    : entry.status === "EXPIRED"
      ? { startAt: new Date(now - 2 * HOUR_MS).toISOString(), endAt: new Date(now - HOUR_MS).toISOString() }
      : { startAt: new Date(now - HOUR_MS).toISOString(), endAt: new Date(now + HOUR_MS).toISOString() };
  return {
    data: {
      dropCampaign: {
        id: dropID,
        name: `Campaign ${dropID}`,
        status: entry.status,
        ...window,
        accountLinkURL: "https://www.example.com/link",
        self: { isAccountConnected: entry.isAccountConnected ?? true },
        game: { id: "game", slug: "game-slug", displayName: "Game" },
        timeBasedDrops: [{
          id: `${dropID}-drop`,
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
        }],
      },
    },
  };
}

const EMPTY_INVENTORY = {
  data: { currentUser: { id: "user-id", inventory: { dropCampaignsInProgress: [] } } },
};

// Drives refreshCampaigns() against a scripted sequence of dashboard states,
// one per refresh, sharing a single discovery state across refreshes the way a
// long-lived service worker does. Campaign details are derived from the same
// scripted entries so status and linkage stay consistent between the two
// queries, as they are on Twitch.
function discoverer(
  refreshes: Array<DashboardEntry[] | Error>,
  detailRequests: string[] = [],
  { failDetailsFor = [] }: { failDetailsFor?: string[] } = {},
) {
  let refresh = -1;
  const discoveryState = new TwitchDiscoveryState();
  const current = () => refreshes[Math.min(refresh, refreshes.length - 1)];
  const fetcher = jsonFetcher((_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
    const operations = Array.isArray(body) ? body : [body];
    const responses = operations.map((operation) => {
      const operationName = String(operation.operationName);
      const scripted = current();
      if (operationName === "ViewerDropsDashboard") {
        if (scripted instanceof Error) throw scripted;
        return dashboard(scripted);
      }
      if (operationName === "DropCampaignDetails") {
        const dropID = String((operation.variables as { dropID?: string } | undefined)?.dropID);
        detailRequests.push(dropID);
        if (failDetailsFor.includes(dropID)) throw new Error(`details unavailable for ${dropID}`);
        // A retained id can outlive the refresh that produced it, so fall back
        // to the last scripted state that described this campaign.
        const entry = (scripted instanceof Error ? undefined : scripted.find((item) => item.id === dropID))
          ?? refreshes.flatMap((state) => (state instanceof Error ? [] : state)).find((item) => item.id === dropID);
        if (!entry) return { data: { dropCampaign: null } };
        return details(dropID, entry);
      }
      return EMPTY_INVENTORY;
    });
    return Array.isArray(body) ? responses : responses[0];
  });
  const adapter = twitchAdapter(fetcher, undefined, undefined, { discoveryState });
  return {
    async next() {
      refresh += 1;
      return adapter.refreshCampaigns();
    },
  };
}

describe("twitch campaign visibility (#400)", () => {
  it("surfaces an active campaign the account has not linked", async () => {
    const campaigns = await discoverer([
      [{ id: "unlinked", status: "ACTIVE", isAccountConnected: false }],
    ]).next();

    expect(campaigns.map((campaign) => campaign.id)).toContain("unlinked");
    expect(campaigns.find((campaign) => campaign.id === "unlinked")?.accountLinked).toBe(false);
  });

  // The reported symptom: a campaign that was not yet active on one refresh and
  // active on the next had to appear without clearing extension state.
  it("surfaces a campaign that turns active after an earlier refresh saw it upcoming", async () => {
    const discovery = discoverer([
      [{ id: "starting", status: "UPCOMING", isAccountConnected: false }],
      [{ id: "starting", status: "ACTIVE", isAccountConnected: false }],
    ]);

    const first = await discovery.next();
    expect(first.find((campaign) => campaign.id === "starting")?.status).toBe("upcoming");

    const second = await discovery.next();
    expect(second.find((campaign) => campaign.id === "starting")?.status).toBe("active");
  });

  it("surfaces a campaign that only appears in a later dashboard refresh", async () => {
    const discovery = discoverer([
      [{ id: "existing", status: "ACTIVE" }],
      [
        { id: "existing", status: "ACTIVE" },
        { id: "brand-new", status: "ACTIVE", isAccountConnected: false },
      ],
    ]);

    expect((await discovery.next()).map((campaign) => campaign.id)).not.toContain("brand-new");
    expect((await discovery.next()).map((campaign) => campaign.id)).toContain("brand-new");
  });

  // Retained dashboard ids are a failure-path fallback: they must bridge a
  // failed refresh without ever overriding a later successful one.
  it("reuses retained campaigns when a refresh fails, then defers to the next success", async () => {
    const discovery = discoverer([
      [{ id: "retained", status: "ACTIVE" }],
      new Error("dashboard unavailable"),
      [{ id: "replacement", status: "ACTIVE" }],
    ]);

    expect((await discovery.next()).map((campaign) => campaign.id)).toEqual(["retained"]);
    // The failed refresh keeps serving the last known campaign rather than
    // reporting that the user has none.
    expect((await discovery.next()).map((campaign) => campaign.id)).toEqual(["retained"]);
    // The next success is authoritative, so the stale campaign is gone.
    expect((await discovery.next()).map((campaign) => campaign.id)).toEqual(["replacement"]);
  });

  // Historical campaigns are listed from the dashboard payload alone. The
  // Drops-list filters decide whether they are shown; discovery only has to
  // stop dropping them.
  it("surfaces an expired campaign from the dashboard without fetching its details", async () => {
    const detailRequests: string[] = [];
    const campaigns = await discoverer(
      [[
        { id: "running", status: "ACTIVE" },
        { id: "over", status: "EXPIRED", isAccountConnected: false },
      ]],
      detailRequests,
    ).next();

    const expired = campaigns.find((campaign) => campaign.id === "over");
    expect(expired?.status).toBe("expired");
    expect(expired?.name).toBe("Campaign over");
    expect(expired?.gameName).toBe("Game");
    // The detail fetch stays scoped to farmable campaigns, so an account with
    // hundreds of historical campaigns costs no extra requests.
    expect(detailRequests).toEqual(["running"]);
  });

  it("leaves an expired campaign out when the dashboard payload carries no detail", async () => {
    // The inline fallback query selects only id/status, so nothing can be shown.
    const campaigns = await discoverer([[
      { id: "running", status: "ACTIVE" },
      { id: "bare", status: "EXPIRED", bare: true },
    ]]).next();

    expect(campaigns.map((campaign) => campaign.id)).toEqual(["running"]);
  });

  // A campaign the dashboard still calls ACTIVE reaches the historical path
  // only because its detail fetch failed. Marking that expired would retire a
  // farmable campaign from the list and from scheduling over a transient error.
  it("never reports an active campaign as expired when its details fail", async () => {
    const campaigns = await discoverer(
      [[{ id: "running", status: "ACTIVE" }]],
      [],
      { failDetailsFor: ["running"] },
    ).next();

    expect(campaigns.find((campaign) => campaign.id === "running")?.status).not.toBe("expired");
  });

  it("does not duplicate a campaign that details already covered", async () => {
    const campaigns = await discoverer([[
      { id: "running", status: "ACTIVE" },
    ]]).next();

    expect(campaigns.filter((campaign) => campaign.id === "running")).toHaveLength(1);
  });

  // A restarted service worker builds a fresh TwitchDiscoveryState, which must
  // not be a precondition for seeing a new campaign.
  it("does not need a fresh discovery state to surface a new campaign", async () => {
    const shared = discoverer([
      [{ id: "existing", status: "ACTIVE" }],
      [{ id: "existing", status: "ACTIVE" }, { id: "late", status: "ACTIVE" }],
    ]);
    await shared.next();
    const withSharedState = await shared.next();

    const restarted = discoverer([
      [{ id: "existing", status: "ACTIVE" }, { id: "late", status: "ACTIVE" }],
    ]);
    const afterRestart = await restarted.next();

    expect(withSharedState.map((campaign) => campaign.id).sort())
      .toEqual(afterRestart.map((campaign) => campaign.id).sort());
    expect(withSharedState.map((campaign) => campaign.id)).toContain("late");
  });
});
