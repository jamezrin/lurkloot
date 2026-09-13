import type { TwitchExtensionReport } from "@lurkloot/shared/models";

export interface NoPixelSetup { giveaways: boolean; watchtime: boolean; connected: boolean }
export interface NoPixelProgress { earned: number; required: number }
export interface NoPixelGiveaway { entered: boolean }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function parseNoPixelSetup(value: unknown): NoPixelSetup | undefined {
  const data = object(value);
  if (!data || typeof data.is_channel_eligible_for_pack_giveaways !== "boolean"
    || typeof data.is_channel_eligible_for_watchtime_tracking !== "boolean"
    || typeof data.is_channel_connected_for_watchtime_tracking !== "boolean") return;
  return { giveaways: data.is_channel_eligible_for_pack_giveaways, watchtime: data.is_channel_eligible_for_watchtime_tracking, connected: data.is_channel_connected_for_watchtime_tracking };
}
export function parseNoPixelProgress(value: unknown): NoPixelProgress | undefined {
  const data = object(value);
  const earned = data?.watch_time_earned;
  const required = data?.watch_time_required;
  if (typeof earned !== "number" || typeof required !== "number" || !Number.isFinite(earned) || !Number.isFinite(required)
    || earned < 0 || required < 0 || earned > Number.MAX_SAFE_INTEGER || required > Number.MAX_SAFE_INTEGER) return;
  return { earned, required };
}
export function parseNoPixelGiveaway(value: unknown): NoPixelGiveaway | null | undefined {
  if (value === null) return null;
  const data = object(value);
  if (typeof data?.has_user_entered_giveaway !== "boolean") return;
  return { entered: data.has_user_entered_giveaway };
}
export function noPixelReport(setup: NoPixelSetup, progress: NoPixelProgress | undefined, giveaway: NoPixelGiveaway | null): TwitchExtensionReport {
  const pending: TwitchExtensionReport["pending"] = giveaway ? [{ key: "giveaway", state: giveaway.entered ? "done" : "open" }] : [];
  const counters: TwitchExtensionReport["progress"] = progress ? [{ key: "daily-pack", ...progress }] : [];
  if (!setup.watchtime) return { status: "unavailable", reasonCode: "channel-ineligible", progress: counters, pending };
  if (!setup.connected) return { status: "unavailable", reasonCode: "channel-not-connected", progress: counters, pending };
  if (!progress) return { status: "error", reasonCode: "compatibility-error", progress: [], pending };
  return { status: progress.earned >= progress.required ? "complete" : "farming", reasonCode: progress.earned >= progress.required ? "rewards-complete" : "watchtime", progress: counters, pending };
}

// The published pack hook reads an array and opens packs by their id. Only
// bounded path-safe IDs remain private; no card/account payload is retained.
export function parseNoPixelPackIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return;
  const ids: string[] = [];
  for (const row of value) {
    const id = object(row)?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
