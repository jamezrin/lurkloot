import { open } from "node:fs/promises";
import {
  buildDiagnosticsExport,
  selectDiagnosticRecords,
  toDiagnosticRecord,
  type DiagnosticRecord,
  type DiagnosticSecrets,
} from "@lurkloot/shared/diagnostics";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../authStore";
import type { Logger } from "../logger";
import { writeJsonAtomically } from "../storage";
import { CLI_VERSION } from "../version";

export const DIAGNOSTICS_LIMIT = 500;
// Room for JSON escaping, indentation and metadata at the record limit.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function diagnosticsPath(statePath: string): string {
  return `${statePath}.diagnostics.json`;
}

export function diagnosticCredentialValues(credentials: PlatformCredentials): DiagnosticSecrets {
  return [
    credentials.twitch?.authToken,
    credentials.twitch?.deviceId,
    credentials.twitch?.clientId,
    credentials.twitch?.kasadaSessionCookie,
    credentials.kick?.sessionToken,
  ];
}

// Only one write runs at a time. Appends during a write are coalesced into the
// next snapshot of the ring, with no per-batch work queued behind a slow disk.
export function createDiagnosticsHistory(
  statePath: string,
  logger: Logger,
  getSecrets?: () => DiagnosticSecrets,
) {
  const ring: DiagnosticRecord[] = [];
  let sequence = 0;
  let dirty = false;
  let writing: Promise<void> | undefined;
  let warned = false;
  let closed = false;

  function recent(): DiagnosticRecord[] {
    return Array.from(
      { length: ring.length },
      (_, index) => ring[(sequence - index - 1) % DIAGNOSTICS_LIMIT],
    );
  }

  async function persist(): Promise<void> {
    while (dirty) {
      dirty = false;
      try {
        await writeJsonAtomically(diagnosticsPath(statePath), recent(), 0o600);
        warned = false;
      } catch {
        if (!warned) logger.warn("Could not save recent diagnostics", "diagnostics");
        warned = true;
      }
    }
    writing = undefined;
  }

  function append(events: readonly EngineEvent[]): void {
    if (closed) return;
    const secrets = getSecrets?.();
    for (const event of events) {
      if (event.category !== "diagnostic") continue;
      const record = toDiagnosticRecord(
        {
          category: event.category,
          level: event.level,
          platform: event.platform,
          message: event.message,
          id: String(sequence + 1),
          at: event.emittedAt ?? new Date().toISOString(),
        },
        secrets,
      );
      if (!record) continue;
      ring[sequence % DIAGNOSTICS_LIMIT] = record;
      sequence += 1;
      dirty = true;
    }
    if (dirty && !writing) writing = persist();
  }

  function close() {
    closed = true;
    return writing;
  }

  return { append, recent, flush: () => writing, close };
}

// The writer replaces the file atomically, so the fd refers to one snapshot
// even if the running process publishes an update while this command reads.
export async function loadDiagnostics(statePath: string): Promise<DiagnosticRecord[]> {
  try {
    const file = await open(diagnosticsPath(statePath), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
      const raw: unknown = JSON.parse(await file.readFile("utf8"));
      return Array.isArray(raw) ? selectDiagnosticRecords(raw.slice(0, DIAGNOSTICS_LIMIT)) : [];
    } finally {
      await file.close();
    }
  } catch {
    // Missing, unreadable or corrupt history still permits a state report.
    return [];
  }
}

export function exportCliDiagnostics(input: {
  snapshot: RuntimeSnapshot<EngineSettings>;
  events: readonly DiagnosticRecord[];
  platform?: Platform;
  secrets?: DiagnosticSecrets;
}): ReturnType<typeof buildDiagnosticsExport> {
  return buildDiagnosticsExport({
    ...input,
    version: CLI_VERSION,
    environment: {
      label: "runtime",
      value: `Node.js ${process.version} (${process.platform} ${process.arch})`,
    },
    locale: "en",
    at: new Date().toISOString(),
    coverage: "recent",
  });
}
