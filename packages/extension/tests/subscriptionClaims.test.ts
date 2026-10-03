import { describe, expect, it } from "vitest";
import { preserveClaimedRewards } from "@lurkloot/core/scheduler";
import { mergeTwitchCampaignProgress, parseTwitchCampaigns, parseTwitchInventory } from "@lurkloot/core/twitch/parser";

// A Twitch subscription reward is only ever shown as earned from campaign-scoped
// evidence: its own self edge (campaign details or dropCampaignsInProgress) or a
// CLAIMED earnedDropRewards edge. These cover the ways that evidence used to be
// lost or misread between and within checks.

type Inventory = Parameters<typeof mergeTwitchCampaignProgress>[1];

const CAMPAIGN = "subscription-campaign";
const BENEFIT = "shared-benefit";

function inventory(options: {
  userId?: string;
  inProgress?: unknown[];
  earned?: Array<{ benefitId: string; campaignId?: string }>;
}): Inventory {
  return {
    data: {
      currentUser: {
        id: options.userId ?? "user-a",
        inventory: {
          gameEventDrops: [],
          earnedDropRewards: {
            edges: (options.earned ?? []).map(({ benefitId, campaignId }) => ({
              node: {
                id: benefitId,
                item: { id: benefitId },
                campaign: { id: campaignId ?? CAMPAIGN },
                status: "CLAIMED",
                earnedAt: "2026-09-20T12:00:00.000Z",
              },
            })),
          },
          dropCampaignsInProgress: options.inProgress ?? [],
        },
      },
    },
  } as Inventory;
}

describe("Twitch subscription reward claims", () => {
  it("keeps a credited subscription reward earned after its campaign leaves the progress payload", () => {
    const staleDetails = () => parseTwitchCampaigns([{
      id: CAMPAIGN,
      timeBasedDrops: [{ id: "subscription", requiredSubs: 1 }],
    }]);
    const credited = mergeTwitchCampaignProgress(staleDetails(), inventory({
      inProgress: [{
        id: CAMPAIGN,
        timeBasedDrops: [{ id: "subscription", requiredSubs: 1, self: { isClaimed: true } }],
      }],
    }));
    expect(credited[0].rewards[0].status).toBe("claimed");

    // The next check no longer lists the campaign in progress and its cached
    // details still predate the claim.
    const refreshed = mergeTwitchCampaignProgress(staleDetails(), inventory({}));

    const preserved = preserveClaimedRewards(refreshed, credited);

    expect(preserved[0].rewards[0].status).toBe("claimed");
  });

  it("does not carry one account's earned subscription reward over to another account", () => {
    const details = () => parseTwitchCampaigns([{
      id: CAMPAIGN,
      timeBasedDrops: [{ id: "subscription", requiredSubs: 1 }],
    }]);
    const credited = mergeTwitchCampaignProgress(details(), inventory({
      userId: "user-a",
      inProgress: [{
        id: CAMPAIGN,
        timeBasedDrops: [{ id: "subscription", requiredSubs: 1, self: { isClaimed: true } }],
      }],
    }));
    const otherAccount = mergeTwitchCampaignProgress(details(), inventory({ userId: "user-b" }));

    const preserved = preserveClaimedRewards(otherAccount, credited);

    expect(preserved[0].rewards[0].status).toBe("locked");
  });

  it("does not let a progress entry without a self edge undo a claim the campaign details report", () => {
    const details = parseTwitchCampaigns([{
      id: CAMPAIGN,
      timeBasedDrops: [{ id: "subscription", requiredSubs: 1, self: { isClaimed: true } }],
    }]);

    const merged = mergeTwitchCampaignProgress(details, inventory({
      inProgress: [{
        id: CAMPAIGN,
        timeBasedDrops: [{ id: "subscription", requiredSubs: 1 }],
      }],
    }));

    expect(merged[0].rewards[0].status).toBe("claimed");
  });

  describe("a benefit both a watch tier and a subscription tier award", () => {
    const tiers = (selfByTier: { watch?: unknown; subscription?: unknown } = {}) => [{
      id: "watch",
      requiredMinutesWatched: 60,
      benefitEdges: [{ benefit: { id: BENEFIT, name: "Shared Skin" } }],
      ...(selfByTier.watch ? { self: selfByTier.watch } : {}),
    }, {
      id: "subscription",
      requiredSubs: 1,
      benefitEdges: [{ benefit: { id: BENEFIT, name: "Shared Skin" } }],
      ...(selfByTier.subscription ? { self: selfByTier.subscription } : {}),
    }];

    it("does not credit a claim earned by watching to the subscription tier", () => {
      const merged = mergeTwitchCampaignProgress(
        parseTwitchCampaigns([{ id: CAMPAIGN, timeBasedDrops: tiers() }]),
        inventory({
          inProgress: [{
            id: CAMPAIGN,
            timeBasedDrops: tiers({ watch: { currentMinutesWatched: 60, isClaimed: true } }),
          }],
          earned: [{ benefitId: BENEFIT }],
        }),
      );

      expect(merged[0].rewards.map((reward) => [reward.id, reward.status])).toEqual([
        ["watch", "claimed"],
        ["subscription", "locked"],
      ]);
    });

    it("does not credit it to the subscription tier when parsing the inventory either", () => {
      const [campaign] = parseTwitchInventory(inventory({
        inProgress: [{
          id: CAMPAIGN,
          timeBasedDrops: tiers({ watch: { currentMinutesWatched: 60, isClaimed: true } }),
        }],
        earned: [{ benefitId: BENEFIT }],
      }));

      expect(campaign.rewards.map((reward) => [reward.id, reward.status])).toEqual([
        ["watch", "claimed"],
        ["subscription", "locked"],
      ]);
    });

    it("keeps watch tiers the details report claimed after the campaign leaves the progress payload", () => {
      const watchClaimed = { currentMinutesWatched: 60, isClaimed: true };
      const merged = mergeTwitchCampaignProgress(
        parseTwitchCampaigns([{
          id: CAMPAIGN,
          timeBasedDrops: [
            { ...tiers()[0], id: "watch-60", self: watchClaimed },
            { ...tiers()[0], id: "watch-120", requiredMinutesWatched: 120, self: { ...watchClaimed, currentMinutesWatched: 120 } },
            tiers()[1],
          ],
        }]),
        inventory({ earned: [{ benefitId: BENEFIT }, { benefitId: BENEFIT }] }),
      );

      expect(merged[0].rewards.map((reward) => [reward.id, reward.status])).toEqual([
        ["watch-60", "claimed"],
        ["watch-120", "claimed"],
        ["subscription", "locked"],
      ]);
    });

    it("credits both tiers once the campaign has a claim for each", () => {
      const merged = mergeTwitchCampaignProgress(
        parseTwitchCampaigns([{ id: CAMPAIGN, timeBasedDrops: tiers() }]),
        inventory({ earned: [{ benefitId: BENEFIT }, { benefitId: BENEFIT }] }),
      );

      expect(merged[0].rewards.every((reward) => reward.status === "claimed")).toBe(true);
      expect(merged[0].status).toBe("completed");
    });
  });
});
