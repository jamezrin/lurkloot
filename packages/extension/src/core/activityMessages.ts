import type { FarmingSessionSummary } from "@lurkloot/shared/farmingSessions";
import { isActivityTimelineEvent } from "@lurkloot/shared/farmingSessions";
import type { ActivityHistoryRecord, EngineEvent } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import type {
  ActivityPage,
  ActivitySessionsPage,
  ActivityQuery,
  CoreRuntimeMessage,
  DiagnosticsExport,
  RuntimeMessage,
} from "@lurkloot/shared/messages";

interface ActivityMessageRepository {
  load(query: ActivityQuery): Promise<ActivityPage>;
  loadSessions(platform: Platform): Promise<FarmingSessionSummary[]>;
  exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]>;
  clear(): Promise<void>;
}

interface ActivityEventReporterDeps {
  loadDiagnosticLogging(): Promise<boolean>;
  append(events: readonly EngineEvent[]): Promise<void>;
}

interface RuntimeMessageSender {
  tab?: { id?: number; url?: string };
}

interface RuntimeMessageDispatcherDeps {
  exportCliCredentials(): Promise<unknown>;
  resetExtension(): Promise<unknown>;
  handleActivityMessage(message: RuntimeMessage): Promise<unknown>;
  handleTwitchExtensionMessage?(
    message: Extract<RuntimeMessage, { type: "setTwitchExtensionEnabled" }>,
  ): Promise<unknown>;
  handleCoreMessage(message: CoreRuntimeMessage, sender?: RuntimeMessageSender): Promise<unknown>;
}

export function createActivityMessageHandler(repository: ActivityMessageRepository) {
  return async (
    message: RuntimeMessage,
  ): Promise<ActivityPage | ActivitySessionsPage | DiagnosticsExport | void | undefined> => {
    if (message.type === "getActivity") {
      const { type: _type, ...query } = message;
      return repository.load(query);
    }
    if (message.type === "getActivitySessions") {
      return { sessions: await repository.loadSessions(message.platform) };
    }
    if (message.type === "exportDiagnostics") {
      return { events: await repository.exportDiagnostics(message.platform) };
    }
    if (message.type === "clearActivity") {
      await repository.clear();
    }
    return undefined;
  };
}

export function createActivityEventReporter(deps: ActivityEventReporterDeps) {
  return async (events: readonly EngineEvent[]): Promise<void> => {
    let diagnosticLogging = false;
    try {
      diagnosticLogging = await deps.loadDiagnosticLogging();
    } catch {
      // A settings read must not prevent durable activity history. Treat a
      // missing setting as diagnostics disabled and retain normal activity.
    }
    // Activity that is not part of the user-facing timeline (tab open/close)
    // is kept only through its diagnostic mirror.
    const accepted = events.filter((event) =>
      event.category === "activity" ? isActivityTimelineEvent(event) : diagnosticLogging,
    );
    if (accepted.length > 0) await deps.append(accepted);
  };
}

export function createRuntimeMessageDispatcher(deps: RuntimeMessageDispatcherDeps) {
  return (message: RuntimeMessage, sender?: RuntimeMessageSender): Promise<unknown> => {
    if (message.type === "setTwitchExtensionEnabled")
      return deps.handleTwitchExtensionMessage?.(message) ?? Promise.resolve(undefined);
    if (message.type === "exportCliCredentials") return deps.exportCliCredentials();
    if (message.type === "resetExtension") return deps.resetExtension();
    if (message.type === "getTabId") return Promise.resolve(sender?.tab?.id);
    if (
      message.type === "getActivity"
      || message.type === "getActivitySessions"
      || message.type === "exportDiagnostics"
      || message.type === "clearActivity"
    ) {
      return deps.handleActivityMessage(message);
    }
    return deps.handleCoreMessage(message, sender);
  };
}
