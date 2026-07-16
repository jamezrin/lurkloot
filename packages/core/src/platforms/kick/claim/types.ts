import type { DropCampaign, DropReward } from "@lurkloot/shared/models";

export type KickClaimOutcome =
  | { kind: "claimed" }
  | { kind: "not_claimed" }
  | { kind: "link_required"; url: string };

export interface KickClaimCapability {
  classify(response: unknown, campaign: DropCampaign): KickClaimOutcome;
  isSuppressed?(campaign: DropCampaign, reward: DropReward): boolean;
  suppress?(campaign: DropCampaign, reward: DropReward, url: string): void;
  reconcileProgress?(campaigns: DropCampaign[], affirmativelyLinkedCampaignIds: ReadonlySet<string>): DropCampaign[];
}

export function isKickClaimSuccess(response: unknown): boolean {
  if (!isRecord(response)) return false;
  if (response.success === true) return true;
  if (typeof response.message === "string" && /success/i.test(response.message)) return true;
  return isRecord(response.data) && response.data.id != null;
}

export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
