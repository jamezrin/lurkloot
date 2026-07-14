import type { EngineEvent } from "@lurkloot/shared/events";
import type { ActivityPage, ActivityQuery, RuntimeMessage } from "@lurkloot/shared/messages";

interface ActivityMessageRepository {
  load(query: ActivityQuery): Promise<ActivityPage>;
  clear(): Promise<void>;
}

interface ActivityEventReporterDeps {
  loadDiagnosticLogging(): Promise<boolean>;
  append(events: readonly EngineEvent[]): Promise<void>;
}

export function createActivityMessageHandler(repository: ActivityMessageRepository) {
  return async (message: RuntimeMessage): Promise<ActivityPage | void | undefined> => {
    if (message.type === "getActivity") {
      const { type: _type, ...query } = message;
      return repository.load(query);
    }
    if (message.type === "clearActivity") {
      await repository.clear();
    }
    return undefined;
  };
}

export function createActivityEventReporter(deps: ActivityEventReporterDeps) {
  return async (events: readonly EngineEvent[]): Promise<void> => {
    const diagnosticLogging = await deps.loadDiagnosticLogging();
    await deps.append(events.filter((event) => event.category === "activity" || diagnosticLogging));
  };
}
