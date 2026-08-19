import type { ActivityHistoryRecord, EventCategory } from "./events";
import type { CategorySelection, EngineSettings, ExtensionSettings, Platform, PlaybackTelemetry, SchedulerState } from "./models";
import type { SettingsPatch } from "./settings";

export type CoreRuntimeMessage =
  | { type: "getSnapshot" }
  | { type: "getPlaybackControl"; platform: Platform }
  | { type: "setPlatformEnabled"; platform: Platform; enabled: boolean }
  | { type: "setAutomation"; platform: Platform; enabled: boolean }
  | { type: "saveSettings"; settingsPatch: SettingsPatch; tickAfterSave?: boolean; tickAfterSavePlatforms?: Platform[] }
  | { type: "claimReward"; platform: Platform; campaignId: string; rewardId: string }
  | { type: "searchCategories"; platform: Platform; query: string }
  | { type: "tickNow" }
  | { type: "resumeAfterManualClose"; platform: Platform }
  // Handled by the engine controller, not the extension shell: dismissing resets
  // the detector, closes the managed-tab breaker and lets farming resume.
  | { type: "dismissCriticalFailure"; platform: Platform }
  | {
      type: "playbackTelemetry";
      platform: Platform;
      telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">;
    };

export type RuntimeMessage =
  | CoreRuntimeMessage
  | ({ type: "getActivity" } & ActivityQuery)
  | { type: "exportDiagnostics"; platform: Platform }
  | { type: "clearActivity" }
  | { type: "resetExtension" }
  | { type: "exportCliCredentials" };

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

export interface ActivityQuery {
  platform?: Platform;
  category: EventCategory;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ActivityPage {
  events: ActivityHistoryRecord[];
  nextCursor?: string;
}

export interface DiagnosticsExport {
  events: ActivityHistoryRecord[];
}
