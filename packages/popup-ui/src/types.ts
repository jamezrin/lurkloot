import type { CliCredentialBlob, RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { CategorySelection, ClaimGuidance, CompatibilitySettings, DropCampaign, Platform, RewardRequirementType, SupportedLocale, TwitchExtensionProviderId } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { SettingsExportPayload } from "@lurkloot/shared/settingsExport";
import type { CampaignFarmingEvaluation } from "@lurkloot/shared/campaignFarming";
import type { CampaignSection } from "@lurkloot/shared/campaignFilters";
import type { CampaignRankTier } from "@lurkloot/shared/ranking";
import type { PopupView } from "./shell";

export type CompatibilityLifecycle = "recommended" | "legacy" | "experimental";
export interface CompatibilityOptionMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly lifecycle: CompatibilityLifecycle;
  readonly hosts: readonly string[];
  readonly identities?: readonly string[];
  // Set on superseded options: the id that replaces this one. Surfaced so a
  // legacy selection says what to move to.
  readonly replacement?: string;
}
export interface PopupCompatibilityRegistry {
  readonly twitch: {
    readonly profiles: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly heartbeat: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly inventory: Readonly<Record<string, CompatibilityOptionMetadata>>;
  };
  readonly kick: {
    readonly profiles: Readonly<Record<string, CompatibilityOptionMetadata>>;
    readonly claim: Readonly<Record<string, CompatibilityOptionMetadata>>;
  };
}
export interface PopupCompatibilityResolution {
  readonly compatibility: {
    readonly twitch: { readonly profile: string; readonly heartbeat: string; readonly inventory: string };
    readonly kick: { readonly profile: string; readonly claim: string };
  };
  readonly warnings: readonly unknown[];
}

export type GameItem = {
  id: string;
  name: string;
  short: string;
  accent: string;
  imageUrl?: string;
};
export type StreamerItem = { id: string; name: string; live: boolean; subtitle?: string; viewers?: number };
export type FarmingChannelView = { name: string; category?: string; viewers?: number; url?: string };
export type ChannelLink = { name: string; url: string };
export type RewardView = {
  id: string;
  name: string;
  progress?: number;
  requiredMinutes: number;
  requiredSubs?: number;
  requirement: RewardRequirementType;
  obtained: boolean;
  // The user marked this subscription reward as subscribed.
  subscriptionMarked?: boolean;
  // The reward can be marked (or unmarked): a subscription reward the platform
  // has not released.
  canMarkSubscription?: boolean;
  art: string;
  tint: string;
  imageUrl?: string;
  claimGuidance?: ClaimGuidance;
  ineligibilityReason?: "insufficient_time";
  // Rewards that must be claimed before this one starts counting (Twitch).
  preconditionIds?: string[];
};
export type CampaignLifecycleState = "upcoming" | "expired" | "finished";

export type CampaignStats = {
  kind: "watch" | "subscription" | "mixed" | "action";
  totalRequired: number;
  totalFarmed: number;
  remaining: number;
  progress?: number;
  completed: number;
  totalRewards: number;
  nextReward?: RewardView;
  nextRewardRemaining?: number;
  complete: boolean;
};

export type CampaignTimelineMarker = {
  id: string;
  name: string;
  // Where on the campaign's watch timeline the reward becomes claimable, 0–1.
  at: number;
  reached: boolean;
};

export type CampaignTimeline = {
  // How far along the watch timeline the campaign is, 0–1.
  progress: number;
  totalMinutes: number;
  remainingMinutes: number;
  markers: CampaignTimelineMarker[];
};

export type CampaignView = {
  id: string;
  gameId: string;
  title: string;
  status: DropCampaign["status"];
  lifecycle?: CampaignLifecycleState;
  linked: boolean;
  // The org account-link URL (Kick connect_url / Twitch accountLinkURL), when the
  // campaign actually requires linking. Absent when there is nothing to link.
  linkUrl?: string;
  // The campaign's info/landing page, when one is provided.
  pageUrl?: string;
  // pageUrl's host when it is off the campaign's platform, such as a
  // publisher's own site.
  pageHost?: string;
  // Twitch's Drops-filtered directory page for the campaign's game. Twitch
  // only: Kick has no equivalent page.
  categoryDropsUrl?: string;
  excluded: boolean;
  // Which tier of the shared ranking placed this campaign, and whether the user
  // pinned it by hand. The list labels its group dividers from these.
  pinned: boolean;
  // Zero-based place among the pins, and among the favourite games; absent
  // when the campaign is not pinned or its game is not a favourite. The card's
  // "why this rank" line reads these.
  pinIndex?: number;
  favouriteIndex?: number;
  // The campaign's category as the settings lists store it, for starring or
  // blocking the game from the card. Absent for uncategorized campaigns.
  category?: CategorySelection;
  categoryBlocked?: boolean;
  favourited?: boolean;
  rankTier: CampaignRankTier;
  section: CampaignSection;
  starts: string;
  ends: string;
  // All channels this drop is restricted to, each with a link to its page. Empty
  // for general drops (farmable on any channel in the category).
  channels: ChannelLink[];
  farmingChannel?: FarmingChannelView;
  thumbnail: string;
  tint: string;
  imageUrl?: string;
  rewards: RewardView[];
  hasWatchRewards: boolean;
  hasSubscriptionRewards: boolean;
  farmingRejection?: Extract<CampaignFarmingEvaluation, { farmable: false }>;
  // What will still block the campaign once the rejection above is fixed in
  // Lurkloot, in the order the user would meet it (#677). Empty when fixing it
  // is enough, or there is nothing to fix.
  laterBlockers?: Array<Extract<CampaignFarmingEvaluation, { farmable: false }>>;
  // Nothing in the user's settings holds it back any more: what does is a
  // blocker only they can clear outside Lurkloot (a subscription, an account
  // link, another action), so the Queue lists it under "Action required", not
  // "Skipped". A campaign their own settings skip stays in Skipped, with
  // `laterBlockers` saying what would still be needed.
  needsOutsideAction?: boolean;
};

export type TFunction = (key: string, substitutions?: string | string[]) => string;

export type ScreenshotLayout = "hero" | "extras" | "steps" | "settings" | "updated";

type ScreenshotCopy = {
  glow: string;
  eyebrowKey: string;
  headlineKey: string;
  subcopyKey: string;
};

export type ScreenshotPopupVariant = ScreenshotCopy & {
  layout: "hero" | "extras" | "steps" | "settings";
  platform: Platform;
  view: "drops" | "settings" | "watchlist";
};

export type ScreenshotMarketingVariant = ScreenshotCopy & {
  layout: "updated";
};

export type ScreenshotVariant = ScreenshotPopupVariant | ScreenshotMarketingVariant;

export function variantShowsPopup(variant: ScreenshotVariant): variant is ScreenshotPopupVariant {
  return variant.layout !== "updated";
}

// The change that starts Twitch HLS watching. Recorded before the permission
// prompt so a closed popup can still apply it after the user allows the host.
export type TwitchHlsGrantIntent =
  | { type: "setAutomation"; platform: "twitch"; enabled: true }
  | { type: "saveSettings"; settingsPatch: SettingsPatch; tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] };

export interface PopupAdapter {
  requestTwitchExtensionPermission?(provider: TwitchExtensionProviderId): Promise<boolean>;
  version: string;
  send<T>(message: RuntimeMessage): Promise<T>;
  getStorage(keys?: string | string[]): Promise<Record<string, unknown>>;
  setStorage(values: Record<string, unknown>): Promise<void>;
  getMessage(key: string, substitutions?: string | string[]): string;
  getUiLanguage(): string;
  openLink(url: string): void;
  // Optional extension lifecycle hooks. Demo/site hosts omit these, which also
  // keeps update notices out of screenshots and the landing-page popup demo.
  getPendingChangelogVersion?(): Promise<string | undefined>;
  dismissPendingChangelogVersion?(): Promise<void>;
  changelogUrl?(version: string): string;
  // Optional: download/persist an exported credential blob for the headless CLI.
  // Only the live extension implements it (the demo omits it, hiding the action).
  exportCredentials?(blob: CliCredentialBlob): void;
  // Optional: ask for the extra host the credential export reads Twitch's Kasada
  // cookie from. Called synchronously in the click that arms the export, a
  // separate click from the download. Resolves false when the user declines.
  requestCredentialExportPermission?(): Promise<boolean>;
  // Optional: ask for Twitch's video CDN. Called synchronously in the gesture
  // that would start watching Twitch with the HLS heartbeat. The argument is
  // the change to apply once the grant exists, including when the permission
  // dialog closes this popup. Resolves false when the user declines; that
  // decline leaves Twitch off, or leaves a non-HLS heartbeat in place.
  requestTwitchHlsPermission?(intent: TwitchHlsGrantIntent): Promise<boolean>;
  // Optional: download the current settings as a portable JSON file. Only the
  // live extension implements it (the demo omits it, hiding the action).
  exportSettings?(payload: SettingsExportPayload): void;
  // Optional: prompt the user for a settings file and resolve its raw parsed
  // JSON contents (or null if they cancel the picker). Validation/migration of
  // the result happens in Popup.tsx via @lurkloot/shared/settingsExport, not
  // here, so this stays a thin file-read.
  importSettings?(): Promise<unknown | null>;
  // Optional: write text to the system clipboard, resolving to whether it
  // worked. Hosts that omit it (the site demo) make the critical-failure panel
  // fall back to a selectable textarea instead of pretending the copy succeeded.
  writeClipboard?(text: string): Promise<boolean>;
  // Optional: download a text file from the popup. The live extension implements
  // it with a Blob URL; hosts that omit it (the site demo) hide Export all.
  downloadFile?(filename: string, contents: string, mimeType?: string): void;
  resetExtension?(): Promise<RuntimeSnapshot>;
  compatibilityRegistry?: PopupCompatibilityRegistry;
  resolveCompatibility?(settings: CompatibilitySettings): PopupCompatibilityResolution;
}

export interface PopupInitialState {
  preview?: boolean;
  locale?: SupportedLocale | null;
  variant?: ScreenshotVariant;
  // Preview only: open on this view instead of the variant's. The landing page
  // uses it to show real panels (games, watchlist…) beside its copy.
  view?: PopupView;
}
