import type { TFunction } from "./types";

export function formatEventTime(at: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function initials(value: string): string {
  const result = value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return result || "SM";
}

export function formatCountdown(value: string, t: TFunction): string {
  const timestamp = Date.parse(value);
  if (!value || Number.isNaN(timestamp)) return t("later");
  const diff = timestamp - Date.now();
  if (diff <= 0) return t("ended");
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

export function formatViewers(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`;
  return String(count);
}
