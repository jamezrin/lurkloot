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

export const twitchInventoryV1 = twitchInventoryCapability({
  id: "twitch-inventory-v1",
  hash: "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b",
  variables: Object.freeze({ fetchRewardCampaigns: false }),
  inlineQuery: INLINE_QUERY,
}, twitchInventoryFieldChecks);
