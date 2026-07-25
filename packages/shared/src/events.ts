import type { CriticalFailureReason } from "./criticalHealth";
import type { LogLevel } from "./logging";
import type { Platform, PlatformAuthReasonCode, PlatformAuthStatus } from "./models";

export type FarmingStopReason =
  | "automation_disabled"
  | "platform_disabled"
  | "authentication_unhealthy"
  | "platform_backoff"
  | "platform_error"
  | "campaign_ineligible"
  | "channel_excluded"
  | "channel_offline"
  | "channel_mismatch"
  | "watch_unhealthy"
  | "higher_priority_reward"
  | "higher_priority_idle_watchlist"
  | "watch_requirement_completed"
  | "runtime_restart"
  | "target_changed"
  | "manual_watch"
  // A managed-tab reopen loop was detected; the platform is parked until the
  // breaker releases or the user dismisses the prompt.
  | "critical_failure";

type CampaignRewardData = {
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
};

export type PageContextOpenReason = "background_rejected" | "managed_context_unusable";

export type PageContextCloseReason =
  | "background_recovered"
  | "user_tab_available"
  | "platform_disabled"
  | "automation_disabled"
  | "manual_watch"
  | "authentication_unhealthy"
  | "runtime_restart"
  | "managed_context_unusable";

export type ActivityEvent =
  | { category: "activity"; code: "farming_started"; level: "info"; platform: Platform; message?: never; data: CampaignRewardData & { channel?: string } }
  | { category: "activity"; code: "farming_stopped"; level: "info" | "warn" | "error"; platform: Platform; message?: never; data: CampaignRewardData & { reason: FarmingStopReason } }
  | { category: "activity"; code: "reward_claimed"; level: "info"; platform: Platform; message?: never; data: CampaignRewardData & { method: "automatic" | "manual" } }
  | { category: "activity"; code: "interruption"; level: "warn" | "error"; platform?: Platform; message?: never; data: { reason: FarmingStopReason; detail?: string } }
  | { category: "activity"; code: "challenge_claimed"; level: "info"; platform: Platform; message?: never; data: { challengeId: string; rarity: string; recurrence: string } }
  | { category: "activity"; code: "page_context_opened"; level: "info"; platform: Platform; message?: never; data: { host: string; reason: PageContextOpenReason } }
  | { category: "activity"; code: "page_context_closed"; level: "info"; platform: Platform; message?: never; data: { host: string; reason: PageContextCloseReason } }
  | { category: "activity"; code: "auth_health_changed"; level: "info" | "warn" | "error"; platform: Platform; message?: never; data: { from: PlatformAuthStatus; to: PlatformAuthStatus; reason?: PlatformAuthReasonCode } }
  | { category: "activity"; code: "critical_failure_detected"; level: "error"; platform: Platform; message?: never; data: { reason: CriticalFailureReason } }
  | { category: "activity"; code: "critical_failure_cleared"; level: "info"; platform: Platform; message?: never; data: { reason: CriticalFailureReason } };

export type DiagnosticEvent = {
  category: "diagnostic";
  level: LogLevel;
  platform?: Platform;
  message: string;
  code?: string;
  data?: Record<string, string | number | boolean | undefined>;
  compatibilityProfile?: string;
  compatibilityCapability?: string;
  compatibilityCapabilities?: readonly string[];
  compatibilityVersion?: string;
};

export type EventCategory = EngineEvent["category"];
export type EngineEvent = ActivityEvent | DiagnosticEvent;
export type EventEmitter = (event: EngineEvent) => void;
export type EventReporter = (events: readonly EngineEvent[]) => void | Promise<void>;
export type StoredEngineEvent = EngineEvent & { id: string; at: string };

export interface LegacyEventLogEntry {
  id: string;
  at: string;
  platform?: Platform;
  level: LogLevel;
  message: string;
  category?: "activity" | "diagnostic";
  code?: string;
  data?: Record<string, string | number | boolean | undefined>;
}

export type StoredLegacyEvent = LegacyEventLogEntry & { legacy: true };
export type ActivityHistoryRecord = StoredEngineEvent | StoredLegacyEvent;
