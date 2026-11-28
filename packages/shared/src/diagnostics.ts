import type { DiagnosticEvent } from "./events";
import { farmingSettingsEntries, watchSessionEntries } from "./failureReport";
import { LOG_LEVELS, type LogLevel } from "./logging";
import type { RuntimeSnapshot } from "./messages";
import { PLATFORMS, type EngineSettings, type Platform } from "./models";
import { isRecord } from "./records";

export type DiagnosticRecord = Pick<
  DiagnosticEvent,
  "category" | "level" | "platform" | "message"
> & {
  id: string;
  at: string;
};

export type DiagnosticSecrets = readonly (string | undefined)[];

const SENSITIVE_TEXT =
  /\b(?:authorization|(?:set[-_ ]?)?cookie|kp[_-]uidz[-_]ssn|client[-_ ]integrity)\b|\b(?:(?:bearer|oauth|auth-token)\s+\S+|pass\s+oauth:\s*\S+|(?:[\w-]*(?:token|cookie)|password|secret)["']?\s*[:=])|\bv4\.local\.[\w-]+|\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]*(?:[@?#][^\s"'<>]*)/i;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/;
const REDACTED = "[redacted]";
const MESSAGE_LIMIT = 1024;

function safeText(value: string, secrets: DiagnosticSecrets): string {
  if (
    SENSITIVE_TEXT.test(value)
    || JWT.test(value)
    || secrets.some((secret) => secret && value.includes(secret))
  ) {
    return REDACTED;
  }
  return value.replace(/\s+/g, " ").trim();
}

export function redactDiagnosticText(value: string, secrets: DiagnosticSecrets = []): string {
  return safeText(value, secrets).slice(0, MESSAGE_LIMIT);
}

// Project before sharing or persisting. Diagnostic data and other arbitrary
// metadata are never exported, even if a producer adds fields in the future.
export function toDiagnosticRecord(
  value: unknown,
  secrets: DiagnosticSecrets = [],
): DiagnosticRecord | undefined {
  if (
    !isRecord(value)
    || !(value.category === "diagnostic" || (value.legacy === true && value.category === undefined))
    || !LOG_LEVELS.includes(value.level as LogLevel)
    || !(value.platform === undefined || value.platform === "twitch" || value.platform === "kick")
    || typeof value.id !== "string"
    || typeof value.message !== "string"
    || typeof value.at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.at)
  ) {
    return undefined;
  }
  return {
    id: safeText(value.id, secrets).slice(0, 128),
    at: value.at,
    category: "diagnostic",
    level: value.level as LogLevel,
    ...(value.platform ? { platform: value.platform } : {}),
    message: redactDiagnosticText(value.message, secrets),
  };
}

export function selectDiagnosticRecords(
  newestFirst: readonly unknown[],
  platform?: Platform,
  secrets?: DiagnosticSecrets,
): DiagnosticRecord[] {
  return newestFirst.flatMap((value) => {
    const record = toDiagnosticRecord(value, secrets);
    return record && (!platform || !record.platform || record.platform === platform)
      ? [record]
      : [];
  });
}

export interface DiagnosticsExportInput {
  events: readonly unknown[];
  platform?: Platform;
  version: string;
  environment: { label: "browser" | "runtime"; value: string };
  locale: string;
  at: string;
  coverage?: "full" | "recent";
  history?: { source: "live buffer" } | { source: "saved sidecar"; savedAt?: string };
  snapshot?: RuntimeSnapshot<EngineSettings> | null;
  secrets?: DiagnosticSecrets;
}

export function buildDiagnosticsExport(input: DiagnosticsExportInput): {
  events: DiagnosticRecord[];
  report: string;
} {
  const { snapshot, secrets = [], platform } = input;
  const events = selectDiagnosticRecords(input.events, platform, secrets);
  const field = ([label, value]: readonly [string, unknown]) => {
    const formatted =
      typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
        ? safeText(String(value), secrets)
        : "—";
    return `${label}: ${formatted}`;
  };
  const header = [
    "Lurkloot diagnostics log",
    ...(
      [
        ["version", input.version],
        ["platform", platform ?? "all"],
        ["locale", input.locale],
        ["exported", input.at],
        [input.environment.label, input.environment.value],
        ["events", events.length],
        ...(input.coverage ? [["coverage", input.coverage] as const] : []),
        ...(input.history ? [["diagnostic source", input.history.source] as const] : []),
        ...(input.history?.source === "saved sidecar"
          ? [["sidecar written at", input.history.savedAt] as const]
          : []),
      ] as const
    ).map(field),
  ].join("\n");
  const platforms: readonly Platform[] = platform ? [platform] : PLATFORMS;
  const context = snapshot
    ? platforms.map((id) =>
        [
          `[${id} settings and runtime state]`,
          ...(
            [
              ...farmingSettingsEntries(snapshot.settings, id),
              ["preferKnownChannels", snapshot.settings.preferKnownChannels],
              ["pollIntervalMinutes", snapshot.settings.pollIntervalMinutes],
              [
                "watchSourcePriority",
                snapshot.settings.platform[id].watchSourcePriority.join(", "),
              ],
              ...watchSessionEntries(snapshot.state, id),
              ["auth checked at", snapshot.state.authHealth[id].checkedAt],
              ["farming started at", snapshot.state.farmingSessions?.[id]?.startedAt],
            ] as const
          ).map(field),
        ].join("\n"),
      )
    : [];

  // Both hosts retain newest first. Read a report in chronological order.
  const body = events.length
    ? [...events]
        .reverse()
        .map((event) => {
          const scope = !platform && event.platform ? ` [${event.platform}]` : "";
          return `${event.at} [${event.level}]${scope} ${event.message}`;
        })
        .join("\n")
    : "(no events)";
  return { events, report: `${[header, ...context, body].join("\n\n")}\n` };
}
