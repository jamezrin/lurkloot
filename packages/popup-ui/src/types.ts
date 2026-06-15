import type { RuntimeMessage } from "@lurkloot/shared/messages";
import type { DropCampaign, Platform, SupportedLocale } from "@lurkloot/shared/models";

export type PopupTab = "drops" | "watchQueue";
export type GameItem = { id: string; name: string; short: string; accent: string };
export type StreamerItem = { id: string; name: string; live: boolean; subtitle?: string; viewers?: number };
export type FarmingChannelView = { name: string; category?: string; viewers?: number; url?: string };
export type ChannelLink = { name: string; url: string };
export type RewardView = { id: string; name: string; progress: number; requiredMinutes: number; obtained: boolean; art: string; tint: string; imageUrl?: string };
export type CampaignLifecycleState = "upcoming" | "expired" | "finished";

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
  excluded: boolean;
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
};

export type TFunction = (key: string, substitutions?: string | string[]) => string;

export type ScreenshotView = "drops" | "watchQueue" | "settings" | "activity";

export type ScreenshotVariant = {
  platform: Platform;
  view: ScreenshotView;
  accentGradient: string;
  headlineKey: string;
  subcopyKey: string;
};

export interface PopupAdapter {
  version: string;
  send<T>(message: RuntimeMessage): Promise<T>;
  getStorage(keys?: string | string[]): Promise<Record<string, unknown>>;
  setStorage(values: Record<string, unknown>): Promise<void>;
  connectSettingsSession?(): () => void;
  getMessage(key: string, substitutions?: string | string[]): string;
  getUiLanguage(): string;
}

export interface PopupInitialState {
  preview?: boolean;
  locale?: SupportedLocale | null;
  variant?: ScreenshotVariant;
}
