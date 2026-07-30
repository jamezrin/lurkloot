import type { TwitchInventoryId } from "../../../compatibility/types";
import type { TwitchInventoryCapability } from "./types";
import { twitchInventoryV1 } from "./v1";
import { twitchInventoryV2 } from "./v2";

export function createTwitchInventory(capabilityId: TwitchInventoryId): TwitchInventoryCapability {
  switch (capabilityId) {
    case "twitch-inventory-v1":
      return twitchInventoryV1;
    case "twitch-inventory-v2":
      return twitchInventoryV2;
    default: {
      const exhaustive: never = capabilityId;
      throw new Error(`Unsupported Twitch inventory capability: ${String(exhaustive)}`);
    }
  }
}
