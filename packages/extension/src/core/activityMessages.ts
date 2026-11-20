import {
  createActivityMessageHandler as createHistoryMessageHandler,
  type ActivityHistoryRepository,
} from "@lurkloot/shared/activityHistory";
import { selectDiagnosticRecords } from "@lurkloot/shared/diagnostics";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import type { CoreRuntimeMessage, RuntimeMessage } from "@lurkloot/shared/messages";

// The extension projects diagnostic rows from its own IndexedDB store.
export function createActivityMessageHandler(
  repository: ActivityHistoryRepository & {
    exportDiagnostics(platform: Platform): Promise<ActivityHistoryRecord[]>;
  },
) {
  const handleHistoryMessage = createHistoryMessageHandler(repository);
  return async (message: RuntimeMessage) => {
    if (message.type === "exportDiagnostics") {
      const events = await repository.exportDiagnostics(message.platform);
      return { events: selectDiagnosticRecords(events, message.platform) };
    }
    return handleHistoryMessage(message);
  };
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
