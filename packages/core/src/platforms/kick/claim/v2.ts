import type { KickClaimCapability, KickClaimOutcome } from "./types";
import { isKickClaimSuccess, isRecord, safeHttpsUrl } from "./types";
import { kickClaimV1 } from "./v1";

export const kickClaimV2: KickClaimCapability = {
  classify(response, campaign): KickClaimOutcome {
    if (isKickClaimSuccess(response)) return { kind: "claimed" };
    if (isRecord(response)) {
      const data = isRecord(response.data) ? response.data : undefined;
      for (const value of [response.connect_url, response.connectUrl, data?.connect_url, data?.connectUrl]) {
        const url = safeHttpsUrl(value);
        if (url) return { kind: "link_required", url };
      }
    }
    return kickClaimV1.classify(response, campaign);
  },
};
