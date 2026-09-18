import type { TwitchExtensionReport, TwitchExtensionReasonCode, TwitchExtensionStatus } from "@lurkloot/shared/models";

const statuses: readonly TwitchExtensionStatus[] = ["idle", "discovering", "connecting", "farming", "complete", "unavailable", "error"];
const reasons: readonly TwitchExtensionReasonCode[] = ["disabled", "permission-required", "auth-required", "identity-required", "channel-required", "channel-ineligible", "channel-not-connected", "watchtime", "giveaway", "collecting", "phase-closed", "rewards-complete", "transport-error", "compatibility-error", "provider-error", "connecting"];
const progressKeys = ["daily-pack", "phase-captures", "phase-score", "rewards"];
const pendingKeys = ["giveaway", "participation", "completion", "takeover", "account-link"];
const credentialKey = /jwt|token|auth|secret|session|epicDeviceId/i;
const jwtValue = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
// Screen discarded fields too. Node/depth bounds reject cycles and excessive
// payloads before copying the explicit DTO; raw vendor responses are forbidden.
function safe(value: unknown, depth = 0, budget = { remaining: 2_000 }): boolean {
  if (--budget.remaining < 0 || depth > 12) return false;
  if (typeof value === "string") return value.length <= 16_384 && !jwtValue.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => safe(item, depth + 1, budget));
  if (!record(value)) return false;
  return Object.entries(value).every(([key, item]) => !credentialKey.test(key) && safe(item, depth + 1, budget));
}
function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
export function validateTwitchExtensionReport(value: unknown): TwitchExtensionReport | undefined {
  if (!safe(value) || !record(value) || !statuses.includes(value.status as TwitchExtensionStatus)
    || !reasons.includes(value.reasonCode as TwitchExtensionReasonCode)
    || !Array.isArray(value.progress) || value.progress.length > 4
    || !Array.isArray(value.pending) || value.pending.length > 5) return;
  const progress: TwitchExtensionReport["progress"] = [];
  const pending: TwitchExtensionReport["pending"] = [];
  for (const item of value.progress) {
    if (!record(item) || typeof item.key !== "string" || !progressKeys.includes(item.key) || !counter(item.earned) || !counter(item.required)
      || progress.some((previous) => previous.key === item.key)) return;
    progress.push({ key: item.key as typeof progress[number]["key"], earned: item.earned, required: item.required });
  }
  for (const item of value.pending) {
    if (!record(item) || typeof item.key !== "string" || !pendingKeys.includes(item.key) || typeof item.state !== "string" || !["open", "done", "blocked"].includes(item.state)
      || pending.some((previous) => previous.key === item.key)) return;
    pending.push({ key: item.key as typeof pending[number]["key"], state: item.state as typeof pending[number]["state"] });
  }
  return { status: value.status as TwitchExtensionStatus, reasonCode: value.reasonCode as TwitchExtensionReasonCode, progress, pending };
}
