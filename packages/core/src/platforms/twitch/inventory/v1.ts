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

const INLINE_QUERY = `query Inventory($fetchRewardCampaigns: Boolean!) {
  currentUser {
    id
    inventory {
      gameEventDrops { id benefit { id } lastAwardedAt }
      dropCampaignsInProgress ${TWITCH_CAMPAIGN_FIELDS}
      dropCampaigns @include(if: $fetchRewardCampaigns) ${TWITCH_CAMPAIGN_FIELDS}
    }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isV1Reward(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string";
}

function isV1Campaign(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  const rewards = value.timeBasedDrops;
  return rewards == null || (Array.isArray(rewards) && rewards.every(isV1Reward));
}

function hasValidEntries(field: string, value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return field === "gameEventDrops"
    ? value.every((entry) => isRecord(entry) && typeof entry.id === "string")
    : value.every(isV1Campaign);
}

function hasV1Schema(response: unknown): boolean {
  if (!isRecord(response) || !isRecord(response.data)) return false;
  const currentUser = response.data.currentUser;
  if (currentUser === null) return true;
  if (!isRecord(currentUser) || !isRecord(currentUser.inventory)) return false;
  const inventory = currentUser.inventory;
  const fields = ["dropCampaignsInProgress", "dropCampaigns", "gameEventDrops"];
  const presentFields = fields.filter((field) => Object.prototype.hasOwnProperty.call(inventory, field));
  return presentFields.length > 0
    && presentFields.every((field) => hasValidEntries(field, inventory[field]));
}

export const twitchInventoryV1: TwitchInventoryCapability = {
  id: "twitch-inventory-v1",
  hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b",
  variables: Object.freeze({ fetchRewardCampaigns: false }),
  inlineQuery: INLINE_QUERY,
  parse(response) {
    if (!hasV1Schema(response)) {
      throw new Error("twitch-inventory-v1 inventory response schema mismatch");
    }
    return parseTwitchInventory(response as Parameters<typeof parseTwitchInventory>[0]);
  },
  reconcileProgress(campaigns, response) {
    if (!hasV1Schema(response)) {
      throw new Error("twitch-inventory-v1 inventory response schema mismatch");
    }
    return mergeTwitchCampaignProgress(
      campaigns,
      response as Parameters<typeof mergeTwitchCampaignProgress>[1],
    );
  },
};
