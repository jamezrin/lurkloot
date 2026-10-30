import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { TwitchExtensionProviderId } from "@lurkloot/shared/models";
import type { RewardDetail, RewardObtainedData } from "@lurkloot/shared/rewardEvents";
import type { TFunction } from "./types";

// How a reward is drawn. A kind without its own layout is shown as "generic",
// from the general fields every reward event carries.
export type RewardLayout = "drop" | "card" | "pack" | "item" | "generic";

export interface RewardChip {
  label: string;
  tone?: "rarity" | "highlight";
}

export interface RewardView {
  layout: RewardLayout;
  title: string;
  imageUrl?: string;
  // A second, smaller picture over the corner of the first: a drop's game.
  overlayImageUrl?: string;
  subtitle?: string;
  chips: RewardChip[];
  rarity?: string;
  linkUrl?: string;
}

const PROVIDER_LABELS: Record<TwitchExtensionProviderId, string> = {
  nopixel: "NoPixelV",
  fortnite: "Fortnite",
};

const EDITION_KEYS: Record<string, string> = {
  normal: "rewardEditionNormal",
  gold: "rewardEditionGold",
  legendary: "rewardEditionLegendary",
};

function capitalized(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

function joined(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join(" · ") : undefined;
}

function detail(details: RewardDetail[] | undefined, key: string): RewardDetail | undefined {
  return details?.find((entry) => entry.key === key);
}

function sourceLabel(data: RewardObtainedData): string | undefined {
  return data.source.extension ? PROVIDER_LABELS[data.source.extension] : undefined;
}

// Whether an activity row is a reward (listed under Rewards) rather than a
// status row. Includes the legacy codes rows stored before reward_obtained.
export function isRewardEvent(event: ActivityHistoryRecord): boolean {
  if ("legacy" in event || event.category !== "activity") return false;
  switch (event.code) {
    case "reward_claimed":
    case "reward_obtained":
    case "challenge_claimed":
      return true;
    case "twitch_extension_action":
      return event.data.action !== "takeover_started";
    default:
      return false;
  }
}

function obtainedView(data: RewardObtainedData, t: TFunction): RewardView {
  const via = sourceLabel(data);
  const base = { imageUrl: data.imageUrl, subtitle: joined([via, data.channel]) };
  switch (data.kind) {
    case "challenge_card": {
      const rarity = data.rarity ?? "unknown";
      const recurrence = detail(data.details, "recurrence");
      const consolation = detail(data.details, "consolationMinutes");
      return {
        ...base,
        layout: "card",
        title: t("rewardCardTitle", capitalized(rarity)),
        rarity,
        chips: [
          { label: capitalized(rarity), tone: "rarity" },
          ...(recurrence ? [{ label: String(recurrence.value) }] : []),
          ...(consolation
            ? [{ label: t("rewardConsolationMinutes", String(consolation.value)) }]
            : []),
        ],
      };
    }
    case "extension_pack":
      return {
        ...base,
        layout: "pack",
        title: t("rewardPackTitle", String(data.amount ?? 0)),
        chips: (data.details ?? [])
          .filter((entry) => entry.key.startsWith("edition_"))
          .map((entry) => {
            const edition = entry.key.slice("edition_".length);
            const key = EDITION_KEYS[edition];
            return {
              label: key ? t(key, String(entry.value)) : `${entry.value} ${edition}`,
              ...(edition !== "normal" ? { tone: "rarity" as const } : {}),
            };
          }),
      };
    case "extension_capture":
      return { ...base, layout: "item", title: data.name ?? t("rewardCaptureTitle"), chips: [] };
    case "extension_giveaway":
      return { ...base, layout: "item", title: data.name ?? t("rewardGiveawayTitle"), chips: [] };
    default:
      return {
        ...base,
        layout: "generic",
        title: data.name ?? t("rewardGenericTitle"),
        chips: (data.details ?? []).map((entry) => ({ label: `${entry.key}: ${entry.value}` })),
      };
  }
}

// The reward registry: every reward-bearing activity code, current and legacy,
// mapped to one view. Status rows give undefined.
export function buildRewardView(
  event: ActivityHistoryRecord,
  t: TFunction,
): RewardView | undefined {
  if (!isRewardEvent(event) || "legacy" in event || event.category !== "activity") return undefined;
  switch (event.code) {
    case "reward_claimed":
      return {
        layout: "drop",
        title: event.data.rewardName,
        imageUrl: event.data.rewardImageUrl,
        overlayImageUrl: event.data.gameImageUrl,
        subtitle: joined([event.data.gameName, event.data.campaignName, event.data.channel]),
        chips: [{ label: event.data.method }],
        linkUrl: event.data.campaignUrl,
      };
    case "reward_obtained":
      return obtainedView(event.data, t);
    case "challenge_claimed":
      return {
        layout: "card",
        title: t("rewardCardTitle", capitalized(event.data.rarity)),
        rarity: event.data.rarity,
        chips: [
          { label: capitalized(event.data.rarity), tone: "rarity" },
          { label: event.data.recurrence },
        ],
      };
    case "twitch_extension_action": {
      // Stored before reward_obtained: no counts or art, so the row keeps the
      // sentence it was written with.
      const key = {
        pack_opened: "activityExtensionPackOpened",
        giveaway_joined: "activityExtensionGiveawayJoined",
        sprite_captured: "activityExtensionSpriteCaptured",
        takeover_started: "activityExtensionTakeoverStarted",
      }[event.data.action];
      return {
        layout: event.data.action === "pack_opened" ? "pack" : "item",
        title: t(key, [PROVIDER_LABELS[event.data.provider], event.data.channel]),
        chips: [],
      };
    }
    default:
      return undefined;
  }
}

// The one-line title of a listed reward, for the plain-text activity export.
export function rewardTitle(event: ActivityHistoryRecord, t: TFunction): string {
  return buildRewardView(event, t)?.title ?? "";
}
