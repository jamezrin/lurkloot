import { describe, expect, it, vi } from "vitest";
import type { PageFetcher } from "@lurkloot/core/adapter";
import { TwitchDiscoveryState } from "@lurkloot/core/twitch";
import type { EngineEvent } from "@lurkloot/shared/events";
import { twitchAdapter } from "./helpers/adapters";

// #679: a subscription reward Twitch credited may not show as earned. Each
// discovery logs what Twitch's sources said about such a reward, so a user's
// diagnostics export carries the evidence without a response body.

const PREFIX = "Twitch subscription reward evidence: ";
const DROP_INSTANCE = "viewer-user-id#sub-campaign#sub-drop";

function fetcherWith(inventory: () => unknown): PageFetcher {
  const handle = (body: Record<string, unknown>): unknown => {
    const op = body.operationName;
    if (op === "Inventory") return inventory();
    if (op === "ViewerDropsDashboard") {
      return {
        data: {
          currentUser: {
            id: "viewer-user-id",
            login: "viewer",
            dropCampaigns: [{ id: "sub-campaign", status: "ACTIVE", self: { isAccountConnected: true } }],
          },
        },
      };
    }
    if (op === "DropCampaignDetails") {
      return {
        data: {
          dropCampaign: {
            id: "sub-campaign",
            name: "Subscriber Skin",
            game: { id: "game", slug: "game-slug", displayName: "Game" },
            timeBasedDrops: [{
              id: "sub-drop",
              requiredSubs: 1,
              benefitEdges: [{ benefit: { id: "skin", name: "Skin" } }],
              self: { isClaimed: false },
            }],
          },
        },
      };
    }
    throw new Error(`Unexpected operation ${String(op)}`);
  };
  return {
    fetchJson: vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Record<string, unknown>[];
      return Array.isArray(body) ? body.map(handle) : handle(body);
    }) as PageFetcher["fetchJson"],
  };
}

function inventory(subscriptionSelf?: Record<string, unknown>): unknown {
  return {
    data: {
      currentUser: {
        id: "viewer-user-id",
        inventory: {
          gameEventDrops: [],
          earnedDropRewards: { edges: [] },
          dropCampaignsInProgress: subscriptionSelf
            ? [{ id: "sub-campaign", timeBasedDrops: [{ id: "sub-drop", requiredSubs: 1, self: subscriptionSelf }] }]
            : [],
        },
      },
    },
  };
}

function evidenceMessages(events: readonly EngineEvent[]): string[] {
  return events
    .filter((event) => event.category === "diagnostic" && event.message.startsWith(PREFIX))
    .map((event) => (event as { message: string }).message);
}

describe("Twitch subscription reward evidence (#679)", () => {
  it("logs a subscription reward's sources once, and again when they change", async () => {
    let current = inventory();
    const fetcher = fetcherWith(() => current);
    const discoveryState = new TwitchDiscoveryState();
    const events: EngineEvent[] = [];
    const refresh = () => twitchAdapter(fetcher, undefined, { discoveryState }, (event) => events.push(event)).refreshCampaigns();

    await refresh();
    await refresh();
    current = inventory({ isClaimed: false, dropInstanceID: DROP_INSTANCE });
    await refresh();

    const messages = evidenceMessages(events);
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0].slice(PREFIX.length))).toEqual({
      campaignId: "sub-campaign",
      name: "Subscriber Skin",
      rewards: [{
        rewardId: "sub-drop",
        status: "locked",
        details: { isClaimed: false, hasDropInstance: false },
        inventory: "not_in_progress",
        earnedClaims: 0,
        ownsBenefit: false,
      }],
    });
    expect(JSON.parse(messages[1].slice(PREFIX.length)).rewards[0]).toMatchObject({
      status: "claimable",
      inventory: { isClaimed: false, hasDropInstance: true },
    });
  });

  it("never logs the drop instance id or the viewer's id", async () => {
    const events: EngineEvent[] = [];

    await twitchAdapter(
      fetcherWith(() => inventory({ isClaimed: true, dropInstanceID: DROP_INSTANCE })),
      undefined,
      { discoveryState: new TwitchDiscoveryState() },
      (event) => events.push(event),
    ).refreshCampaigns();

    const [message] = evidenceMessages(events);
    expect(message).toBeDefined();
    expect(message).not.toContain("viewer-user-id");
  });
});
