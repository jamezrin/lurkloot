import { isRecord } from "@lurkloot/shared/records";
import { twitchInventoryCapability, twitchInventoryFieldChecks } from "./capability";

const TWITCH_CAMPAIGN_FIELDS = `{
  id
  name
  imageURL
  startAt
  endAt
  status
  accountLinkURL
  detailsURL
  self { isAccountConnected }
  game { id name displayName slug boxArtURL }
  allow { isEnabled channels { name login } }
  timeBasedDrops {
    id
    name
    startAt
    endAt
    requiredMinutesWatched
    requiredSubs
    preconditionDrops { id }
    benefitEdges { benefit { id name imageAssetURL distributionType } }
    self { currentMinutesWatched isClaimed dropInstanceID }
  }
}`;

// earnedDropRewards returns one edge per claim, campaign-scoped and keyed by item
// (benefit) id. It is the only field that reports how many tiers of a benefit
// shared across several watch tiers were claimed — gameEventDrops deduplicates
// them into a single entry, and the per-tier self edge disappears once the
// campaign leaves dropCampaignsInProgress.
const INLINE_QUERY = `query Inventory($fetchRewardCampaigns: Boolean!) {
  currentUser {
    id
    inventory {
      gameEventDrops { id benefit { id } lastAwardedAt }
      earnedDropRewards { edges { node { id item { id } campaign { id } status earnedAt } } }
      dropCampaignsInProgress ${TWITCH_CAMPAIGN_FIELDS}
      dropCampaigns @include(if: $fetchRewardCampaigns) ${TWITCH_CAMPAIGN_FIELDS}
    }
  }
}`;

// An edge whose node lacks the ids we count by would silently undercount claims,
// so treat a malformed connection as a schema mismatch rather than parsing it.
function hasValidEarnedDropRewards(value: unknown): boolean {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  const edges = value.edges;
  if (edges == null) return true;
  if (!Array.isArray(edges)) return false;
  return edges.every((edge) => {
    if (!isRecord(edge)) return false;
    const node = edge.node;
    if (node == null) return true;
    if (!isRecord(node)) return false;
    const item = node.item;
    const campaign = node.campaign;
    return (
      (typeof node.id === "string" || (isRecord(item) && typeof item.id === "string"))
      && (campaign == null || isRecord(campaign))
    );
  });
}

export const twitchInventoryV2 = twitchInventoryCapability(
  {
    id: "twitch-inventory-v2",
    // The hash Twitch's own web client uses for Inventory; its stored query already
    // returns earnedDropRewards alongside the fields v1 relies on. The inline query
    // above is the fallback when the persisted query is not found, and additionally
    // requests dropCampaigns, which the stored query omits.
    hash: "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404",
    variables: Object.freeze({ fetchRewardCampaigns: false }),
    inlineQuery: INLINE_QUERY,
  },
  { ...twitchInventoryFieldChecks, earnedDropRewards: hasValidEarnedDropRewards },
);
