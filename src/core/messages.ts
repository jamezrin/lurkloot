import type { ExtensionSettings, Platform, PlaybackTelemetry, SchedulerState } from "./models";

export type RuntimeMessage =
  | { type: "getSnapshot" }
  | { type: "getPlaybackControl"; platform: Platform }
  | { type: "setRunning"; running: boolean }
  | { type: "setPlatformEnabled"; platform: Platform; enabled: boolean }
  | { type: "setAutomation"; platform: Platform; enabled: boolean }
  | { type: "saveSettings"; settings: ExtensionSettings; tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }
  | { type: "claimReward"; platform: Platform; campaignId: string; rewardId: string }
  | { type: "tickNow" }
  | {
      type: "playbackTelemetry";
      platform: Platform;
      telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">;
    };

export interface RuntimeSnapshot {
  settings: ExtensionSettings;
  state: SchedulerState;
}

export interface PlaybackControl {
  managed: boolean;
}
