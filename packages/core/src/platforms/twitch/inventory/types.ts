import type { DropCampaign } from "@lurkloot/shared/models";

export interface TwitchInventoryCapability {
  readonly id: "twitch-inventory-v1" | "twitch-inventory-v2";
  readonly hash: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly inlineQuery: string;
  parse(response: unknown): DropCampaign[];
  reconcileProgress(campaigns: DropCampaign[], response: unknown): DropCampaign[];
}
