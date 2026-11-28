import {
  buildDiagnosticsExport,
  selectDiagnosticRecords,
  toDiagnosticRecord,
  type DiagnosticRecord,
  type DiagnosticSecrets,
  type DiagnosticsExportInput,
} from "@lurkloot/shared/diagnostics";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { PlatformCredentials } from "../authStore";
import type { Logger } from "../logger";
import { readJsonSidecar, stateSidecarPath, writeJsonAtomically } from "../storage";
import { CLI_VERSION } from "../version";

export const DIAGNOSTICS_LIMIT = 500;
export const DIAGNOSTICS_WRITE_INTERVAL_MS = 5_000;
export function diagnosticCredentialValues(credentials: PlatformCredentials): DiagnosticSecrets {
  const kickToken = credentials.kick?.sessionToken;
  const values = [
    credentials.twitch?.authToken,
    credentials.twitch?.deviceId,
    credentials.twitch?.clientId,
    credentials.twitch?.kasadaSessionCookie,
    kickToken,
  ];
  if (kickToken) {
    try {
      const decoded = decodeURIComponent(kickToken);
      if (decoded !== kickToken) values.push(decoded);
    } catch {
      // Malformed encoding has no wire form. Keep the stored value redacted.
    }
  }
  return values;
}

// Appends update the live ring immediately. Snapshots coalesce within the
// write interval, even if no further batches arrive. Shutdown flushes any
// remaining rows.
export async function createDiagnosticsHistory(
  statePath: string,
  logger: Logger,
  getSecrets?: () => DiagnosticSecrets,
) {
  const { events } = await loadDiagnostics(statePath, getSecrets?.());
  const ring = events.reverse().map((event, index) => ({ ...event, id: String(index + 1) }));
  let sequence = ring.length;
  let dirty = false;
  let writing: Promise<void> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let nextWriteAt = 0;
  let warned = false;
  let closed = false;

  function recent(): DiagnosticRecord[] {
    return Array.from(
      { length: ring.length },
      (_, index) => ring[(sequence - index - 1) % DIAGNOSTICS_LIMIT],
    );
  }

  async function persist(): Promise<void> {
    dirty = false;
    nextWriteAt = performance.now() + DIAGNOSTICS_WRITE_INTERVAL_MS;
    try {
      await writeJsonAtomically(stateSidecarPath(statePath, "diagnostics"), recent(), 0o600, 0);
      warned = false;
    } catch {
      dirty = true;
      if (!warned) logger.warn("Could not save recent diagnostics", "diagnostics");
      warned = true;
    }
  }

  function scheduleWrite(): void {
    if (!dirty || closed || writing || writeTimer) return;
    const delay = nextWriteAt - performance.now();
    if (delay > 0) {
      writeTimer = setTimeout(() => {
        writeTimer = undefined;
        scheduleWrite();
      }, Math.ceil(delay)).unref();
      return;
    }
    writing = persist().finally(() => {
      writing = undefined;
      scheduleWrite();
    });
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
    scheduleWrite();
  }

  async function close(): Promise<void> {
    closed = true;
    clearTimeout(writeTimer);
    await writing;
    if (dirty) {
      writing = persist();
      await writing;
    }
  }

  return { append, recent, close };
}

// The writer replaces the file atomically, so the fd refers to one snapshot
// even if the running process publishes an update while this command reads.
export async function loadDiagnostics(
  statePath: string,
  secrets?: DiagnosticSecrets,
): Promise<{ events: DiagnosticRecord[]; savedAt?: string }> {
  try {
    const { value, savedAt } = await readJsonSidecar(stateSidecarPath(statePath, "diagnostics"));
    if (!Array.isArray(value)) return { events: [] };
    return {
      events: selectDiagnosticRecords(value.slice(0, DIAGNOSTICS_LIMIT), undefined, secrets),
      savedAt,
    };
  } catch {
    // Missing, unreadable or corrupt history still permits a state report.
    return { events: [] };
  }
}

export function exportCliDiagnostics(input: {
  snapshot: RuntimeSnapshot<EngineSettings>;
  events: readonly DiagnosticRecord[];
  platform?: Platform;
  secrets?: DiagnosticSecrets;
  history: NonNullable<DiagnosticsExportInput["history"]>;
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
