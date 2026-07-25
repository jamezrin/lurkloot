import type { Platform } from "./models";

export type CriticalFailureReason = "no_progress" | "page_context_churn";

export type FailureRecordKind = "api_error" | "auth" | "context_open" | "watch_tab_open" | "no_accrual";

// One bounded, always-on breadcrumb. Recorded regardless of the diagnosticLogging
// setting (which defaults off), because the failure report is worthless without
// it. Never carries response bodies, tokens or cookies.
export interface FailureRecord {
  at: string;
  platform: Platform;
  kind: FailureRecordKind;
  code?: string;
  status?: number;
  detail?: string;
}

export interface CriticalHealthState {
  status: "ok" | "flagged";
  reason?: CriticalFailureReason;
  flaggedAt?: string;
  // Counters are deliberately NOT persisted: MV3 workers recycle constantly and
  // stale counters from an old outage must not accumulate across sessions.
  failingMs: number;
  failingTicks: number;
  // Written on every observation, accruing or not — it is the tick clock, not an accrual marker.
  lastObservedAt?: string;
  lastWatchedMinutes?: number;
  // Both managed page contexts and managed watch tabs, sharing one churn window.
  managedTabOpens: readonly string[];
  breakerOpen: boolean;
  dismissedAt?: string;
  cooldownUntil?: string;
  records: readonly FailureRecord[];
}

export const CRITICAL_HEALTH_RECORD_LIMIT = 30;
const FAILURE_RECORD_KINDS = new Set<FailureRecordKind>([
  "api_error",
  "auth",
  "context_open",
  "watch_tab_open",
  "no_accrual",
]);
const CRITICAL_FAILURE_REASONS = new Set<CriticalFailureReason>(["no_progress", "page_context_churn"]);
const DETAIL_MAX_LENGTH = 200;

// Deep-frozen: it is handed out by reference as the fallback for a platform that
// has no state yet, so a stray mutation would corrupt every platform at once.
export const DEFAULT_CRITICAL_HEALTH: CriticalHealthState = Object.freeze({
  status: "ok",
  failingMs: 0,
  failingTicks: 0,
  managedTabOpens: Object.freeze([]),
  breakerOpen: false,
  records: Object.freeze([]),
});

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function normalizeRecord(candidate: unknown): FailureRecord | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Record<string, unknown>;
  const at = isoOrUndefined(value.at);
  const platform = value.platform === "twitch" || value.platform === "kick" ? value.platform : undefined;
  const kind = FAILURE_RECORD_KINDS.has(value.kind as FailureRecordKind) ? (value.kind as FailureRecordKind) : undefined;
  if (!at || !platform || !kind) return undefined;
  const record: FailureRecord = { at, platform, kind };
  if (typeof value.code === "string" && value.code.length > 0 && value.code.length <= 64) record.code = value.code;
  if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
    record.status = value.status;
  }
  if (typeof value.detail === "string" && value.detail.length > 0) record.detail = value.detail.slice(0, DETAIL_MAX_LENGTH);
  return record;
}

export function normalizeCriticalHealth(candidate: unknown): CriticalHealthState {
  const value = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
  const status = value.status === "flagged" ? "flagged" : "ok";
  const reason = CRITICAL_FAILURE_REASONS.has(value.reason as CriticalFailureReason)
    ? (value.reason as CriticalFailureReason)
    : undefined;
  const records = Array.isArray(value.records)
    ? value.records
        .map(normalizeRecord)
        .filter((record): record is FailureRecord => record !== undefined)
        .slice(-CRITICAL_HEALTH_RECORD_LIMIT)
    : [];
  const state: CriticalHealthState = {
    ...DEFAULT_CRITICAL_HEALTH,
    status,
    breakerOpen: value.breakerOpen === true,
    records,
  };
  if (status === "flagged" && reason) state.reason = reason;
  const flaggedAt = isoOrUndefined(value.flaggedAt);
  if (status === "flagged" && flaggedAt) state.flaggedAt = flaggedAt;
  const dismissedAt = isoOrUndefined(value.dismissedAt);
  if (dismissedAt) state.dismissedAt = dismissedAt;
  const cooldownUntil = isoOrUndefined(value.cooldownUntil);
  if (cooldownUntil) state.cooldownUntil = cooldownUntil;
  return state;
}
