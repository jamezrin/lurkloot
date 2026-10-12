import { isRecord } from "@lurkloot/shared/records";
import { mergeTwitchCampaignProgress, parseTwitchInventory } from "../parser";
import type { TwitchInventoryCapability } from "./types";

type InventoryFieldCheck = (value: unknown) => boolean;

function hasId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function isCampaign(value: unknown): boolean {
  if (!hasId(value)) return false;
  const rewards = value.timeBasedDrops;
  return rewards == null || (Array.isArray(rewards) && rewards.every(hasId));
}

function nullOrEvery(check: (entry: unknown) => boolean): InventoryFieldCheck {
  return (value) => value === null || (Array.isArray(value) && value.every(check));
}

export const twitchInventoryFieldChecks: Readonly<Record<string, InventoryFieldCheck>> = {
  dropCampaignsInProgress: nullOrEvery(isCampaign),
  dropCampaigns: nullOrEvery(isCampaign),
  gameEventDrops: nullOrEvery(hasId),
};

function hasInventorySchema(response: unknown, fieldChecks: Readonly<Record<string, InventoryFieldCheck>>): boolean {
  if (!isRecord(response) || !isRecord(response.data)) return false;
  const currentUser = response.data.currentUser;
  if (currentUser === null) return true;
  if (!isRecord(currentUser) || !isRecord(currentUser.inventory)) return false;
  const inventory = currentUser.inventory;
  const presentFields = Object.keys(fieldChecks).filter((field) => Object.hasOwn(inventory, field));
  return presentFields.length > 0
    && presentFields.every((field) => fieldChecks[field](inventory[field]));
}

export function twitchInventoryCapability(
  query: Pick<TwitchInventoryCapability, "id" | "hash" | "variables" | "inlineQuery">,
  fieldChecks: Readonly<Record<string, InventoryFieldCheck>>,
): TwitchInventoryCapability {
  const checked = (response: unknown) => {
    if (!hasInventorySchema(response, fieldChecks)) {
      throw new Error(`${query.id} inventory response schema mismatch`);
    }
    return response;
  };
  return {
    ...query,
    parse: (response) => parseTwitchInventory(checked(response) as Parameters<typeof parseTwitchInventory>[0]),
    reconcileProgress: (campaigns, response) =>
      mergeTwitchCampaignProgress(campaigns, checked(response) as Parameters<typeof mergeTwitchCampaignProgress>[1]),
  };
}
