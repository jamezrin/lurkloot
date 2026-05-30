import type {
  ChannelCandidate,
  ChannelCheck,
  DropCampaign,
  DropReward,
  Platform,
  WatchSession,
} from "../core/models";

export interface PreparedWatchTab {
  tabId: number;
  managedByExtension: boolean;
}

export interface WatchTabOptions {
  muted: boolean;
  closeManagedTabs: boolean;
}

export interface PlatformAdapter {
  platform: Platform;
  discoverCampaigns(): Promise<DropCampaign[]>;
  readProgress(campaigns: DropCampaign[], session?: WatchSession): Promise<DropCampaign[]>;
  listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]>;
  checkChannel(channel: ChannelCandidate, campaign?: DropCampaign): Promise<ChannelCheck>;
  claimReward(campaign: DropCampaign, reward: DropReward): Promise<boolean>;
  claimChannelPoints?(channel: ChannelCandidate): Promise<boolean>;
  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab>;
  stopWatchTab?(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void>;
}

export interface PageFetcher {
  fetchJson<T>(url: string, init?: RequestInit): Promise<T>;
}
