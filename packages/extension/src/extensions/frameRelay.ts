import type { TwitchExtensionProviderId, TwitchExtensionReportContracts } from "@lurkloot/core/extensions/types";
import { BRIDGE_CHANNEL, BRIDGE_PROTOCOL, createBridgeValidator, type BridgeEnvelope } from "./bridgeProtocol";

interface FrameMessageEvent { origin: string; source: unknown; data: unknown }
export function startFrameRelay(options: {
  source: unknown;
  origin: string;
  provider: TwitchExtensionProviderId;
  contracts: TwitchExtensionReportContracts;
  addListener(listener: (event: FrameMessageEvent) => void): void;
  removeListener(listener: (event: FrameMessageEvent) => void): void;
  postMessage(envelope: BridgeEnvelope, origin: string): void;
  forward(envelope: BridgeEnvelope): Promise<unknown>;
  diagnostic(message: string): void;
}) {
  let stopped = false;
  let sequence = 0;
  const validator = createBridgeValidator({ ...options, onViolation: (message) => {
    stop();
    options.diagnostic(message);
  } });
  function down(kind: string, requestId: string, payload: Record<string, unknown>) {
    options.postMessage({
      channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: "down", provider: options.provider,
      requestId, kind, payload,
    }, options.origin);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    validator.stop();
    options.removeListener(receive);
    down("stop", `stop-${++sequence}`, {});
  }
  function receive(event: FrameMessageEvent) {
    if (stopped) return;
    const envelope = validator.receive(event);
    if (!envelope) return;
    void options.forward(envelope).catch(() => {
      // Never log a transport exception: it may contain an envelope or a page
      // value. Relay loss terminates the frame until the next page lifecycle.
      stop();
      options.diagnostic("Twitch Extension bridge stopped: background relay unavailable.");
    });
  }
  options.addListener(receive);
  return {
    stop,
    request(kind: string, payload: Record<string, unknown>, responseKind: string): string {
      if (stopped) throw new Error("Twitch Extension bridge is stopped.");
      const requestId = `request-${++sequence}`;
      validator.expectResponse(requestId, responseKind);
      down(kind, requestId, payload);
      return requestId;
    },
    cancelRequest(requestId: string) { validator.cancelResponse(requestId); },
  };
}
