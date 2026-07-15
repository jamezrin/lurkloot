import type { KickClaimId } from "../../../compatibility/types";
import type { KickClaimCapability } from "./types";
import { kickClaimV1 } from "./v1";
import { kickClaimV2 } from "./v2";

export function createKickClaimCapability(id: KickClaimId): KickClaimCapability {
  switch (id) {
    case "kick-claim-v1":
      return kickClaimV1;
    case "kick-claim-v2":
      return kickClaimV2;
  }
}
