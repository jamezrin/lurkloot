import type { TFunction } from "./types";

export function formatEventTime(at: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function initials(value: string): string {
  const result = value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return result || "SM";
}

export function formatCountdown(value: string, t: TFunction): string {
  const timestamp = Date.parse(value);
  if (!value || Number.isNaN(timestamp)) return t("later");
  const diff = timestamp - Date.now();
  if (diff <= 0) return t("ended");
  return formatSpan(diff);
}

// A campaign boundary relative to now, saying which side of it we are on: "in
// 2d 4h" before it, "3d 1h ago" after. Empty when the time is unknown.
export function formatRelative(value: string, t: TFunction): string {
  const timestamp = Date.parse(value);
  if (!value || Number.isNaN(timestamp)) return "";
  const diff = timestamp - Date.now();
  return diff > 0 ? t("relativeIn", formatSpan(diff)) : t("relativeAgo", formatSpan(-diff));
}

export function formatSpan(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  // A zero second unit says nothing: "12d", not "12d 0h".
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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

// A campaign boundary as a reader wants it: weekday, date and time, in the
// popup's own language rather than the browser's.
export function formatDateTime(value: string, locale: string): string {
  const time = Date.parse(value);
  if (!value || Number.isNaN(time)) return "";
  try {
    // The year only when it is not this one, so a campaign that crosses New
    // Year cannot be read as ending before it starts.
    const date = new Date(time);
    // Catalog codes use an underscore (pt_BR, zh_CN); BCP 47 wants a hyphen.
    return date.toLocaleString(locale.replace(/_/g, "-"), {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(time).toLocaleString();
  }
}
