import type { KickClaimCapability, KickClaimOutcome } from "./types";
import { isKickClaimSuccess, safeHttpsUrl } from "./types";

export const kickClaimV1: KickClaimCapability = {
  classify(response, campaign): KickClaimOutcome {
    if (isKickClaimSuccess(response)) return { kind: "claimed" };
    if (campaign.accountLinked === false) {
      const url = safeHttpsUrl(campaign.accountLinkUrl);
      if (url) return { kind: "link_required", url };
    }
    return { kind: "not_claimed" };
  },
};
