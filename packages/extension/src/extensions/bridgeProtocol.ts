import type { TwitchExtensionProviderId, TwitchExtensionReportContracts } from "@lurkloot/core/extensions/types";

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_CHANNEL = "lurkloot.twitch-extension";
export interface BridgeEnvelope {
  channel: typeof BRIDGE_CHANNEL;
  protocol: typeof BRIDGE_PROTOCOL;
  direction: "up" | "down";
  provider: TwitchExtensionProviderId;
  requestId: string;
  kind: string;
  payload: Record<string, unknown>;
}

const credentialKey = /jwt|token|auth|secret|session|epicDeviceId/i;
const jwtValue = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// Inspect BEFORE applying the allowlist: a credential in a discarded field is
// still a driver contract violation. Bounds also prevent hostile page messages
// from monopolizing the relay or overflowing its stack.
function screen(value: unknown, depth = 0, budget = { remaining: 2_000 }): "safe" | "credential" | "invalid" {
  if (--budget.remaining < 0 || depth > 12) return "invalid";
  if (typeof value === "string") return jwtValue.test(value) ? "credential" : value.length <= 16_384 ? "safe" : "invalid";
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return "safe";
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = screen(item, depth + 1, budget);
      if (result !== "safe") return result;
    }
    return "safe";
  }
  if (!record(value)) return "invalid";
  for (const [key, item] of Object.entries(value)) {
    if (credentialKey.test(key)) return "credential";
    const result = screen(item, depth + 1, budget);
    if (result !== "safe") return result;
  }
  return "safe";
}

export function createBridgeValidator(options: {
  origin: string;
  source: unknown;
  provider: TwitchExtensionProviderId;
  contracts: TwitchExtensionReportContracts;
  onViolation: (diagnostic: string) => void;
}) {
  let disabled = false;
  const outstanding = new Map<string, string>();
  return {
    expectResponse(requestId: string, kind: string) {
      if (outstanding.size >= 100 || !requestId || !Object.hasOwn(options.contracts, kind)) throw new Error("Invalid or excessive bridge requests.");
      outstanding.set(requestId, kind);
    },
    cancelResponse(requestId: string) { outstanding.delete(requestId); },
    stop() { disabled = true; outstanding.clear(); },
    receive(event: { source: unknown; origin: string; data: unknown }): BridgeEnvelope | undefined {
      if (disabled || event.source !== options.source || event.origin !== options.origin || !record(event.data)) return;
      const envelope = event.data;
      if (envelope.channel !== BRIDGE_CHANNEL || envelope.protocol !== BRIDGE_PROTOCOL
        || envelope.direction !== "up" || envelope.provider !== options.provider
        || typeof envelope.requestId !== "string" || !envelope.requestId || envelope.requestId.length > 128
        || typeof envelope.kind !== "string" || !Object.hasOwn(options.contracts, envelope.kind)
        || !record(envelope.payload)) return;
      const contract = options.contracts[envelope.kind];
      const expected = outstanding.get(envelope.requestId);
      if (expected ? expected !== envelope.kind : !contract.unsolicited) return;
      const result = screen(envelope);
      if (result === "credential") {
        disabled = true;
        outstanding.clear();
        options.onViolation("Twitch Extension bridge disabled: authorization material in report.");
        return;
      }
      if (result !== "safe") return;
      const payload = Object.fromEntries(Object.entries(envelope.payload).filter(([key]) => contract.keys.includes(key)));
      if (expected) outstanding.delete(envelope.requestId);
      return {
        channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: "up", provider: options.provider,
        requestId: envelope.requestId, kind: envelope.kind, payload,
      };
    },
  };
}
