import type { CoreRuntimeMessage, RuntimeMessage } from "@lurkloot/shared/messages";

// The activity message handler and event reporter are shared with the CLI
// host (@lurkloot/shared/activityHistory); this routes the extension's own
// runtime messages to them and to the controller.
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
