import { mergeTwitchCampaignProgress, parseTwitchInventory } from "../parser";
import type { TwitchInventoryCapability } from "./types";

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
  allow { channels { name login } }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isV2Reward(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string";
}

function isV2Campaign(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  const rewards = value.timeBasedDrops;
  return rewards == null || (Array.isArray(rewards) && rewards.every(isV2Reward));
}

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
    return (typeof node.id === "string" || (isRecord(item) && typeof item.id === "string"))
      && (campaign == null || isRecord(campaign));
  });
}

function hasValidEntries(field: string, value: unknown): boolean {
  if (field === "earnedDropRewards") return hasValidEarnedDropRewards(value);
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return field === "gameEventDrops"
    ? value.every((entry) => isRecord(entry) && typeof entry.id === "string")
    : value.every(isV2Campaign);
}

function hasV2Schema(response: unknown): boolean {
  if (!isRecord(response) || !isRecord(response.data)) return false;
  const currentUser = response.data.currentUser;
  if (currentUser === null) return true;
  if (!isRecord(currentUser) || !isRecord(currentUser.inventory)) return false;
  const inventory = currentUser.inventory;
  const fields = ["dropCampaignsInProgress", "dropCampaigns", "gameEventDrops", "earnedDropRewards"];
  const presentFields = fields.filter((field) => Object.prototype.hasOwnProperty.call(inventory, field));
  return presentFields.length > 0
    && presentFields.every((field) => hasValidEntries(field, inventory[field]));
}

export const twitchInventoryV2: TwitchInventoryCapability = {
  id: "twitch-inventory-v2",
  // The hash Twitch's own web client uses for Inventory; its stored query already
  // returns earnedDropRewards alongside the fields v1 relies on. The inline query
  // above is the fallback when the persisted query is not found, and additionally
  // requests dropCampaigns, which the stored query omits.
  hash: "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404",
  variables: Object.freeze({ fetchRewardCampaigns: false }),
  inlineQuery: INLINE_QUERY,
  parse(response) {
    if (!hasV2Schema(response)) {
      throw new Error("twitch-inventory-v2 inventory response schema mismatch");
    }
    return parseTwitchInventory(response as Parameters<typeof parseTwitchInventory>[0]);
  },
  reconcileProgress(campaigns, response) {
    if (!hasV2Schema(response)) {
      throw new Error("twitch-inventory-v2 inventory response schema mismatch");
    }
    return mergeTwitchCampaignProgress(
      campaigns,
      response as Parameters<typeof mergeTwitchCampaignProgress>[1],
    );
  },
};
