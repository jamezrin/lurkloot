import type { CategorySelection, EngineSettings, ExtensionSettings, Platform, PlaybackTelemetry, SchedulerState } from "./models";
import type { SettingsPatch } from "./settings";

export const SETTINGS_SESSION_PORT = "lurkloot.settings-session";

export type RuntimeMessage =
  | { type: "getSnapshot" }
  | { type: "getPlaybackControl"; platform: Platform }
  | { type: "setRunning"; running: boolean }
  | { type: "setPlatformEnabled"; platform: Platform; enabled: boolean }
  | { type: "setAutomation"; platform: Platform; enabled: boolean }
  | { type: "saveSettings"; settingsPatch: SettingsPatch; tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }
  | { type: "claimReward"; platform: Platform; campaignId: string; rewardId: string }
  | { type: "searchCategories"; platform: Platform; query: string }
  | { type: "tickNow" }
  | { type: "exportCliCredentials" }
  | {
      type: "playbackTelemetry";
      platform: Platform;
      telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">;
    };

// Credential blob the popup exports for the headless CLI's `login --import`. It
// carries only the session tokens the CLI transports replay — never anything the
// config holds — and is produced from the user's live cookies on explicit,
// confirm-gated request.
export interface CliCredentialBlob {
  version: number;
  credentials: {
    twitch?: { authToken?: string; deviceId?: string };
    kick?: { sessionToken?: string };
  };
}

// Parametrized over the host's settings type so the generic background
// controller can return its own `S`. Defaults to ExtensionSettings, the only
// host that consumes a snapshot (the popup), so existing usages are unchanged.
export interface RuntimeSnapshot<S extends EngineSettings = ExtensionSettings> {
  settings: S;
  state: SchedulerState;
}

export interface CategorySearchResult {
  categories: CategorySelection[];
}

export interface PlaybackControl {
  managed: boolean;
  keepVideosUnmuted: boolean;
}
